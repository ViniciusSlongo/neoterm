import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { listAgents, loadAgent } from "../agents/identity.ts";
import { raiseAttention, resolveGroupAttention } from "../attention.ts";
import { agentKey, type Core, groupKey } from "../core.ts";
import { readSettings } from "../config.ts";
import { errorMessage } from "../db/client.ts";
import { type MessageMeta, messages, type RunTrigger } from "../db/schema.ts";
import type { Scope } from "../events.ts";
import type { Routine } from "../routines/store.ts";
import type { TurnOutcome } from "../runner/turn.ts";
import { memberSession, type MessageRow } from "../store/conversations.ts";
import { findMentions, type Member } from "./mentions.ts";
import { type GroupDetail, getGroup, getGroupById, markSeen } from "./store.ts";

/*
 * A conversa de um grupo. A pessoa escreve; quem ela chamou com @nome responde, ou o coordenador
 * se ela não chamou ninguém. Um agente que escreve @colega na resposta passa a vez para ele, como
 * no OpenBot (channels/group.ts), e cada um lê o que aconteceu desde a última vez que falou.
 *
 * LIVRE, MAS COM UM FREIO QUE NINGUÉM CONFIGURA. Os agentes se chamam à vontade. Só se passarem de
 * MAX_HOPS falas seguidas sem a pessoa o grupo para e a chama, porque dois agentes num vai e vem
 * gastam a cota do plano sem avançar.
 *
 * UM DE CADA VEZ. Um grupo fala um agente por vez (fila do grupo), e um agente nunca roda dois
 * turnos ao mesmo tempo (fila do agente), esteja onde estiver.
 */

export const MAX_HOPS = 30;

type Origin = "person" | "routine" | "followup";
type Hop = {
  origin: Origin;
  /** Quantas falas de agentes desde a última da pessoa (ou da rotina) que começou isto. */
  hops: number;
  calledBy?: string;
  routine?: Routine;
  followupReason?: string;
};

export class GroupEngine {
  readonly #core: Core;
  readonly #inFlight = new Map<string, number>();

  constructor(core: Core) {
    this.#core = core;
  }

  /** Se o grupo tem alguém falando ou na fila. */
  isBusy(groupId: string): boolean {
    return (this.#inFlight.get(groupId) ?? 0) > 0;
  }

  /** A pessoa escreve no grupo. Devolve quem vai responder; as respostas chegam pelos eventos. */
  async postPersonMessage(slug: string, text: string): Promise<{ messageId: string; responders: string[] }> {
    const { db, bus } = this.#core;
    const group = await getGroup(db, slug);
    if (group.members.length === 0) throw new Error(`o grupo #${slug} não tem agentes`);
    const members = await this.#members(group);
    const mentions = findMentions(text, members);
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: group.conversationId,
        author: "person",
        text,
        meta: mentions.agents.length > 0 ? { mentions: mentions.agents } : {},
      })
      .returning({ id: messages.id });
    await resolveGroupAttention(db, bus, group.id);
    bus.changed("messages", this.#scope(group));
    const coordinator = group.members.find((member) => member.coordinator) ?? group.members[0];
    const responders = mentions.agents.length > 0 ? mentions.agents : coordinator ? [coordinator.agent.slug] : [];
    for (const responder of responders) void this.#schedule(group.id, responder, { origin: "person", hops: 0 });
    return { messageId: message?.id ?? "", responders };
  }

