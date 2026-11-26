import { EventEmitter } from "node:events";
import type { PlanUsage } from "./runner/claude.ts";

/*
 * Tudo o que acontece no motor passa por aqui, e a interface de terminal escuta por `/events`.
 * Um evento diz o que mudou; quem escuta busca de novo o que precisa.
 */

/** Onde algo aconteceu: na conversa com um agente, ou num grupo. */
export type Scope = { kind: "agent"; slug: string } | { kind: "group"; slug: string };

/** O que um agente está fazendo num turno, enquanto faz. */
export type TurnEvent =
  | { type: "start"; agent: string; runId: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "tool_error"; name: string; error: string }
  | { type: "done"; messageId: string; durationMs: number }
  | { type: "error"; message: string };

export type ChangeKind = "agents" | "groups" | "routines" | "attention" | "messages" | "settings";

export type NeotermEvent =
  | { type: "turn"; scope: Scope; agent: string; event: TurnEvent }
  | { type: "changed"; what: ChangeKind; scope?: Scope }
  | { type: "plan_usage"; usage: PlanUsage };

export class EventBus {
  readonly #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(200);
  }

  emit(event: NeotermEvent): void {
    this.#emitter.emit("event", event);
  }

  changed(what: ChangeKind, scope?: Scope): void {
    this.emit(scope ? { type: "changed", what, scope } : { type: "changed", what });
  }

  subscribe(listener: (event: NeotermEvent) => void): () => void {
    this.#emitter.on("event", listener);
    return () => this.#emitter.off("event", listener);
  }
}
