import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { isValidSlug } from "../agents/identity.ts";
import type { Database } from "../db/client.ts";
import { agents, conversations, groupMembers, groups } from "../db/schema.ts";
import type { AgentRow } from "../store/conversations.ts";

/*
 * Um grupo é um projeto com agentes: uma pasta, uma conversa compartilhada e membros. Cada membro
 * entra com a própria função e o próprio escopo; um deles coordena, e responde quando a pessoa
 * escreve sem chamar ninguém.
 */

export class GroupProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupProblem";
  }
}

export type GroupRow = typeof groups.$inferSelect;
export type GroupMember = {
  agent: AgentRow;
  coordinator: boolean;
  claudeSessionId: string | null;
  lastSeenAt: Date | null;
};
export type GroupDetail = GroupRow & { conversationId: string; members: GroupMember[] };

function expandFolder(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  // O motor não sabe de qual pasta a pessoa falou: o CLI e a interface mandam o caminho completo.
  if (!isAbsolute(path)) throw new GroupProblem(`a pasta do projeto precisa de um caminho completo: ${path}`);
  return resolve(path);
}

export async function createGroup(
  db: Database,
  input: { slug: string; folder: string; objective?: string; members: { agentId: string; coordinator?: boolean }[] },
): Promise<GroupDetail> {
  if (!isValidSlug(input.slug)) {
    throw new GroupProblem("o nome do grupo usa só letras minúsculas, números e '-', até 40 caracteres");
  }
  if (input.members.length === 0) throw new GroupProblem("um grupo precisa de pelo menos um agente");
  await mkdir(expandFolder(input.folder), { recursive: true });
  // O caminho real: o Claude Code e as regras de permissão comparam por ele (no Mac, /var é /private/var).
  const folder = await realpath(expandFolder(input.folder));
  if (!(await stat(folder)).isDirectory()) throw new GroupProblem(`${folder} não é uma pasta`);
  const [existing] = await db.select({ id: groups.id }).from(groups).where(eq(groups.slug, input.slug)).limit(1);
  if (existing) throw new GroupProblem(`já existe o grupo #${input.slug}`);
  const hasCoordinator = input.members.some((member) => member.coordinator);
  const groupId = crypto.randomUUID();
  // Num lote só: ou o grupo nasce inteiro, com membros e conversa, ou não nasce.
  await db.batch([
    db.insert(groups).values({ id: groupId, slug: input.slug, folder, objective: input.objective?.trim() ?? "" }),
    db.insert(groupMembers).values(
      input.members.map((member, index) => ({
        groupId,
        agentId: member.agentId,
        // Sem coordenador escolhido, o primeiro coordena.
        coordinator: hasCoordinator ? Boolean(member.coordinator) : index === 0,
      })),
    ),
    db.insert(conversations).values({ groupId }),
  ]);
  return getGroup(db, input.slug);
}

async function getGroupWith(db: Database, slug: string): Promise<GroupDetail | undefined> {
  const [group] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.slug, slug), isNull(groups.deletedAt)))
    .limit(1);
  if (!group) return undefined;
  let [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.groupId, group.id), isNull(conversations.archivedAt)))
    .limit(1);
  if (!conversation) {
    [conversation] = await db.insert(conversations).values({ groupId: group.id }).returning({ id: conversations.id });
  }
  const rows = await db
    .select({ agent: agents, member: groupMembers })
    .from(groupMembers)
    .innerJoin(agents, eq(groupMembers.agentId, agents.id))
    .where(eq(groupMembers.groupId, group.id))
    .orderBy(asc(groupMembers.joinedAt));
  return {
    ...group,
    conversationId: conversation?.id ?? "",
    members: rows
      .filter((row) => !row.agent.deletedAt)
      .map((row) => ({
        agent: row.agent,
        coordinator: row.member.coordinator,
        claudeSessionId: row.member.claudeSessionId,
        lastSeenAt: row.member.lastSeenAt,
      })),
  };
}

export async function getGroup(db: Database, slug: string): Promise<GroupDetail> {
  const group = await getGroupWith(db, slug);
  if (!group) throw new GroupProblem(`não existe o grupo #${slug}`);
  return group;
}

