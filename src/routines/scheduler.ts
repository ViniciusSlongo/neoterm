import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Core } from "../core.ts";
import { errorMessage } from "../db/client.ts";
import { followups, messages, routines, runs } from "../db/schema.ts";
import type { RoutineRunner } from "./runner.ts";
import { nextOccurrence } from "./schedule.ts";

/*
 * O relógio das rotinas: a cada 30 segundos, o que venceu é disparado.
 *
 * HORÁRIOS PERDIDOS SÃO PULADOS, NÃO REPETIDOS (do OpenBot). O próximo horário de uma rotina é uma
 * marca, não uma fila. Se o motor ficou desligado, a rotina não deve todas as vezes que perdeu:
 * uma que atrasou até 10 minutos ainda dispara; mais que isso, a marca anda para a próxima vez sem
 * disparar. Ninguém quer trinta resumos velhos de trinta manhãs diferentes.
 *
 * A MARCA ANDA ANTES DE DISPARAR. Se o motor cair no meio, perde-se no máximo aquela execução, e
 * nunca se dispara duas vezes a mesma.
 */

export const SWEEP_INTERVAL_MS = 30_000;
export const ROUTINE_GRACE_MS = 10 * 60_000;
/** Um retorno vale por mais tempo: "confiro o build depois" ainda serve uma hora mais tarde. */
export const FOLLOWUP_GRACE_MS = 60 * 60_000;

export type TickResult = { fired: string[]; skipped: string[]; followups: string[] };

export class Scheduler {
  readonly #core: Core;
  readonly #runner: RoutineRunner;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking = false;

  constructor(core: Core, runner: RoutineRunner) {
    this.#core = core;
    this.#runner = runner;
  }

  start(): void {
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Uma passada. Devolve o que disparou e o que pulou; os turnos seguem rodando depois. */
  async tick(now: Date = this.#core.now()): Promise<TickResult> {
    const result: TickResult = { fired: [], skipped: [], followups: [] };
    if (this.#ticking) return result;
    this.#ticking = true;
    const { db, bus } = this.#core;
    try {
      const due = await db
        .select()
        .from(routines)
        .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)))
        .orderBy(asc(routines.nextRunAt))
        .limit(50);
      for (const routine of due) {
        const late = now.getTime() - routine.nextRunAt.getTime() > ROUTINE_GRACE_MS;
        let next: Date;
        try {
          next = nextOccurrence(routine.cron, routine.timezone, now);
        } catch (error) {
          await db.update(routines).set({ enabled: false }).where(eq(routines.id, routine.id));
          console.error(`rotina ${routine.title}: horário inválido, desligada: ${errorMessage(error)}`);
          continue;
        }
        const [claimed] = await db
          .update(routines)
          .set({ nextRunAt: next, ...(late ? {} : { lastRunAt: now }) })
          .where(and(eq(routines.id, routine.id), eq(routines.nextRunAt, routine.nextRunAt)))
          .returning();
        if (!claimed) continue;
        if (late) {
          result.skipped.push(routine.id);
          continue;
        }
        result.fired.push(routine.id);
        void this.#runner.fire(claimed).catch((error) => {
          console.error(`rotina ${routine.title}: ${errorMessage(error)}`);
        });
      }

      const dueFollowups = await db
        .select()
        .from(followups)
        .where(and(eq(followups.status, "scheduled"), lte(followups.dueAt, now)))
        .orderBy(asc(followups.dueAt))
        .limit(50);
      for (const followup of dueFollowups) {
        if (now.getTime() - followup.dueAt.getTime() > FOLLOWUP_GRACE_MS) {
          await db
            .update(followups)
            .set({ status: "skipped", finishedAt: now })
            .where(eq(followups.id, followup.id));
          continue;
        }
        result.followups.push(followup.id);
        void this.#runner.fireFollowup(followup).catch((error) => {
          console.error(`retorno ${followup.id}: ${errorMessage(error)}`);
        });
      }
      if (result.fired.length + result.skipped.length + result.followups.length > 0) bus.changed("routines");
    } finally {
      this.#ticking = false;
    }
    return result;
  }
}

/** Ao ligar: o que estava rodando quando o motor parou não vai terminar. */
export async function closeInterruptedWork(core: Core): Promise<void> {
  const now = core.now();
  // Subagentes das execuções interrompidas pararam junto: não ficam "rodando" no histórico.
  const interrupted = await core.db.select({ id: runs.id }).from(runs).where(eq(runs.status, "running"));
  if (interrupted.length > 0) {
    const affected = await core.db.select().from(messages).where(inArray(messages.runId, interrupted.map((run) => run.id)));
    for (const message of affected) {
      if (!message.parts.some((part) => part.type === "tool" && part.task?.status === "running")) continue;
      const parts = message.parts.map((part) =>
        part.type === "tool" && part.task?.status === "running" ? { ...part, task: { ...part.task, status: "stopped" as const } } : part,
      );
      await core.db.update(messages).set({ parts }).where(eq(messages.id, message.id));
    }
  }
  await core.db
    .update(runs)
    .set({ status: "failed", error: "o motor parou no meio desta execução", finishedAt: now })
    .where(eq(runs.status, "running"));
  await core.db
    .update(followups)
    .set({ status: "skipped", finishedAt: now })
    .where(eq(followups.status, "running"));
}
