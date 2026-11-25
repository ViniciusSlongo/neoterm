import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { type AgentDefinition, loadAgent } from "../agents/identity.ts";
import { buildSystemPrompt, type RunMode } from "../agents/prompt.ts";
import { readSettings } from "../config.ts";
import { type Database, errorMessage } from "../db/client.ts";
import { conversations, type MessagePart, messages, type RunTrigger, runs } from "../db/schema.ts";
import { ensureAgentRow, mainConversation } from "../store/conversations.ts";
import { ClaudeError, type ClaudeTurn, type PlanUsage, runClaude } from "./claude.ts";

/*
 * Um turno: a mensagem entra na conversa do agente, o Claude Code roda com a identidade e o
 * escopo dele, e o que ele fez e disse volta para a conversa.
 *
 * UM TURNO POR AGENTE DE CADA VEZ. Duas execuções na mesma sessão do Claude Code se atropelam,
 * então um turno que chega com o agente ocupado espera na fila dele. Agentes diferentes rodam
 * ao mesmo tempo.
 */

export type TurnEvent =
  | { type: "start"; agent: string; runId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "tool_error"; name: string; error: string }
  | { type: "done"; messageId: string; durationMs: number }
  | { type: "error"; message: string };

export type TurnRequest = {
  slug: string;
  text: string;
  trigger: RunTrigger;
  onEvent?: (event: TurnEvent) => void;
};

/** O escopo do agente nesta execução: com você por perto, ou sozinho. */
export function scopeOf(agent: AgentDefinition, mode: RunMode) {
  return {
    tools: mode === "interactive" ? agent.tools : agent.unattended,
    addDirs: agent.folders.map((folder) => folder.path),
    // `//` é caminho absoluto nas regras do Claude Code; Edit vale para toda ferramenta que edita.
    disallowed: agent.folders
      .filter((folder) => !folder.write)
      .map((folder) => `Edit(/${folder.path}/**)`),
  };
}

export class Turns {
  readonly #db: Database;
  readonly #queues = new Map<string, Promise<void>>();
  #planUsage: PlanUsage | undefined;

  constructor(db: Database) {
    this.#db = db;
  }

  /** O uso do plano informado pelo último turno, se algum já rodou. */
  get planUsage(): PlanUsage | undefined {
    return this.#planUsage;
  }

  /** Quantos agentes estão rodando ou com turno na fila. */
  get busy(): string[] {
    return [...this.#queues.keys()];
  }

  run(request: TurnRequest): Promise<void> {
    return this.#serialize(request.slug, () => this.#run(request));
  }

  #serialize(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(work);
    const settled = next.catch(() => {});
    this.#queues.set(key, settled);
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    });
    return next;
  }

  async #run({ slug, text, trigger, onEvent = () => {} }: TurnRequest): Promise<void> {
    const db = this.#db;
    const agent = await loadAgent(slug);
    const settings = await readSettings();
    const row = await ensureAgentRow(db, slug);
    const conversation = await mainConversation(db, row.id);
    await db.insert(messages).values({ conversationId: conversation.id, author: "person", text });
    const [run] = await db
      .insert(runs)
      .values({ agentId: row.id, conversationId: conversation.id, trigger, status: "running" })
      .returning({ id: runs.id });
    if (!run) throw new Error("não consegui registrar a execução");
    onEvent({ type: "start", agent: slug, runId: run.id });

    const started = Date.now();
    const mode: RunMode = trigger === "chat" ? "interactive" : "unattended";
    const base: Omit<ClaudeTurn, "sessionId" | "resume"> = {
      prompt: text,
      cwd: agent.workspace,
      model: agent.model ?? settings.defaultModel,
      systemPrompt: await buildSystemPrompt(agent, { mode, now: new Date(), timeZone: settings.timezone }),
      ...scopeOf(agent, mode),
    };

    const parts: MessagePart[] = [];
    try {
      let session = conversation.claudeSessionId
        ? { id: conversation.claudeSessionId, resume: true }
        : { id: randomUUID(), resume: false };
      let resultText: string;
      try {
        resultText = await this.#stream({ ...base, sessionId: session.id, resume: session.resume }, parts, onEvent);
      } catch (error) {
        // A sessão guardada sumiu (apagaram o histórico do Claude Code): começa uma nova.
        if (!(session.resume && error instanceof ClaudeError && !error.started)) throw error;
        session = { id: randomUUID(), resume: false };
        resultText = await this.#stream({ ...base, sessionId: session.id, resume: false }, parts, onEvent);
      }
      if (!session.resume) {
        await db.update(conversations).set({ claudeSessionId: session.id }).where(eq(conversations.id, conversation.id));
      }
      const finalText = resultText || lastText(parts);
      const durationMs = Date.now() - started;
      const [message] = await db
        .insert(messages)
        .values({ conversationId: conversation.id, runId: run.id, author: "agent", agentId: row.id, text: finalText, parts })
        .returning({ id: messages.id });
      await db.update(runs).set({ status: "succeeded", durationMs, finishedAt: new Date() }).where(eq(runs.id, run.id));
      onEvent({ type: "done", messageId: message?.id ?? "", durationMs });
    } catch (error) {
      const reason = errorMessage(error);
      await db
        .update(runs)
        .set({ status: "failed", error: reason, durationMs: Date.now() - started, finishedAt: new Date() })
        .where(eq(runs.id, run.id));
      if (parts.length > 0) {
        await db.insert(messages).values({
          conversationId: conversation.id,
          runId: run.id,
          author: "agent",
          agentId: row.id,
          text: lastText(parts),
          parts,
        });
      }
      onEvent({ type: "error", message: reason });
    }
  }

  /** Roda o Claude Code e junta o que ele fez em `parts`. Devolve o texto final. */
  async #stream(turn: ClaudeTurn, parts: MessagePart[], onEvent: (event: TurnEvent) => void): Promise<string> {
    const toolIndex = new Map<string, number>();
    for await (const event of runClaude(turn)) {
      switch (event.type) {
        case "text":
          parts.push({ type: "text", text: event.text });
          onEvent(event);
          break;
        case "tool":
          toolIndex.set(event.id, parts.length);
          parts.push({ type: "tool", name: event.name, detail: event.detail });
          onEvent({ type: "tool", name: event.name, detail: event.detail });
          break;
        case "tool_result": {
          const part = parts[toolIndex.get(event.id) ?? -1];
          if (event.error && part?.type === "tool") {
            part.error = event.error;
            onEvent({ type: "tool_error", name: part.name, error: event.error });
          }
          break;
        }
        case "plan_usage":
          this.#planUsage = event.usage;
          break;
        case "result":
          if (!event.ok) throw new Error(event.text || "o Claude não terminou a resposta");
          return event.text;
      }
    }
    return lastText(parts);
  }
}

function lastText(parts: MessagePart[]): string {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (part?.type === "text") return part.text;
  }
  return "";
}
