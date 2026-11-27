import { eq } from "drizzle-orm";
import { type AgentDefinition, listAgents } from "../agents/identity.ts";
import { buildSystemPrompt, type RunMode } from "../agents/prompt.ts";
import { readSettings } from "../config.ts";
import { type Database, errorMessage } from "../db/client.ts";
import { type MessagePart, messages, type RunTrigger, runs, type SubagentTask } from "../db/schema.ts";
import type { EventBus, Scope, TurnEvent } from "../events.ts";
import type { McpHub } from "../mcp/hub.ts";
import type { AgentRow } from "../store/conversations.ts";
import { ClaudeError, type ClaudeTurn, runClaude, SUBAGENT_TOOLS, TurnInput } from "./claude.ts";

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
    // A entrada fica aberta enquanto ele trabalha (inclusive com subagentes em segundo plano). Só a
    // conversa com a pessoa aceita mensagens novas no meio.
    const input = new TurnInput({ injectable: spec.trigger === "chat" });
    if (input.injectable) this.#inputs.set(spec.conversationId, input);
    const recorder = new TurnRecorder({ db, bus: this.#bus, spec, runId: run.id, emit });
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
        input,
      };
      const fresh = () => crypto.randomUUID();
      if (spec.session.id) {
        try {
          await this.#stream({ ...base, sessionId: spec.session.id, resume: true }, recorder, input);
        } catch (error) {
          // A sessão guardada sumiu (alguém apagou o histórico do Claude Code): começa outra.
          if (!(error instanceof ClaudeError && !error.started)) throw error;
          const id = fresh();
          await spec.session.save(id);
          await this.#stream({ ...base, sessionId: id, resume: false }, recorder, input);
        }
      } else {
        const id = fresh();
        await spec.session.save(id);
        await this.#stream({ ...base, sessionId: id, resume: false }, recorder, input);
      }
      // O que ele fez depois da última resposta (o processo terminou sem fechar a fala).
      await recorder.saveResponse();
      await recorder.end();
      const last = recorder.responses.at(-1);
      const durationMs = Date.now() - started;
      await db.update(runs).set({ status: "succeeded", durationMs, finishedAt: new Date() }).where(eq(runs.id, run.id));
      emit({ type: "done", messageId: last?.messageId ?? "", durationMs });
      return { ok: true, text: last?.text ?? "", runId: run.id, ...(last ? { messageId: last.messageId } : {}) };
    } catch (error) {
      const reason = errorMessage(error);
      await db
        .update(runs)
        .set({ status: "failed", error: reason, durationMs: Date.now() - started, finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      await recorder.saveResponse().catch(() => {});
      await recorder.end().catch(() => {});
      emit({ type: "error", message: reason });
      const leftover = input.close();
      return { ok: false, text: recorder.responses.at(-1)?.text ?? "", error: reason, runId: run.id, ...(leftover.length ? { leftover } : {}) };
    } finally {
      input.close();
      if (this.#inputs.get(spec.conversationId) === input) this.#inputs.delete(spec.conversationId);
      if (token) this.#hub?.revoke(token);
      const left = (this.#running.get(slug) ?? 1) - 1;
      if (left > 0) this.#running.set(slug, left);
      else this.#running.delete(slug);
      this.#bus.changed("agents");
    }
  }

  /**
   * Roda o Claude Code até ele sair, passando o que ele faz para o `recorder`. Cada vez que o agente
   * termina de falar, a resposta vira uma mensagem. Ele está parado (sem subagente rodando nem
   * mensagem na fila): a entrada fecha e o processo sai.
   */
  async #stream(turn: ClaudeTurn, recorder: TurnRecorder, input: TurnInput): Promise<void> {
    let idle = false;
    let queued = 0;
    // Um subagente terminou com o agente parado: o Claude Code acorda o agente para continuar. Se não
    // acordar em 2 minutos, acabou.
    let wake: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (!idle) return;
      if (input.pending.length === 0 && queued === 0 && recorder.runningTasks === 0) input.finish();
    };
    try {
      for await (const event of runClaude(turn)) {
        switch (event.type) {
          case "init":
            if (wake) clearTimeout(wake);
            idle = false;
            await recorder.onInit();
            break;
          case "text":
            recorder.onText(event);
            break;
          case "tool":
            recorder.onTool(event);
            break;
          case "tool_result":
            recorder.onToolResult(event);
            break;
          case "task": {
            const before = recorder.runningTasks;
            recorder.onTask(event);
            if (idle && before > 0 && recorder.runningTasks === 0) {
              if (wake) clearTimeout(wake);
              wake = setTimeout(() => input.finish(), FOLLOW_UP_WAIT_MS);
            }
            break;
          }
          case "plan_usage":
            this.#bus.emit({ type: "plan_usage", usage: event.usage });
            break;
          case "compacted":
            recorder.compacted();
            break;
          case "injected":
            idle = false;
            await recorder.onInjected(event.text);
            break;
          case "result":
            if (!event.ok) throw new Error(event.text || "o Claude não terminou a resposta");
            await recorder.saveResponse(event.text, event.context);
            idle = true;
            queued = event.queued ?? 0;
            settle();
            break;
        }
      }
    } finally {
      if (wake) clearTimeout(wake);
    }
  }
}

