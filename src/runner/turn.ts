import { eq } from "drizzle-orm";
import { type AgentDefinition, listAgents } from "../agents/identity.ts";
import { buildSystemPrompt, type RunMode } from "../agents/prompt.ts";
import { readSettings } from "../config.ts";
import { type Database, errorMessage } from "../db/client.ts";
import { type MessagePart, messages, type RunTrigger, runs } from "../db/schema.ts";
import type { EventBus, Scope, TurnEvent } from "../events.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { AgentRow } from "../store/conversations.ts";
import { ClaudeError, type ClaudeTurn, runClaude, TurnInput } from "./claude.ts";

export type { TurnEvent } from "../events.ts";

/*
 * Um turno: o Claude Code roda com a identidade e as pastas do agente, e o que ele fez e disse
 * entra na conversa. Serve à conversa com a pessoa, às rotinas, aos retornos e aos grupos; quem
 * chama decide a conversa, o modo e a mensagem de entrada.
 */

/**
 * As pastas do agente que entram com `--add-dir`: ele roda na primeira (num grupo, na pasta do
 * projeto), e as outras vêm junto.
 */
export function extraDirs(agent: AgentDefinition, cwd = agent.workspace): string[] {
  return agent.folders.filter((folder) => folder !== cwd);
}

/** Os outros agentes, que este pode consultar com ask_agent. */
async function colleaguesOf(slug: string): Promise<{ slug: string; title: string }[]> {
  try {
    return (await listAgents()).agents.filter((agent) => agent.slug !== slug).map((agent) => ({ slug: agent.slug, title: agent.title }));
  } catch {
    return [];
  }
}

/** Onde fica a sessão do Claude Code desta conversa: na conversa, ou no membro do grupo. */
export type SessionSlot = { id: string | null; save(id: string): Promise<void> };

export type TurnSpec = {
  agent: AgentDefinition;
  agentRow: AgentRow;
  conversationId: string;
  groupId?: string;
  scope: Scope;
  trigger: RunTrigger;
  mode: RunMode;
  readOnly?: boolean;
  routineId?: string;
  /** 1 quando responde a uma consulta de outro agente (sem consultar outros, sem cadeia). */
  depth?: number;
  prompt: string;
  cwd: string;
  extraSystem?: string;
  session: SessionSlot;
  onEvent?: (event: TurnEvent) => void;
};

export type TurnOutcome = {
  ok: boolean;
  text: string;
  error?: string;
  runId: string;
  messageId?: string;
  /** Mandadas durante o turno e não lidas (o turno caiu antes): quem chama manda de novo. */
  leftover?: string[];
};

/**
 * Filas por chave. Um turno pega todas as chaves que pede, em ordem: o agente nunca roda dois
 * turnos na mesma hora, e um grupo fala um de cada vez.
 */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #depth = new Map<string, number>();

  run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = keys;
    if (first === undefined) return work();
    return this.#one(first, () => this.run(rest, work));
  }

  /** Quantos trabalhos esperam ou rodam nesta chave. */
  depth(key: string): number {
    return this.#depth.get(key) ?? 0;
  }

  #one<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.#depth.set(key, this.depth(key) + 1);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(work);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      const left = this.depth(key) - 1;
      if (left > 0) this.#depth.set(key, left);
      else this.#depth.delete(key);
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}

export class TurnEngine {
  readonly queue = new KeyedQueue();
  readonly #db: Database;
  readonly #bus: EventBus;
  readonly #hub: McpHub | undefined;
  readonly #mcpUrl: () => string | undefined;
  readonly #running = new Map<string, number>();
  /** A entrada dos turnos de conversa em andamento, por conversa. */
  readonly #inputs = new Map<string, TurnInput>();

  constructor(deps: { db: Database; bus: EventBus; hub?: McpHub; mcpUrl?: () => string | undefined }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
    this.#hub = deps.hub;
    this.#mcpUrl = deps.mcpUrl ?? (() => undefined);
  }

  /**
   * Manda uma mensagem para o turno de conversa em andamento nesta conversa. `false` se não há um
   * (aí ela espera o próximo turno, como sempre).
   */
  inject(conversationId: string, text: string): boolean {
    return this.#inputs.get(conversationId)?.send(text) ?? false;
  }

