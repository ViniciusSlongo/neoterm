import { eq, sql } from "drizzle-orm";
import { loadAgent } from "../agents/identity.ts";
import { raiseAttention } from "../attention.ts";
import { agentKey, type Core } from "../core.ts";
import { errorMessage } from "../db/client.ts";
import { followups, messages, routines, runs } from "../db/schema.ts";
import type { GroupEngine } from "../groups/engine.ts";
import { getGroupById } from "../groups/store.ts";
import type { TurnOutcome } from "../runner/turn.ts";
import { agentRowById, conversationById, conversationSession, withNotices } from "../store/conversations.ts";
import type { Followup } from "./followups.ts";
import { describeCron } from "./schedule.ts";
import type { Routine } from "./store.ts";

/*
 * Disparar uma rotina ou um retorno: a instrução entra na conversa, o agente roda sozinho, e a
 * resposta aparece ali como qualquer outra.
 *
 * A REGRA DO CANSAÇO (do OpenBot). Uma rotina que falha avisa uma vez, na primeira falha depois de
 * um sucesso, e não a cada falha. Dez falhas seguidas a desligam, com um último aviso. Não é uma
 * política de nova tentativa: responde se vale a pena continuar disparando, porque um token que
 * venceu em março falha toda noite, e nenhuma nova tentativa resolve isso.
 */

export const FATIGUE_LIMIT = 10;
const SWITCHED_OFF =
  "Esta rotina falhou 10 vezes seguidas, então eu a desliguei. Quando o que ela precisa estiver funcionando, é só religar.";

export class RoutineRunner {
  readonly #core: Core;
  readonly #groups: GroupEngine;

  constructor(core: Core, groups: GroupEngine) {
    this.#core = core;
    this.#groups = groups;
  }

  /** Dispara agora. Devolve o resultado do turno, ou nada se foi pulada (agente pausado). */
  async fire(routine: Routine): Promise<TurnOutcome | undefined> {
    const { db, engine, bus } = this.#core;
    const agentRow = await agentRowById(db, routine.agentId);
    if (!agentRow || agentRow.deletedAt) return undefined;
    if (agentRow.pausedAt) {
      await db.insert(runs).values({
        agentId: agentRow.id,
        conversationId: routine.conversationId,
        routineId: routine.id,
        trigger: "routine",
        status: "skipped",
        error: "o agente está pausado",
        finishedAt: new Date(),
      });
      return undefined;
    }
    let outcome: TurnOutcome | undefined;
    try {
      const conversation = await conversationById(db, routine.conversationId);
      if (!conversation) throw new Error("a conversa da rotina não existe mais");
      if (conversation.groupId) {
        const group = await getGroupById(db, conversation.groupId);
        if (!group) throw new Error("o grupo da rotina não existe mais");
        outcome = await this.#groups.runRoutine(routine, group, agentRow.slug);
      } else {
        outcome = await engine.queue.run([agentKey(agentRow.slug)], async () => {
          const agent = await loadAgent(agentRow.slug);
          const prompt = await withNotices(db, conversation.id, agentRow.id, routinePrompt(routine));
          await db.insert(messages).values({
            conversationId: conversation.id,
            author: "routine",
            agentId: agentRow.id,
            text: routine.instruction,
            meta: { routineId: routine.id, routineTitle: routine.title },
          });
          bus.changed("messages", { kind: "agent", slug: agentRow.slug });
          return engine.execute({
            agent,
            agentRow,
            conversationId: conversation.id,
            scope: { kind: "agent", slug: agentRow.slug },
            trigger: "routine",
            mode: "unattended",
            readOnly: routine.mode === "notify",
            routineId: routine.id,
            prompt,
            cwd: agent.workspace,
            session: conversationSession(db, conversation),
          });
        });
      }
    } catch (error) {
      // Nem chegou a rodar (AGENT.md quebrado, conversa sumiu): conta como falha.
      const [run] = await db
        .insert(runs)
        .values({
          agentId: agentRow.id,
          conversationId: routine.conversationId,
          routineId: routine.id,
          trigger: "routine",
          status: "failed",
          error: errorMessage(error),
          finishedAt: new Date(),
        })
        .returning({ id: runs.id });
      outcome = { ok: false, text: "", error: errorMessage(error), runId: run?.id ?? "" };
    }
    if (outcome) await this.#record(routine, outcome);
    return outcome;
  }