  /** Uma rotina de um agente que posta no grupo: a instrução entra na conversa e ele responde. */
  async runRoutine(routine: Routine, group: GroupDetail, agentSlug: string): Promise<TurnOutcome | undefined> {
    const { db, bus } = this.#core;
    await db.insert(messages).values({
      conversationId: group.conversationId,
      author: "routine",
      agentId: routine.agentId,
      text: routine.instruction,
      meta: { routineId: routine.id, routineTitle: routine.title },
    });
    bus.changed("messages", this.#scope(group));
    return this.#schedule(group.id, agentSlug, { origin: "routine", hops: 0, routine });
  }

  /** Um retorno que o agente agendou dentro do grupo. */
  async runFollowup(group: GroupDetail, agentSlug: string, reason: string): Promise<TurnOutcome | undefined> {
    return this.#schedule(group.id, agentSlug, { origin: "followup", hops: 0, followupReason: reason });
  }

  async #schedule(groupId: string, slug: string, hop: Hop): Promise<TurnOutcome | undefined> {
    this.#inFlight.set(groupId, (this.#inFlight.get(groupId) ?? 0) + 1);
    this.#core.bus.changed("groups");
    try {
      return await this.#core.engine.queue.run([groupKey(groupId), agentKey(slug)], () => this.#turn(groupId, slug, hop));
    } catch (error) {
      console.error(`grupo: o turno de ${slug} falhou: ${errorMessage(error)}`);
      return undefined;
    } finally {
      const left = (this.#inFlight.get(groupId) ?? 1) - 1;
      if (left > 0) this.#inFlight.set(groupId, left);
      else this.#inFlight.delete(groupId);
      this.#core.bus.changed("groups");
    }
  }

  async #turn(groupId: string, slug: string, hop: Hop): Promise<TurnOutcome | undefined> {
    const { db, bus, engine } = this.#core;
    const group = await getGroupById(db, groupId);
    if (!group) return undefined;
    const member = group.members.find((candidate) => candidate.agent.slug === slug);
    if (!member) return undefined;
    const scope = this.#scope(group);

    if (member.agent.pausedAt && (hop.calledBy || hop.origin !== "person")) {
      await this.#notice(group, `${slug} está pausado e não respondeu.`, { notice: "agent_paused" });
      return undefined;
    }
    if (hop.hops > MAX_HOPS) {
      await this.#notice(
        group,
        `Os agentes conversaram ${MAX_HOPS} vezes seguidas sem você, e o grupo parou aqui. Escreva no grupo para continuar.`,
        { notice: "group_stopped" },
      );
      await raiseAttention(db, bus, {
        kind: "group_stopped",
        groupId: group.id,
        text: `#${group.slug} parou depois de ${MAX_HOPS} falas seguidas sem você`,
      });
      return undefined;
    }

    const agent = await loadAgent(slug);
    const delta = await this.#unread(group, member.agent.id, member.lastSeenAt);
    if (delta.length === 0 && !hop.followupReason) return undefined;
    const lastSeen = delta.at(-1)?.createdAt;
    if (lastSeen) await markSeen(db, group.id, member.agent.id, lastSeen);

    const settings = await readSettings();
    const members = await this.#members(group);
    const trigger: RunTrigger =
      hop.hops === 0 && hop.origin === "routine" ? "routine" : hop.hops === 0 && hop.origin === "followup" ? "followup" : "group";
    const outcome = await engine.execute({
      agent,
      agentRow: member.agent,
      conversationId: group.conversationId,
      groupId: group.id,
      scope,
      trigger,
      // Uma conversa que a pessoa começou tem alguém por perto; uma que uma rotina começou, não.
      mode: hop.origin === "person" ? "interactive" : "unattended",
      readOnly: hop.hops === 0 && hop.routine?.mode === "notify",
      ...(hop.hops === 0 && hop.routine ? { routineId: hop.routine.id } : {}),
      prompt: renderUnread(group, delta, slug, hop, members, settings.timezone),
      cwd: group.folder,
      extraSystem: groupContext(group, members, slug),
      session: memberSession(db, group.id, member.agent.id, member.claudeSessionId),
    });

    if (outcome.ok && outcome.messageId) {
      const mentions = findMentions(outcome.text, members.filter((candidate) => candidate.slug !== slug));
      const meta: MessageMeta = {
        ...(mentions.agents.length > 0 ? { mentions: mentions.agents } : {}),
        ...(mentions.person ? { asksPerson: true } : {}),
        ...(hop.hops === 0 && hop.routine ? { routineId: hop.routine.id } : {}),
      };
      if (Object.keys(meta).length > 0) {
        await db.update(messages).set({ meta }).where(eq(messages.id, outcome.messageId));
      }
      if (mentions.person) {
        await raiseAttention(db, bus, {
          kind: "group_waiting",
          groupId: group.id,
          agentId: member.agent.id,
          text: `#${group.slug}: ${slug} pediu sua decisão`,
        });
      }
      for (const next of mentions.agents) {
        void this.#schedule(group.id, next, {
          origin: hop.origin,
          hops: hop.hops + 1,
          calledBy: slug,
          ...(hop.routine ? { routine: hop.routine } : {}),
        });
      }
    }
    return outcome;
  }

  /** O que aconteceu no grupo desde a última vez que o agente falou, menos o que ele mesmo disse. */
  async #unread(group: GroupDetail, agentId: string, since: Date | null): Promise<MessageRow[]> {
    const { db } = this.#core;
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, group.conversationId),
          since ? gt(messages.createdAt, since) : sql`true`,
          or(isNull(messages.agentId), ne(messages.agentId, agentId), eq(messages.author, "routine")),
        ),
      )
      .orderBy(asc(messages.createdAt));
    // Sem histórico lido, as últimas 40 mensagens bastam para entrar na conversa.
    return since ? rows : rows.slice(-40);
  }

  async #members(group: GroupDetail): Promise<(Member & { title: string; coordinator: boolean })[]> {
    const { agents } = await listAgents();
    return group.members.map((member) => {
      const definition = agents.find((agent) => agent.slug === member.agent.slug);
      return {
        slug: member.agent.slug,
        name: definition?.name ?? member.agent.slug,
        title: definition?.title ?? "",
        coordinator: member.coordinator,
      };
    });
  }

  async #notice(group: GroupDetail, text: string, meta: MessageMeta): Promise<void> {
    await this.#core.db.insert(messages).values({ conversationId: group.conversationId, author: "system", text, meta });
    this.#core.bus.changed("messages", this.#scope(group));
  }

  #scope(group: { slug: string }): Scope {
    return { kind: "group", slug: group.slug };
  }
}

