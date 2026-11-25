import { and, asc, count, eq, gte } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { followups } from "../db/schema.ts";

/*
 * Um retorno: o agente decide voltar depois, sozinho ("confiro o build daqui a uma hora").
 * Uma vez só e com limites, como no OpenBot: entre 1 minuto e 7 dias, no máximo 5 esperando por
 * agente e 20 agendados por dia. Um retorno que agenda outro continua dentro dos mesmos limites,
 * então não vira um laço.
 */

export const FOLLOWUP_MIN_MINUTES = 1;
export const FOLLOWUP_MAX_MINUTES = 7 * 24 * 60;
export const FOLLOWUP_MAX_PENDING = 5;
export const FOLLOWUP_MAX_PER_DAY = 20;

export class FollowupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FollowupRefused";
  }
}

export type Followup = typeof followups.$inferSelect;

export async function scheduleFollowup(
  db: Database,
  input: {
    agentId: string;
    conversationId: string;
    minutes: number;
    reason: string;
    instruction?: string;
    now?: Date;
  },
): Promise<Followup> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.minutes) || input.minutes < FOLLOWUP_MIN_MINUTES || input.minutes > FOLLOWUP_MAX_MINUTES) {
    throw new FollowupRefused("um retorno fica entre 1 minuto e 7 dias");
  }
  if (!input.reason.trim()) throw new FollowupRefused("diga por que vai voltar");
  const [pending] = await db
    .select({ value: count() })
    .from(followups)
    .where(and(eq(followups.agentId, input.agentId), eq(followups.status, "scheduled")));
  if ((pending?.value ?? 0) >= FOLLOWUP_MAX_PENDING) {
    throw new FollowupRefused(`você já tem ${FOLLOWUP_MAX_PENDING} retornos esperando`);
  }
  const [today] = await db
    .select({ value: count() })
    .from(followups)
    .where(and(eq(followups.agentId, input.agentId), gte(followups.createdAt, new Date(now.getTime() - 86_400_000))));
  if ((today?.value ?? 0) >= FOLLOWUP_MAX_PER_DAY) {
    throw new FollowupRefused(`você já agendou ${FOLLOWUP_MAX_PER_DAY} retornos nas últimas 24 horas`);
  }
  const [created] = await db
    .insert(followups)
    .values({
      agentId: input.agentId,
      conversationId: input.conversationId,
      reason: input.reason.trim(),
      instruction: input.instruction?.trim() || null,
      dueAt: new Date(now.getTime() + Math.round(input.minutes) * 60_000),
    })
    .returning();
  if (!created) throw new Error("não consegui agendar o retorno");
  return created;
}

export async function pendingFollowups(db: Database, agentId?: string): Promise<Followup[]> {
  return db
    .select()
    .from(followups)
    .where(agentId ? and(eq(followups.status, "scheduled"), eq(followups.agentId, agentId)) : eq(followups.status, "scheduled"))
    .orderBy(asc(followups.dueAt));
}

export async function cancelFollowup(db: Database, id: string): Promise<boolean> {
  const updated = await db
    .update(followups)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(followups.id, id), eq(followups.status, "scheduled")))
    .returning({ id: followups.id });
  return updated.length > 0;
}
