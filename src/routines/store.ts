import { and, asc, count, eq, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { agents, conversations, groups, type RoutineMode, routines } from "../db/schema.ts";
import { describeCron, describeWhen, nextOccurrence, ScheduleRefused, validateSchedule } from "./schedule.ts";

/*
 * Rotinas: o que um agente faz sozinho, num horário, até alguém desligar.
 * Regras do OpenBot: no máximo 15 min entre execuções (schedule.ts) e no máximo 20 rotinas ligadas
 * ao mesmo tempo, porque 20 é onde a lista deixa de caber na cabeça de alguém.
 */

export const MAX_ENABLED = 20;

export class RoutineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineRefused";
  }
}

export type Routine = typeof routines.$inferSelect;

export type RoutineInput = {
  title: string;
  instruction: string;
  cron: string;
  timezone: string;
  mode?: RoutineMode;
};

export type RoutineView = Routine & { agent: string; group: string | null };

/** Um nome curto e estável: "Resumo diário!" vira "resumo-diario". */
export function normalizeTitle(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "rotina";
}

function checkSchedule(cron: string, timezone: string, now: Date): void {
  try {
    validateSchedule(cron, timezone, now);
  } catch (error) {
    if (error instanceof ScheduleRefused) throw new RoutineRefused(error.message);
    throw error;
  }
}

async function enabledCount(db: Database): Promise<number> {
  const [row] = await db.select({ value: count() }).from(routines).where(eq(routines.enabled, true));
  return row?.value ?? 0;
}

async function titleTaken(db: Database, agentId: string, title: string, except?: string): Promise<boolean> {
  const rows = await db
    .select({ id: routines.id })
    .from(routines)
    .where(and(eq(routines.agentId, agentId), eq(routines.title, title)));
  return rows.some((row) => row.id !== except);
}

export async function createRoutine(
  db: Database,
  input: RoutineInput & { agentId: string; conversationId: string; now?: Date },
): Promise<Routine> {
  const now = input.now ?? new Date();
  const title = normalizeTitle(input.title);
  const instruction = input.instruction.trim();
  if (!instruction) throw new RoutineRefused("a rotina precisa dizer o que fazer");
  checkSchedule(input.cron, input.timezone, now);
  if ((await enabledCount(db)) >= MAX_ENABLED) {
    throw new RoutineRefused(`já existem ${MAX_ENABLED} rotinas ligadas; desligue uma antes de criar outra`);
  }
  if (await titleTaken(db, input.agentId, title)) {
    throw new RoutineRefused(`este agente já tem uma rotina chamada "${title}"`);
  }
  const [created] = await db
    .insert(routines)
    .values({
      agentId: input.agentId,
      conversationId: input.conversationId,
      title,
      instruction,
      cron: input.cron.trim(),
      timezone: input.timezone,
      mode: input.mode ?? "act",
      nextRunAt: nextOccurrence(input.cron, input.timezone, now),
      enabledAt: now,
    })
    .returning();
  if (!created) throw new Error("não consegui salvar a rotina");
  return created;
}

export type RoutinePatch = Partial<RoutineInput> & { enabled?: boolean };

export async function updateRoutine(
  db: Database,
  routine: Routine,
  patch: RoutinePatch,
  now: Date = new Date(),
): Promise<Routine> {
  const changes: Partial<Routine> = { updatedAt: now };
  if (patch.title !== undefined) {
    const title = normalizeTitle(patch.title);
    if (await titleTaken(db, routine.agentId, title, routine.id)) {
      throw new RoutineRefused(`este agente já tem uma rotina chamada "${title}"`);
    }
    changes.title = title;
  }
  if (patch.instruction !== undefined) {
    if (!patch.instruction.trim()) throw new RoutineRefused("a rotina precisa dizer o que fazer");
    changes.instruction = patch.instruction.trim();
  }
  if (patch.mode !== undefined) changes.mode = patch.mode;
  const cron = patch.cron?.trim() ?? routine.cron;
  const timezone = patch.timezone ?? routine.timezone;
  const scheduleChanged = cron !== routine.cron || timezone !== routine.timezone;
  if (scheduleChanged) {
    checkSchedule(cron, timezone, now);
    changes.cron = cron;
    changes.timezone = timezone;
    changes.nextRunAt = nextOccurrence(cron, timezone, now);
  }
  if (patch.enabled === true && !routine.enabled) {
    if ((await enabledCount(db)) >= MAX_ENABLED) {
      throw new RoutineRefused(`já existem ${MAX_ENABLED} rotinas ligadas; desligue uma antes`);
    }
    // Religar zera a contagem de falhas e não dispara o que passou enquanto estava desligada.
    changes.enabled = true;
    changes.enabledAt = now;
    changes.failureStreak = 0;
    changes.nextRunAt = nextOccurrence(cron, timezone, now);
  } else if (patch.enabled === false) {
    changes.enabled = false;
  }
  const [updated] = await db.update(routines).set(changes).where(eq(routines.id, routine.id)).returning();
  if (!updated) throw new RoutineRefused("essa rotina não existe mais");
  return updated;
}

export async function deleteRoutine(db: Database, id: string): Promise<boolean> {
  const deleted = await db.delete(routines).where(eq(routines.id, id)).returning({ id: routines.id });
  return deleted.length > 0;
}

export async function getRoutine(db: Database, id: string): Promise<Routine | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [row] = await db.select().from(routines).where(eq(routines.id, id)).limit(1);
  return row;
}

/** Acha uma rotina do agente pelo id ou pelo nome. */
export async function findRoutine(db: Database, agentId: string, ref: string): Promise<Routine | undefined> {
  const byId = await getRoutine(db, ref.trim());
  if (byId && byId.agentId === agentId) return byId;
  const [byTitle] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.agentId, agentId), eq(routines.title, normalizeTitle(ref))))
    .limit(1);
  return byTitle;
}

export async function listRoutines(db: Database, filter: { agentId?: string } = {}): Promise<RoutineView[]> {
  const where: SQL[] = [];
  if (filter.agentId) where.push(eq(routines.agentId, filter.agentId));
  const rows = await db
    .select({ routine: routines, agent: agents.slug, group: groups.slug })
    .from(routines)
    .innerJoin(agents, eq(routines.agentId, agents.id))
    .innerJoin(conversations, eq(routines.conversationId, conversations.id))
    .leftJoin(groups, eq(conversations.groupId, groups.id))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(asc(routines.createdAt));
  return rows.map((row) => ({ ...row.routine, agent: row.agent, group: row.group }));
}

/** Uma linha que um agente ou a pessoa entende. */
export function describeRoutine(routine: Routine, now: Date = new Date()): string {
  const does = routine.mode === "notify" ? "só avisa" : "age";
  const when = routine.enabled
    ? `próxima ${describeWhen(routine.nextRunAt, routine.timezone, now)}`
    : routine.failureStreak >= 10
      ? "desligada após 10 falhas seguidas"
      : "desligada";
  return `${routine.title} · ${describeCron(routine.cron)} (${routine.timezone}) · ${does} · ${when} · id ${routine.id}`;
}
