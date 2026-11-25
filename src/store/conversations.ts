import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { agents, conversations, groupMembers, messages } from "../db/schema.ts";
import type { SessionSlot } from "../runner/turn.ts";

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

export async function agentRowById(db: Database, id: string): Promise<AgentRow | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
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

export async function conversationById(db: Database, id: string): Promise<ConversationRow | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row;
}

/** As últimas `limit` mensagens de uma conversa, da mais antiga para a mais nova. */
export async function lastMessages(db: Database, conversationId: string, limit: number): Promise<MessageRow[]> {
  const newestFirst = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return newestFirst.reverse();
}

export async function conversationMessages(db: Database, conversationId: string): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
}

/** A sessão do Claude Code guardada na conversa. */
export function conversationSession(db: Database, conversation: ConversationRow): SessionSlot {
  return {
    id: conversation.claudeSessionId,
    save: async (id) => {
      await db.update(conversations).set({ claudeSessionId: id }).where(eq(conversations.id, conversation.id));
    },
  };
}

/** A sessão do Claude Code de um agente dentro de um grupo. */
export function memberSession(db: Database, groupId: string, agentId: string, current: string | null): SessionSlot {
  return {
    id: current,
    save: async (id) => {
      await db
        .update(groupMembers)
        .set({ claudeSessionId: id })
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.agentId, agentId)));
    },
  };
}

/**
 * Os avisos do neoterm (uma rotina que falhou, por exemplo) desde a última resposta do agente,
 * prontos para abrir o próximo turno. Ditos na conversa, e não só no prompt de sistema, porque o
 * agente confia mais no que leu na conversa do que numa instrução que mudou.
 */
export async function withNotices(db: Database, conversationId: string, agentId: string, prompt: string): Promise<string> {
  const [lastReply] = await db
    .select({ at: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.agentId, agentId), eq(messages.author, "agent")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const notices = (
    await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.author, "system"),
          lastReply ? gt(messages.createdAt, lastReply.at) : undefined,
        ),
      )
      .orderBy(asc(messages.createdAt))
  ).filter((message) => message.meta.notice !== "followup");
  if (notices.length === 0) return prompt;
  return `[Avisos do neoterm desde a sua última resposta]\n${notices.map((notice) => `- ${notice.text}`).join("\n")}\n\n${prompt}`;
}
