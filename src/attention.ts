import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { Database } from "./db/client.ts";
import { type AttentionKind, agents, attention, groups } from "./db/schema.ts";
import type { EventBus } from "./events.ts";

/*
 * "Precisa de você": o que só a pessoa pode resolver. Uma rotina que falhou ou foi desligada, um
 * grupo esperando uma decisão. O mesmo assunto aberto duas vezes vira
 * um item só, atualizado, e não uma pilha.
 */

export type AttentionInput = {
  kind: AttentionKind;
  text: string;
  agentId?: string;
  groupId?: string;
  routineId?: string;
  tool?: string;
};

export type AttentionItem = {
  id: string;
  kind: AttentionKind;
  text: string;
  tool: string | null;
  agent: string | null;
  group: string | null;
  routineId: string | null;
  createdAt: Date;
};

export async function raiseAttention(db: Database, bus: EventBus, input: AttentionInput): Promise<string> {
  const same: SQL[] = [eq(attention.kind, input.kind), isNull(attention.resolvedAt)];
  same.push(input.agentId ? eq(attention.agentId, input.agentId) : isNull(attention.agentId));
  same.push(input.groupId ? eq(attention.groupId, input.groupId) : isNull(attention.groupId));
  same.push(input.routineId ? eq(attention.routineId, input.routineId) : isNull(attention.routineId));
  same.push(input.tool ? eq(attention.tool, input.tool) : isNull(attention.tool));
  const [open] = await db.select({ id: attention.id }).from(attention).where(and(...same)).limit(1);
  let id: string;
  if (open) {
    await db.update(attention).set({ text: input.text, createdAt: new Date() }).where(eq(attention.id, open.id));
    id = open.id;
  } else {
    const [created] = await db.insert(attention).values(input).returning({ id: attention.id });
    id = created?.id ?? "";
  }
  bus.changed("attention");
  return id;
}

export async function resolveAttention(db: Database, bus: EventBus, id: string): Promise<boolean> {
  const updated = await db
    .update(attention)
    .set({ resolvedAt: new Date() })
    .where(and(eq(attention.id, id), isNull(attention.resolvedAt)))
    .returning({ id: attention.id });
  if (updated.length > 0) bus.changed("attention");
  return updated.length > 0;
}

/** Resolve os itens abertos de um tipo num grupo, como quando a pessoa responde ao grupo. */
export async function resolveGroupAttention(db: Database, bus: EventBus, groupId: string): Promise<void> {
  const updated = await db
    .update(attention)
    .set({ resolvedAt: new Date() })
    .where(and(eq(attention.groupId, groupId), isNull(attention.resolvedAt)))
    .returning({ id: attention.id });
  if (updated.length > 0) bus.changed("attention");
}

export async function getAttention(db: Database, id: string) {
  const [row] = await db.select().from(attention).where(eq(attention.id, id)).limit(1);
  return row;
}

export async function openAttention(db: Database): Promise<AttentionItem[]> {
  const rows = await db
    .select({
      id: attention.id,
      kind: attention.kind,
      text: attention.text,
      tool: attention.tool,
      agent: agents.slug,
      group: groups.slug,
      routineId: attention.routineId,
      createdAt: attention.createdAt,
    })
    .from(attention)
    .leftJoin(agents, eq(attention.agentId, agents.id))
    .leftJoin(groups, eq(attention.groupId, groups.id))
    .where(isNull(attention.resolvedAt))
    .orderBy(desc(attention.createdAt));
  return rows;
}
