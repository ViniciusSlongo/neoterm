import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { isMissingFile, NEOTERM_HOME } from "../config.ts";
import type { Core } from "../core.ts";
import { attention, conversations, followups, groupMembers, messages, routines } from "../db/schema.ts";
import { agents } from "../db/schema.ts";
import { ensureAgentRow } from "../store/conversations.ts";
import { agentDir, AgentNotFound, loadAgent, MEMORY_FILE } from "./identity.ts";

/*
 * O ciclo de vida de um agente: pausar, retomar, recomeçar e excluir.
 *
 * PAUSAR segura o que ele faz sozinho: rotinas, retornos e chamadas de colegas num grupo. A conversa
 * com a pessoa continua: quem está ali escrevendo não precisa ser impedido.
 *
 * RECOMEÇAR é planejado, depois feito (do OpenBot): primeiro o neoterm conta o que vai embora, a
 * pessoa vê, e só então apaga. Vão as conversas dele com você, as rotinas, os retornos, a memória e
 * as sessões nos grupos. Ficam o AGENT.md e o que ele disse nos grupos, que é dos outros também.
 *
 * EXCLUIR não apaga: a pasta vai para ~/.neoterm/trash, as rotinas são desligadas e o nome fica livre.
 */

export const TRASH_DIR = join(NEOTERM_HOME, "trash");

export async function setPaused(core: Core, slug: string, paused: boolean): Promise<void> {
  await loadAgent(slug);
  const row = await ensureAgentRow(core.db, slug);
  await core.db
    .update(agents)
    .set({ pausedAt: paused ? core.now() : null })
    .where(eq(agents.id, row.id));
  core.bus.changed("agents");
}

export type ResetPlan = {
  conversations: number;
  messages: number;
  routines: number;
  followups: number;
  groupSessions: number;
  memory: boolean;
};

export async function planReset(core: Core, slug: string): Promise<ResetPlan> {
  const agent = await loadAgent(slug);
  const row = await ensureAgentRow(core.db, slug);
  const db = core.db;
  const owned = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.agentId, row.id));
  const ids = owned.map((conversation) => conversation.id);
  const [messageCount] = ids.length
    ? await db.select({ value: count() }).from(messages).where(inArray(messages.conversationId, ids))
    : [{ value: 0 }];
  const [routineCount] = await db.select({ value: count() }).from(routines).where(eq(routines.agentId, row.id));
  const [followupCount] = await db
    .select({ value: count() })
    .from(followups)
    .where(and(eq(followups.agentId, row.id), eq(followups.status, "scheduled")));
  const [sessionCount] = await db
    .select({ value: count() })
    .from(groupMembers)
    .where(and(eq(groupMembers.agentId, row.id), isNotNull(groupMembers.claudeSessionId)));
  let memory = false;
  try {
    memory = (await readFile(join(agent.dir, MEMORY_FILE), "utf8")).trim().length > 0;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return {
    conversations: ids.length,
    messages: messageCount?.value ?? 0,
    routines: routineCount?.value ?? 0,
    followups: followupCount?.value ?? 0,
    groupSessions: sessionCount?.value ?? 0,
    memory,
  };
}

export async function reset(core: Core, slug: string): Promise<ResetPlan> {
  const plan = await planReset(core, slug);
  const agent = await loadAgent(slug);
  const row = await ensureAgentRow(core.db, slug);
  const db = core.db;
  await db.batch([
    db.delete(routines).where(eq(routines.agentId, row.id)),
    db.delete(followups).where(eq(followups.agentId, row.id)),
    db.delete(conversations).where(eq(conversations.agentId, row.id)),
    db
      .update(groupMembers)
      .set({ claudeSessionId: null, lastSeenAt: null })
      .where(eq(groupMembers.agentId, row.id)),
    db
      .update(attention)
      .set({ resolvedAt: core.now() })
      .where(and(eq(attention.agentId, row.id), isNull(attention.resolvedAt))),
  ]);
  await writeFile(join(agent.dir, MEMORY_FILE), "", "utf8");
  core.bus.changed("agents");
  core.bus.changed("routines");
  core.bus.changed("attention");
  core.bus.changed("messages", { kind: "agent", slug });
  return plan;
}

/** Tira o agente de cena: pasta para a lixeira, rotinas desligadas, nome livre para outro. */
export async function removeAgent(core: Core, slug: string): Promise<string> {
  const agent = await loadAgent(slug).catch((error) => {
    if (error instanceof AgentNotFound) throw error;
    return undefined;
  });
  const now = core.now();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  await mkdir(TRASH_DIR, { recursive: true });
  const target = join(TRASH_DIR, `${slug}-${stamp}`);
  await rename(agent?.dir ?? agentDir(slug), target);
  const row = await ensureAgentRow(core.db, slug);
  const db = core.db;
  await db.batch([
    db.update(routines).set({ enabled: false }).where(eq(routines.agentId, row.id)),
    db
      .update(followups)
      .set({ status: "cancelled", finishedAt: now })
      .where(and(eq(followups.agentId, row.id), eq(followups.status, "scheduled"))),
    db.update(conversations).set({ archivedAt: now }).where(eq(conversations.agentId, row.id)),
    db.delete(groupMembers).where(eq(groupMembers.agentId, row.id)),
    db
      .update(attention)
      .set({ resolvedAt: now })
      .where(and(eq(attention.agentId, row.id), isNull(attention.resolvedAt))),
    db.update(agents).set({ deletedAt: now, slug: `${slug}~${now.getTime()}` }).where(eq(agents.id, row.id)),
  ]);
  core.bus.changed("agents");
  core.bus.changed("groups");
  core.bus.changed("routines");
  return target;
}