  async #record(routine: Routine, outcome: TurnOutcome): Promise<void> {
    const { db, bus } = this.#core;
    if (outcome.ok) {
      await db.update(routines).set({ failureStreak: 0 }).where(eq(routines.id, routine.id));
      return;
    }
    const [updated] = await db
      .update(routines)
      .set({ failureStreak: sql`${routines.failureStreak} + 1` })
      .where(eq(routines.id, routine.id))
      .returning();
    if (!updated) return;
    const reason = shorten(outcome.error ?? "erro desconhecido", 160);
    if (updated.failureStreak === 1) {
      await this.#notice(updated, `A rotina ${updated.title} falhou: ${reason}`, "routine_failed");
      await raiseAttention(db, bus, {
        kind: "routine_failed",
        agentId: updated.agentId,
        routineId: updated.id,
        text: `rotina ${updated.title} falhou: ${reason}`,
      });
    }
    if (updated.failureStreak >= FATIGUE_LIMIT && updated.enabled) {
      await db.update(routines).set({ enabled: false }).where(eq(routines.id, updated.id));
      await this.#notice(updated, SWITCHED_OFF, "routine_disabled");
      await raiseAttention(db, bus, {
        kind: "routine_disabled",
        agentId: updated.agentId,
        routineId: updated.id,
        text: `rotina ${updated.title} desligada após ${FATIGUE_LIMIT} falhas seguidas`,
      });
    }
    bus.changed("routines");
  }

  async #notice(routine: Routine, text: string, notice: "routine_failed" | "routine_disabled"): Promise<void> {
    const { db, bus } = this.#core;
    await db.insert(messages).values({
      conversationId: routine.conversationId,
      author: "system",
      text,
      meta: { notice, routineId: routine.id, routineTitle: routine.title },
    });
    const conversation = await conversationById(db, routine.conversationId);
    const agent = await agentRowById(db, routine.agentId);
    if (conversation?.groupId) {
      const group = await getGroupById(db, conversation.groupId);
      if (group) bus.changed("messages", { kind: "group", slug: group.slug });
    } else if (agent) {
      bus.changed("messages", { kind: "agent", slug: agent.slug });
    }
  }

  /** Um retorno que o agente agendou para si. */
  async fireFollowup(followup: Followup): Promise<TurnOutcome | undefined> {
    const { db, engine, bus } = this.#core;
    const [claimed] = await db
      .update(followups)
      .set({ status: "running" })
      .where(sql`${followups.id} = ${followup.id} and ${followups.status} = 'scheduled'`)
      .returning();
    if (!claimed) return undefined;
    const finish = (status: "done" | "skipped") =>
      db.update(followups).set({ status, finishedAt: new Date() }).where(eq(followups.id, followup.id));
    const agentRow = await agentRowById(db, followup.agentId);
    if (!agentRow || agentRow.deletedAt || agentRow.pausedAt) {
      await finish("skipped");
      return undefined;
    }
    try {
      const conversation = await conversationById(db, followup.conversationId);
      if (!conversation) {
        await finish("skipped");
        return undefined;
      }
      await db.insert(messages).values({
        conversationId: conversation.id,
        author: "system",
        agentId: agentRow.id,
        text: `Retorno agendado de ${agentRow.slug}: ${followup.reason}`,
        meta: { notice: "followup", followupId: followup.id },
      });
      if (conversation.groupId) {
        const group = await getGroupById(db, conversation.groupId);
        bus.changed("messages", { kind: "group", slug: group?.slug ?? "" });
        return group ? await this.#groups.runFollowup(group, agentRow.slug, followup.reason) : undefined;
      }
      bus.changed("messages", { kind: "agent", slug: agentRow.slug });
      return await engine.queue.run([agentKey(agentRow.slug)], async () => {
        const agent = await loadAgent(agentRow.slug);
        const base = `[Retorno que você agendou]\nMotivo: ${followup.reason}${followup.instruction ? `\nO que fazer: ${followup.instruction}` : ""}\n\nFaça o que tinha ficado e responda para a pessoa.`;
        const prompt = await withNotices(db, conversation.id, agentRow.id, base);
        return engine.execute({
          agent,
          agentRow,
          conversationId: conversation.id,
          scope: { kind: "agent", slug: agentRow.slug },
          trigger: "followup",
          mode: "unattended",
          prompt,
          cwd: agent.workspace,
          session: conversationSession(db, conversation),
        });
      });
    } finally {
      await finish("done");
      bus.changed("routines");
    }
  }
}

export function routinePrompt(routine: Routine): string {
  const does =
    routine.mode === "notify"
      ? "Esta rotina só avisa: verifique e informe, sem mudar nada."
      : "Faça o que ela pede, dentro do que você pode fazer sozinho.";
  return `[Rotina ${routine.title} · ${describeCron(routine.cron)}]\n${routine.instruction}\n\n${does} Responda direto para a pessoa com o resultado; esta resposta aparece na conversa como a da rotina.`;
}

function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