  /** Os agentes rodando agora. */
  get running(): string[] {
    return [...this.#running.keys()];
  }

  /** Roda um turno. Quem chama segura a fila (`queue.run`) e já gravou a mensagem de entrada. */
  async execute(spec: TurnSpec): Promise<TurnOutcome> {
    const db = this.#db;
    const slug = spec.agent.slug;
    const emit = (event: TurnEvent) => {
      spec.onEvent?.(event);
      this.#bus.emit({ type: "turn", scope: spec.scope, agent: slug, event });
    };
    const [run] = await db
      .insert(runs)
      .values({
        agentId: spec.agentRow.id,
        conversationId: spec.conversationId,
        trigger: spec.trigger,
        status: "running",
        ...(spec.routineId ? { routineId: spec.routineId } : {}),
      })
      .returning({ id: runs.id });
    if (!run) throw new Error("não consegui registrar a execução");

    this.#running.set(slug, (this.#running.get(slug) ?? 0) + 1);
    this.#bus.changed("agents");
    emit({ type: "start", agent: slug, runId: run.id });

    const settings = await readSettings();
    const mcpUrl = this.#mcpUrl();
    const token =
      this.#hub && mcpUrl
        ? this.#hub.issue({
            runId: run.id,
            agentId: spec.agentRow.id,
            slug,
            conversationId: spec.conversationId,
            ...(spec.groupId ? { groupId: spec.groupId } : {}),
            mode: spec.mode,
            timeZone: settings.timezone,
            ...(spec.depth ? { depth: spec.depth } : {}),
          })
        : undefined;
    const started = Date.now();
    const parts: MessagePart[] = [];
    // Só a conversa com a pessoa aceita mensagens no meio do turno.
    const input = spec.trigger === "chat" ? new TurnInput() : undefined;
    if (input) this.#inputs.set(spec.conversationId, input);
    // Ele leu uma mensagem nova: o que fez até aqui vira uma resposta, a mensagem entra depois dela,
    // e o resto do turno segue numa resposta nova.
    const onInjected = async (text: string) => {
      if (parts.length > 0) {
        await db.insert(messages).values({ conversationId: spec.conversationId, runId: run.id, author: "agent", agentId: spec.agentRow.id, text: lastText(parts), parts: parts.splice(0) });
      }
      await db.insert(messages).values({ conversationId: spec.conversationId, author: "person", text });
      this.#bus.changed("messages", spec.scope);
      emit({ type: "flush" });
    };
    try {
      const base: Omit<ClaudeTurn, "sessionId" | "resume"> = {
        prompt: spec.prompt,
        agent: slug,
        cwd: spec.cwd,
        model: spec.agent.model ?? settings.defaultModel,
        ...(spec.agent.effort ? { effort: spec.agent.effort } : {}),
        systemPrompt: await buildSystemPrompt(spec.agent, {
          mode: spec.mode,
          now: new Date(),
          timeZone: settings.timezone,
          neotermTools: Boolean(token),
          ...(token && !spec.depth ? { colleagues: await colleaguesOf(slug) } : {}),
          ...(spec.readOnly ? { readOnly: true } : {}),
          ...(spec.extraSystem ? { extra: spec.extraSystem } : {}),
        }),
        addDirs: extraDirs(spec.agent, spec.cwd),
        ...(token && mcpUrl ? { mcp: { url: mcpUrl, token } } : {}),
        ...(input ? { input } : {}),
      };
      let resultText: string;
      const outcome: StreamOutcome = {};
      const fresh = () => crypto.randomUUID();
      if (spec.session.id) {
        try {
          resultText = await this.#stream({ ...base, sessionId: spec.session.id, resume: true }, parts, emit, outcome, onInjected);
        } catch (error) {
          // A sessão guardada sumiu (alguém apagou o histórico do Claude Code): começa outra.
          if (!(error instanceof ClaudeError && !error.started)) throw error;
          const id = fresh();
          await spec.session.save(id);
          resultText = await this.#stream({ ...base, sessionId: id, resume: false }, parts, emit, outcome, onInjected);
        }
      } else {
        const id = fresh();
        await spec.session.save(id);
        resultText = await this.#stream({ ...base, sessionId: id, resume: false }, parts, emit, outcome, onInjected);
      }
      // O Claude Code compactou a sessão: fica dito na conversa, antes da resposta.
      if (outcome.compacted) {
        await db.insert(messages).values({
          conversationId: spec.conversationId,
          author: "system",
          text: `${slug} compactou o contexto da conversa para continuar (o histórico na tela continua; ele guarda um resumo).`,
          meta: { notice: "compacted" },
        });
      }
      const text = resultText || lastText(parts);
      const durationMs = Date.now() - started;
      const [message] = await db
        .insert(messages)
        .values({
          conversationId: spec.conversationId,
          runId: run.id,
          author: "agent",
          agentId: spec.agentRow.id,
          text,
          parts,
          meta: { ...(spec.routineId ? { routineId: spec.routineId } : {}), ...(outcome.context ? { context: outcome.context } : {}) },
        })
        .returning({ id: messages.id });
      await db.update(runs).set({ status: "succeeded", durationMs, finishedAt: new Date() }).where(eq(runs.id, run.id));
      this.#bus.changed("messages", spec.scope);
      emit({ type: "done", messageId: message?.id ?? "", durationMs });
      return { ok: true, text, runId: run.id, ...(message ? { messageId: message.id } : {}) };
    } catch (error) {
      const reason = errorMessage(error);
      await db
        .update(runs)
        .set({ status: "failed", error: reason, durationMs: Date.now() - started, finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      if (parts.length > 0) {
        await db.insert(messages).values({
          conversationId: spec.conversationId,
          runId: run.id,
          author: "agent",
          agentId: spec.agentRow.id,
          text: lastText(parts),
          parts,
        });
        this.#bus.changed("messages", spec.scope);
      }
      emit({ type: "error", message: reason });
      const leftover = input?.close() ?? [];
      return { ok: false, text: lastText(parts), error: reason, runId: run.id, ...(leftover.length ? { leftover } : {}) };
    } finally {
      input?.close();
      if (input && this.#inputs.get(spec.conversationId) === input) this.#inputs.delete(spec.conversationId);
      if (token) this.#hub?.revoke(token);
      const left = (this.#running.get(slug) ?? 1) - 1;
      if (left > 0) this.#running.set(slug, left);
      else this.#running.delete(slug);
      this.#bus.changed("agents");
    }
  }

  /** Roda o Claude Code e junta o que ele fez em `parts`. Devolve o texto final. */
  async #stream(
    turn: ClaudeTurn,
    parts: MessagePart[],
    emit: (event: TurnEvent) => void,
    outcome: StreamOutcome,
    onInjected: (text: string) => Promise<void>,
  ): Promise<string> {
    const toolIndex = new Map<string, number>();
    for await (const event of runClaude(turn)) {
      switch (event.type) {
        case "text":
          parts.push({ type: "text", text: event.text });
          emit(event);
          break;
        case "tool":
          toolIndex.set(event.id, parts.length);
          parts.push({ type: "tool", name: event.name, detail: event.detail });
          emit({ type: "tool", name: event.name, detail: event.detail });
          break;
        case "tool_result": {
          const part = parts[toolIndex.get(event.id) ?? -1];
          if (event.error && part?.type === "tool") {
            part.error = event.error;
            emit({ type: "tool_error", name: part.name, error: event.error });
          }
          break;
        }
        case "plan_usage":
          this.#bus.emit({ type: "plan_usage", usage: event.usage });
          break;
        case "compacted":
          outcome.compacted = true;
          break;
        case "injected":
          await onInjected(event.text);
          toolIndex.clear();
          break;
        case "result":
          if (!event.ok) throw new Error(event.text || "o Claude não terminou a resposta");
          if (event.context) outcome.context = event.context;
          return event.text;
      }
    }
    return lastText(parts);
  }
}

/** O que o turno soube além do texto: o contexto ao terminar e se compactou no caminho. */
type StreamOutcome = { context?: { used: number; window: number }; compacted?: boolean };

export function lastText(parts: MessagePart[]): string {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.type === "text") return part.text;
  }
  return "";
}
