import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { agents, conversations, messages } from "../db/schema.ts";

export type AgentRow = typeof agents.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/** A linha do agente no banco, criada na primeira vez que ele é usado. */
export async function ensureAgentRow(db: Database, slug: string): Promise<AgentRow> {
  await db.insert(agents).values({ slug }).onConflictDoNothing({ target: agents.slug });
  const [row] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  if (!row) throw new Error(`não consegui registrar o agente "${slug}"`);
  return row;
}

export async function findAgentRow(db: Database, slug: string): Promise<AgentRow | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  return row;
}

/** A conversa da pessoa com o agente: a mais recente que não foi arquivada, ou uma nova. */
export async function mainConversation(db: Database, agentId: string): Promise<ConversationRow> {
  const [current] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.agentId, agentId), isNull(conversations.archivedAt)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (current) return current;
  const [created] = await db.insert(conversations).values({ agentId }).returning();
  if (!created) throw new Error("não consegui abrir a conversa");
  return created;
}

/** As últimas `limit` mensagens da conversa principal do agente, da mais antiga para a mais nova. */
export async function recentMessages(
  db: Database,
  agentId: string,
  limit: number,
): Promise<MessageRow[]> {
  const conversation = await mainConversation(db, agentId);
  const newestFirst = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return newestFirst.reverse();
}

export async function conversationMessages(
  db: Database,
  conversationId: string,
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}