function clock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
}

function speaker(message: MessageRow, members: readonly Member[]): string {
  if (message.author === "person") return "você";
  if (message.author === "system") return "neoterm";
  const member = members.find((candidate) => candidate.slug && message.agentId && candidate.slug === candidateSlug(message, members));
  return member?.slug ?? "agente";
}

/** O slug do autor, que vem no meta de quem renderiza (preenchido em renderUnread). */
function candidateSlug(message: MessageRow & { authorSlug?: string }, _members: readonly Member[]): string | undefined {
  return message.authorSlug;
}

export function renderUnread(
  group: GroupDetail,
  delta: readonly MessageRow[],
  self: string,
  hop: Hop,
  members: readonly Member[],
  timeZone: string,
): string {
  const slugById = new Map(group.members.map((member) => [member.agent.id, member.agent.slug]));
  const lines = delta.map((message) => {
    const withSlug = { ...message, authorSlug: message.agentId ? slugById.get(message.agentId) : undefined };
    const who =
      message.author === "routine"
        ? `rotina ${message.meta.routineTitle ?? ""}`.trim()
        : speaker(withSlug, members);
    return `[${who} · ${clock(message.createdAt, timeZone)}] ${message.text}`;
  });
  const header = lines.length > 0 ? `Mensagens novas em #${group.slug}:\n\n${lines.join("\n\n")}\n\n` : "";
  let call: string;
  if (hop.followupReason) call = `Você agendou um retorno neste grupo. Motivo: ${hop.followupReason}. Faça o que tinha ficado e responda no grupo.`;
  else if (hop.calledBy) call = `${hop.calledBy} chamou você (@${self}). Responda no grupo.`;
  else if (hop.origin === "routine") call = "Esta é uma rotina sua: faça o que ela pede e responda no grupo.";
  else call = "A pessoa escreveu no grupo. Responda no grupo.";
  return `${header}${call}`;
}

export function groupContext(
  group: GroupDetail,
  members: readonly (Member & { title: string; coordinator: boolean })[],
  self: string,
): string {
  const roster = members
    .map((member) => {
      const marks = [member.slug === self ? "você" : "", member.coordinator ? "coordena" : ""].filter(Boolean).join(", ");
      return `- @${member.slug}${marks ? ` (${marks})` : ""}${member.title ? `: ${member.title}` : ""}`;
    })
    .join("\n");
  return [
    "<group>",
    `Você está no grupo #${group.slug} com outros agentes, trabalhando no mesmo projeto.`,
    `Pasta do projeto: ${group.folder} (seu diretório de trabalho aqui).`,
    group.objective ? `Objetivo: ${group.objective}` : "",
    "Membros:",
    roster,
    "Como colaborar:",
    "- Para pedir algo a um colega, escreva @nome na sua resposta dizendo a tarefa, o que deve ser respeitado e o que você espera de volta. Ele responde logo depois, aqui no grupo.",
    "- Chame só quem for necessário. Não chame ninguém só para agradecer ou confirmar.",
    "- Quando precisar de uma decisão da pessoa, escreva @você e pare.",
    "- Quando o trabalho estiver feito e ninguém mais precisar agir, apenas responda, sem chamar ninguém.",
    "</group>",
  ]
    .filter(Boolean)
    .join("\n");
}
