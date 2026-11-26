import { and, eq, isNull, max } from "drizzle-orm";
import { raiseAttention } from "./attention.ts";
import type { Core } from "./core.ts";
import { agents, attention, runs } from "./db/schema.ts";
import { duration } from "./tui/format.ts";
import { type AgentProcess, leftRunning, processesByAgent } from "./processes.ts";

/*
 * O aviso de serviços esquecidos: um agente parado há um tempo (30 minutos, por padrão) com
 * serviços que ele deixou rodando vira um item em "precisa de você". O neoterm não encerra nada
 * sozinho: um agente com rotinas pode ter deixado um serviço de propósito. Quem decide é a pessoa.
 *
 * Avisa uma vez por conjunto de serviços; um serviço novo avisa de novo. Quando não sobra nenhum,
 * o aviso some sozinho.
 */

export const IDLE_WARNING_MS = 30 * 60_000;
const CHECK_INTERVAL_MS = 5 * 60_000;

const describe = (entry: AgentProcess) => {
  const program = entry.command.split(/\s+/).slice(0, 3).join(" ");
  return `${program.length > 40 ? `${program.slice(0, 39)}…` : program}${entry.ports.length ? ` :${entry.ports.join(",")}` : ""}`;
};

export class IdleWatch {
  readonly #core: Core;
  readonly #idleMs: number;
  /** O que já foi avisado, por agente: os pids. */
  readonly #warned = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(core: Core, options: { idleMs?: number } = {}) {
    this.#core = core;
    this.#idleMs = options.idleMs ?? IDLE_WARNING_MS;
  }

  start(): void {
    this.#timer = setInterval(() => void this.check().catch(() => {}), CHECK_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async check(): Promise<void> {
    const { db, bus, engine } = this.#core;
    const now = this.#core.now().getTime();
    const byAgent = await processesByAgent();
    const rows = await db
      .select({ id: agents.id, slug: agents.slug, lastAt: max(runs.finishedAt) })
      .from(agents)
      .leftJoin(runs, eq(runs.agentId, agents.id))
      .where(isNull(agents.deletedAt))
      .groupBy(agents.id);
    for (const row of rows) {
      const left = leftRunning(byAgent.get(row.slug) ?? []);
      if (left.length === 0) {
        this.#warned.delete(row.slug);
        const resolved = await db
          .update(attention)
          .set({ resolvedAt: new Date(now) })
          .where(and(eq(attention.agentId, row.id), eq(attention.kind, "idle_services"), isNull(attention.resolvedAt)))
          .returning({ id: attention.id });
        if (resolved.length) bus.changed("attention");
        continue;
      }
      if (engine.running.includes(row.slug)) continue;
      const idleFor = row.lastAt ? now - new Date(row.lastAt).getTime() : Number.POSITIVE_INFINITY;
      if (idleFor < this.#idleMs) continue;
      const signature = left.map((entry) => entry.pid).sort((a, b) => a - b).join(",");
      if (this.#warned.get(row.slug) === signature) continue;
      this.#warned.set(row.slug, signature);
      const memory = left.reduce((sum, entry) => sum + entry.rssBytes, 0);
      const parado = Number.isFinite(idleFor) ? `parado há ${duration(idleFor)}` : "parado";
      await raiseAttention(db, bus, {
        kind: "idle_services",
        agentId: row.id,
        text: `${row.slug} está ${parado} com ${left.length} ${left.length === 1 ? "serviço rodando" : "serviços rodando"} (${Math.round(memory / 1048576)} MB): ${left.map(describe).join("; ")}`,
      });
    }
  }
}