/** Depois que o último subagente termina com o agente parado, quanto se espera ele voltar a falar. */
const FOLLOW_UP_WAIT_MS = 2 * 60_000;

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * O que o agente faz num processo do Claude Code: as respostas (uma por vez que ele termina de
 * falar), as ferramentas e os subagentes. As ações dos subagentes não entram na resposta: contam no
 * subagente, que segue atualizado no banco mesmo depois que a resposta dele foi guardada.
 */
class TurnRecorder {
  /** A resposta em andamento. */
  parts: MessagePart[] = [];
  /** As respostas guardadas, na ordem. */
  readonly responses: { messageId: string; text: string }[] = [];
  readonly #db: Database;
  readonly #bus: EventBus;
  readonly #spec: TurnSpec;
  readonly #runId: string;
  readonly #emit: (event: TurnEvent) => void;
  /** As ferramentas da resposta em andamento, pelo id. */
  readonly #tools = new Map<string, ToolPart>();
  /** Os subagentes, pelo id da ferramenta Agent que os lançou. */
  readonly #tasks = new Map<string, { part: ToolPart; messageId?: string }>();
  /** Subagentes lançados por subagentes: contam no de cima. */
  readonly #nested = new Map<string, string>();
  /** As partes de cada resposta guardada, para atualizar os subagentes dela. */
  readonly #saved = new Map<string, MessagePart[]>();
  readonly #dirty = new Set<string>();
  #flushing: ReturnType<typeof setTimeout> | undefined;
  #compacted = false;
  #sawInit = false;

  constructor(options: { db: Database; bus: EventBus; spec: TurnSpec; runId: string; emit: (event: TurnEvent) => void }) {
    this.#db = options.db;
    this.#bus = options.bus;
    this.#spec = options.spec;
    this.#runId = options.runId;
    this.#emit = options.emit;
  }