export async function getGroupById(db: Database, id: string): Promise<GroupDetail | undefined> {
  const [row] = await db.select({ slug: groups.slug }).from(groups).where(eq(groups.id, id)).limit(1);
  return row ? getGroupWith(db, row.slug) : undefined;
}

export async function listGroups(db: Database): Promise<GroupDetail[]> {
  const rows = await db
    .select({ slug: groups.slug })
    .from(groups)
    .where(isNull(groups.deletedAt))
    .orderBy(asc(groups.createdAt));
  const found = await Promise.all(rows.map((row) => getGroupWith(db, row.slug)));
  return found.filter((group): group is GroupDetail => group !== undefined);
}

export async function addMember(db: Database, group: GroupDetail, agentId: string): Promise<void> {
  await db.insert(groupMembers).values({ groupId: group.id, agentId }).onConflictDoNothing();
}

export async function removeMember(db: Database, group: GroupDetail, agentId: string): Promise<void> {
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.agentId, agentId)));
  const left = group.members.filter((member) => member.agent.id !== agentId);
  if (left.length > 0 && !left.some((member) => member.coordinator)) {
    await db
      .update(groupMembers)
      .set({ coordinator: true })
      .where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.agentId, left[0]!.agent.id)));
  }
}

/**
 * Muda um grupo: a pasta, o objetivo e os membros. Em `members`, a ordem conta: o primeiro coordena.
 * Trocar a pasta zera as sessões do Claude Code dos membros (elas pertencem à pasta antiga); a
 * conversa do grupo continua a mesma.
 */
export async function updateGroup(
  db: Database,
  slug: string,
  patch: { folder?: string; objective?: string; members?: { agentId: string }[] },
): Promise<GroupDetail> {
  const group = await getGroup(db, slug);
  const work = [];
  if (patch.folder !== undefined) {
    const folder = await realpath(expandFolder(patch.folder)).catch(() => {
      throw new GroupProblem(`a pasta ${patch.folder} não existe`);
    });
    if (!(await stat(folder)).isDirectory()) throw new GroupProblem(`${folder} não é uma pasta`);
    if (folder !== group.folder) {
      work.push(db.update(groups).set({ folder }).where(eq(groups.id, group.id)));
      work.push(db.update(groupMembers).set({ claudeSessionId: null }).where(eq(groupMembers.groupId, group.id)));
    }
  }
  if (patch.objective !== undefined) work.push(db.update(groups).set({ objective: patch.objective.trim() }).where(eq(groups.id, group.id)));
  if (patch.members !== undefined) {
    const wanted = [...new Set(patch.members.map((member) => member.agentId))];
    if (wanted.length === 0) throw new GroupProblem("um grupo precisa de pelo menos um agente");
    const current = new Set(group.members.map((member) => member.agent.id));
    const removed = [...current].filter((id) => !wanted.includes(id));
    const added = wanted.filter((id) => !current.has(id));
    if (removed.length) work.push(db.delete(groupMembers).where(and(eq(groupMembers.groupId, group.id), inArray(groupMembers.agentId, removed))));
    if (added.length) work.push(db.insert(groupMembers).values(added.map((agentId) => ({ groupId: group.id, agentId }))));
    // O primeiro da lista coordena; os outros, não.
    work.push(db.update(groupMembers).set({ coordinator: false }).where(eq(groupMembers.groupId, group.id)));
    work.push(db.update(groupMembers).set({ coordinator: true }).where(and(eq(groupMembers.groupId, group.id), eq(groupMembers.agentId, wanted[0]!))));
  }
  const [first, ...rest] = work;
  if (first) await db.batch([first, ...rest]);
  return getGroup(db, slug);
}

export async function markSeen(db: Database, groupId: string, agentId: string, until: Date): Promise<void> {
  await db
    .update(groupMembers)
    .set({ lastSeenAt: until })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.agentId, agentId)));
}

export async function deleteGroup(db: Database, group: GroupRow, now: Date): Promise<void> {
  // O nome fica livre para um grupo novo; a conversa antiga fica no banco.
  await db
    .update(groups)
    .set({ deletedAt: now, slug: `${group.slug}~${now.getTime()}` })
    .where(eq(groups.id, group.id));
}
