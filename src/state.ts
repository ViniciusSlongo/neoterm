import { and, gte, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { listAgents } from "./agents/identity.ts";
import { notesPath } from "./agents/notes.ts";
import { countTasks } from "./agents/tasks.ts";
import { type AttentionItem, openAttention } from "./attention.ts";
import { readSettings } from "./config.ts";
import type { Core } from "./core.ts";
import { runs } from "./db/schema.ts";
import type { GroupEngine } from "./groups/engine.ts";
import { listGroups } from "./groups/store.ts";
import { dayBounds, occurrencesBetween } from "./routines/schedule.ts";
import { ROUTINE_GRACE_MS } from "./routines/scheduler.ts";
import { listRoutines } from "./routines/store.ts";
import type { PlanUsage } from "./runner/claude.ts";
import { findAgentRow } from "./store/conversations.ts";

/* Tudo o que a barra lateral mostra, numa chamada só. */

export type AgentState = "running" | "paused" | "idle";
export type TodayStatus = "done" | "failed" | "running" | "scheduled" | "skipped";

export type NeotermState = {
  agents: {
    slug: string;
    name: string;
    title: string;
    model: string | null;
    folders: string[];
    state: AgentState;
    /** As notas de quem usa sobre ele: se tem algo escrito e quantas tarefas (- [ ]) estão abertas. */
    notes: { has: boolean; openTasks: number };
  }[];
  problems: { slug: string; error: string }[];
  groups: { slug: string; folder: string; members: string[]; coordinator: string | null; busy: boolean; waiting: boolean }[];
  today: { at: string; time: string; routine: string; agent: string; group: string | null; status: TodayStatus }[];
  attention: AttentionItem[];
  planUsage: PlanUsage | null;
  timezone: string;
};

export async function buildState(core: Core, groupsEngine: GroupEngine, planUsage: PlanUsage | null): Promise<NeotermState> {
  const { db, engine } = core;
  const now = core.now();
  const settings = await readSettings();
  const { agents, problems } = await listAgents();
  const running = new Set(engine.running);
  const rows = await Promise.all(agents.map((agent) => findAgentRow(db, agent.slug)));
  const attention = await openAttention(db);
  const notes = await Promise.all(
    agents.map(async (agent) => {
      const text = await readFile(notesPath(agent.slug), "utf8").catch(() => "");
      return { has: text.trim().length > 0, openTasks: countTasks(text).open };
    }),
  );
  const waitingGroups = new Set(attention.filter((item) => item.kind === "group_waiting").map((item) => item.group));

  const groups = (await listGroups(db)).map((group) => ({
    slug: group.slug,
    folder: group.folder,
    members: group.members.map((member) => member.agent.slug),
    coordinator: group.members.find((member) => member.coordinator)?.agent.slug ?? null,
    busy: groupsEngine.isBusy(group.id),
    waiting: waitingGroups.has(group.slug),
  }));

  const enabled = (await listRoutines(db)).filter((routine) => routine.enabled);
  const { start } = dayBounds(now, settings.timezone);
  const recentRuns = enabled.length
    ? await db
        .select({ routineId: runs.routineId, status: runs.status, startedAt: runs.startedAt })
        .from(runs)
        .where(and(inArray(runs.routineId, enabled.map((routine) => routine.id)), gte(runs.startedAt, new Date(start.getTime() - 3_600_000))))
    : [];
  const today: NeotermState["today"] = [];
  for (const routine of enabled) {
    const bounds = dayBounds(now, routine.timezone);
    for (const at of occurrencesBetween(routine.cron, routine.timezone, bounds.start, bounds.end)) {
      // Uma vez de hoje antes da rotina existir (ou ser religada) não é uma vez perdida.
      if (at < routine.enabledAt) continue;
      const run = recentRuns.find(
        (candidate) =>
          candidate.routineId === routine.id &&
          candidate.startedAt.getTime() >= at.getTime() - 60_000 &&
          candidate.startedAt.getTime() <= at.getTime() + ROUTINE_GRACE_MS + 60_000,
      );
      let status: TodayStatus;
      if (run) status = run.status === "succeeded" ? "done" : run.status === "running" ? "running" : run.status === "skipped" ? "skipped" : "failed";
      else status = at > now ? "scheduled" : now.getTime() - at.getTime() < 60_000 ? "running" : "skipped";
      today.push({
        at: at.toISOString(),
        time: new Intl.DateTimeFormat("pt-BR", { timeZone: routine.timezone, hour: "2-digit", minute: "2-digit" }).format(at),
        routine: routine.title,
        agent: routine.agent,
        group: routine.group,
        status,
      });
    }
  }
  today.sort((a, b) => a.at.localeCompare(b.at));

  return {
    agents: agents.map((agent, index) => ({
      slug: agent.slug,
      name: agent.name,
      title: agent.title,
      model: agent.model ?? null,
      folders: agent.folders,
      state: running.has(agent.slug) ? "running" : rows[index]?.pausedAt ? "paused" : "idle",
      notes: notes[index] ?? { has: false, openTasks: 0 },
    })),
    problems: problems.map((problem) => ({ slug: problem.slug, error: problem.message })),
    groups,
    today,
    attention,
    planUsage,
    timezone: settings.timezone,
  };
}