  /** Quantos subagentes ainda trabalham. */
  get runningTasks(): number {
    let count = 0;
    for (const { part } of this.#tasks.values()) if (part.task?.status === "running") count++;
    return count;
  }

  /** Um turno novo dele começou (o Claude Code o acordou): o que sobrou da fala anterior é uma resposta. */
  async onInit(): Promise<void> {
    if (this.#sawInit) await this.saveResponse();
    this.#sawInit = true;
  }

  onText(event: { text: string; parent?: string }): void {
    if (event.parent) {
      // A fala de um subagente não é a resposta do agente.
      const top = this.#top(event.parent);
      if (top) this.#update(top, (task) => ({ ...task, last: firstLine(event.text) }));
      return;
    }
    this.parts.push({ type: "text", text: event.text });
    this.#emit({ type: "text", text: event.text });
  }

  onTool(event: { id: string; name: string; detail: string; parent?: string; background?: boolean }): void {
    if (event.parent) {
      const top = this.#top(event.parent);
      if (!top) return;
      if (SUBAGENT_TOOLS.has(event.name)) this.#nested.set(event.id, top);
      this.#update(top, (task) => ({ ...task, actions: task.actions + 1, last: event.detail ? `${event.name} ${event.detail}` : event.name }));
      return;
    }
    const part: ToolPart = { type: "tool", id: event.id, name: event.name, detail: event.detail };
    if (SUBAGENT_TOOLS.has(event.name)) {
      part.task = { status: "running", actions: 0, ...(event.background ? { background: true } : {}) };
      this.#tasks.set(event.id, { part });
    }
    this.#tools.set(event.id, part);
    this.parts.push(part);
    this.#emit({ type: "tool", id: event.id, name: part.name, detail: part.detail, ...(part.task ? { task: { ...part.task } } : {}) });
  }

  onToolResult(event: { id: string; error?: string; parent?: string }): void {
    if (event.parent) return;
    const part = this.#tools.get(event.id);
    if (part && event.error) {
      part.error = event.error;
      this.#emit({ type: "tool_error", name: part.name, error: event.error });
    }
    // Um subagente que não é de segundo plano termina quando a ferramenta devolve.
    const task = this.#tasks.get(event.id)?.part.task;
    if (!task || task.status !== "running") return;
    if (event.error) this.#update(event.id, (current) => ({ ...current, status: "failed" }));
    else if (!task.background) this.#update(event.id, (current) => ({ ...current, status: "completed" }));
  }

  onTask(event: { phase: "started" | "progress" | "done"; toolUseId: string; description?: string; status?: string; summary?: string }): void {
    // Só os subagentes do agente; as tarefas de dentro deles (e os comandos longos) não contam.
    if (!this.#tasks.has(event.toolUseId)) return;
    if (event.phase === "started") return this.#update(event.toolUseId, (task) => ({ ...task, status: "running", background: true }));
    if (event.phase === "progress") return this.#update(event.toolUseId, (task) => (event.description ? { ...task, last: event.description } : task));
    const status = event.status === "completed" ? "completed" : event.status === "failed" ? "failed" : "stopped";
    this.#update(event.toolUseId, (task) => ({ ...task, status, ...(event.summary ? { summary: event.summary } : {}) }));
  }

  compacted(): void {
    this.#compacted = true;
  }

  /** Ele leu uma mensagem mandada no meio: o que fez até aqui vira uma resposta, e a mensagem entra depois. */
  async onInjected(text: string): Promise<void> {
    await this.saveResponse();
    await this.#db.insert(messages).values({ conversationId: this.#spec.conversationId, author: "person", text });
    this.#bus.changed("messages", this.#spec.scope);
    this.#emit({ type: "flush" });
  }

  /** Guarda a resposta em andamento (uma fala vazia, como a de um aviso interno, não vira mensagem). */
  async saveResponse(resultText?: string, context?: { used: number; window: number }): Promise<void> {
    const text = resultText?.trim() ? resultText : lastText(this.parts);
    if (this.parts.length === 0 && !text) return;
    const spec = this.#spec;
    if (this.#compacted) {
      this.#compacted = false;
      await this.#db.insert(messages).values({
        conversationId: spec.conversationId,
        author: "system",
        text: `${spec.agent.slug} compactou o contexto da conversa para continuar (o histórico na tela continua; ele guarda um resumo).`,
        meta: { notice: "compacted" },
      });
    }
    const parts = this.parts;
    this.parts = [];
    this.#tools.clear();
    const [message] = await this.#db
      .insert(messages)
      .values({
        conversationId: spec.conversationId,
        runId: this.#runId,
        author: "agent",
        agentId: spec.agentRow.id,
        text,
        parts,
        meta: { ...(spec.routineId ? { routineId: spec.routineId } : {}), ...(context ? { context } : {}) },
      })
      .returning({ id: messages.id });
    if (!message) return;
    this.#saved.set(message.id, parts);
    for (const entry of this.#tasks.values()) if (parts.includes(entry.part)) entry.messageId = message.id;
    this.responses.push({ messageId: message.id, text });
    this.#bus.changed("messages", spec.scope);
    this.#emit({ type: "flush" });
  }

  /** O processo acabou: subagente que ainda "rodava" parou junto. Grava o que falta. */
  async end(): Promise<void> {
    for (const [id, entry] of this.#tasks) {
      if (entry.part.task?.status === "running") this.#update(id, (task) => ({ ...task, status: "stopped" }));
    }
    await this.#flush();
  }

  /** O subagente de cima de um id (o próprio, ou o que lançou um subagente de dentro). */
  #top(id: string): string | undefined {
    if (this.#tasks.has(id)) return id;
    return this.#nested.get(id);
  }

  #update(id: string, change: (task: SubagentTask) => SubagentTask): void {
    const entry = this.#tasks.get(id);
    if (!entry?.part.task) return;
    entry.part.task = change(entry.part.task);
    if (entry.messageId) {
      // Já guardado: atualiza a mensagem no banco, juntando as mudanças de meio segundo.
      this.#dirty.add(entry.messageId);
      this.#flushing ??= setTimeout(() => void this.#flush(), 500);
    } else {
      this.#emit({ type: "task", id, task: { ...entry.part.task } });
    }
  }

  async #flush(): Promise<void> {
    if (this.#flushing) clearTimeout(this.#flushing);
    this.#flushing = undefined;
    const ids = [...this.#dirty];
    this.#dirty.clear();
    for (const id of ids) {
      const parts = this.#saved.get(id);
      if (parts) await this.#db.update(messages).set({ parts }).where(eq(messages.id, id));
    }
    if (ids.length > 0) this.#bus.changed("messages", this.#spec.scope);
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

export function lastText(parts: MessagePart[]): string {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.type === "text") return part.text;
  }
  return "";
}
