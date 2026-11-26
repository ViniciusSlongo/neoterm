import { execFile } from "node:child_process";
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, asc, eq, gte, max } from "drizzle-orm";
import { agentDir, MEMORY_FILE } from "./agents/identity.ts";
import { NOTES_FILE } from "./agents/notes.ts";
import { DATABASE_FILE, NEOTERM_HOME } from "./config.ts";
import type { Core } from "./core.ts";
import { agents, followups, messages, type RunTrigger, runs } from "./db/schema.ts";
import { dayBounds } from "./routines/schedule.ts";
import { listRoutines } from "./routines/store.ts";
import type { NeotermState } from "./state.ts";

/*
 * O painel: um resumo do neoterm numa chamada só. O motor (memória dele e dos `claude` que ele
 * abriu), a máquina, o plano, o trabalho de hoje e da semana, cada agente (inclusive o tamanho da
 * memória dele, o MEMORY.md), rotinas, retornos e o que ocupa espaço em ~/.neoterm.
 */

const TRIGGERS: RunTrigger[] = ["chat", "routine", "followup", "group", "agent"];
const DAY_MS = 86_400_000;

export type Dashboard = {
  generatedAt: string;
  engine: {
    pid: number;
    uptimeMs: number;
    rssBytes: number;
    heapUsedBytes: number;
    /** Os `claude` rodando agora, abertos pelo motor, e quanto de memória usam juntos. */
    claude: { processes: number; rssBytes: number } | null;
    running: string[];
  };
  /** `usedMemBytes`: no macOS, como o Monitor de Atividade conta (apps + fixa + comprimida). */
  machine: { totalMemBytes: number; usedMemBytes: number; load: number[]; cpus: number; diskFreeBytes: number | null; diskTotalBytes: number | null };
  plan: NeotermState["planUsage"];
  today: {
    turns: number;
    succeeded: number;
    failed: number;
    byTrigger: Record<RunTrigger, number>;
    workMs: number;
    avgMs: number;
    messages: number;
    fromPerson: number;
  };
  /** Turnos por dia nos últimos 7 dias, o último é hoje. */
  week: { day: string; turns: number; failed: number }[];
  agents: {
    slug: string;
    state: NeotermState["agents"][number]["state"];
    turnsToday: number;
    failedToday: number;
    workMsToday: number;
    lastActivityAt: string | null;
    memoryBytes: number;
    memoryLines: number;
    notesBytes: number;
  }[];
  routines: {
    enabled: number;
    disabled: number;
    failing: { title: string; agent: string; streak: number }[];
    next: { title: string; agent: string; at: string }[];
  };
  followups: { pending: number; next: { agent: string; reason: string; dueAt: string } | null };
  attention: number;
  storage: { home: string; databaseBytes: number; imagesBytes: number; images: number; messages: number };
};

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function memoryFile(slug: string): Promise<{ bytes: number; lines: number }> {
  try {
    const text = await readFile(join(agentDir(slug), MEMORY_FILE), "utf8");
    return { bytes: Buffer.byteLength(text), lines: text.split("\n").filter((line) => line.trim()).length };
  } catch {
    return { bytes: 0, lines: 0 };
  }
}

/** Os processos abaixo do motor (os `claude` e o que eles abriram) e a memória somada deles. */
async function childProcesses(): Promise<{ processes: number; rssBytes: number } | null> {
  try {
    const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { timeout: 3000 });
    const rows: [number, number, number][] = [];
    for (const line of stdout.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      // O próprio `ps` aparece como filho do motor; não conta.
      // As ferramentas que o próprio painel roda para medir (ps, vm_stat…) aparecem como filhos; não contam.
      if (match && !/(^|\/)(ps|vm_stat|lsof|osascript)$/.test(match[4]!.trim())) rows.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    }
    const children = new Map<number, number[]>();
    for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    const rss = new Map(rows.map(([pid, , kb]) => [pid, kb * 1024]));
    const found = new Set<number>();
    const pending = [...(children.get(process.pid) ?? [])];
    while (pending.length > 0) {
      const pid = pending.pop()!;
      if (found.has(pid)) continue;
      found.add(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    // Um processo que já terminou e ainda não foi recolhido aparece com memória zero; não conta.
    const counted = [...found].filter((pid) => (rss.get(pid) ?? 0) > 0);
    return { processes: counted.length, rssBytes: counted.reduce((sum, pid) => sum + (rss.get(pid) ?? 0), 0) };
  } catch {
    return null;
  }
}

/**
 * A memória em uso na máquina. No macOS, `os.freemem()` só conta páginas totalmente livres e o
 * sistema usa o resto como cache, então parece sempre cheia; o `vm_stat` dá a conta de verdade.
 */
async function usedMemory(): Promise<number> {
  const fallback = totalmem() - freemem();
  if (process.platform !== "darwin") return fallback;
  try {
    const { stdout } = await promisify(execFile)("vm_stat", [], { timeout: 3000 });
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 4096);
    const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] ?? Number.NaN);
    const used = pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor");
    return Number.isFinite(used) && used > 0 ? used * pageSize : fallback;
  } catch {
    return fallback;
  }
}

async function imagesUsage(): Promise<{ bytes: number; count: number }> {
  const dir = join(NEOTERM_HOME, "imagens");
  try {
    const names = await readdir(dir);
    const sizes = await Promise.all(names.map((name) => sizeOf(join(dir, name))));
    return { bytes: sizes.reduce((sum, size) => sum + size, 0), count: names.length };
  } catch {
    return { bytes: 0, count: 0 };
  }
}

async function disk(): Promise<{ free: number | null; total: number | null }> {
  try {
    const info = await statfs(NEOTERM_HOME);
    return { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
  } catch {
    return { free: null, total: null };
  }
}

export async function buildDashboard(core: Core, state: NeotermState, startedAt: Date): Promise<Dashboard> {
  const { db } = core;
  const now = core.now();
  const { start } = dayBounds(now, state.timezone);
  const weekStart = dayBounds(new Date(start.getTime() - 6 * DAY_MS + DAY_MS / 2), state.timezone).start;

  const [rows, weekRuns, lastActivity, todayMessages, personMessages, totalMessages, pending, routineList, claude, usedMem, images, space] =
    await Promise.all([
      db.select({ id: agents.id, slug: agents.slug }).from(agents),
      db
        .select({ agentId: runs.agentId, trigger: runs.trigger, status: runs.status, durationMs: runs.durationMs, startedAt: runs.startedAt })
        .from(runs)
        .where(gte(runs.startedAt, weekStart)),
      db.select({ agentId: runs.agentId, at: max(runs.startedAt) }).from(runs).groupBy(runs.agentId),
      db.$count(messages, gte(messages.createdAt, start)),
      db.$count(messages, and(gte(messages.createdAt, start), eq(messages.author, "person"))),
      db.$count(messages),
      db.select().from(followups).where(eq(followups.status, "scheduled")).orderBy(asc(followups.dueAt)),
      listRoutines(db),
      childProcesses(),
      usedMemory(),
      imagesUsage(),
      disk(),
    ]);
  const slugOf = new Map(rows.map((row) => [row.id, row.slug]));

  const todayRuns = weekRuns.filter((run) => run.startedAt >= start);
  const finished = todayRuns.filter((run) => run.status === "succeeded" || run.status === "failed");
  const workMs = todayRuns.reduce((sum, run) => sum + (run.durationMs ?? 0), 0);
  const byTrigger = Object.fromEntries(TRIGGERS.map((trigger) => [trigger, todayRuns.filter((run) => run.trigger === trigger).length])) as Record<
    RunTrigger,
    number
  >;

  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: state.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const week: Dashboard["week"] = [];
  for (let back = 6; back >= 0; back--) {
    const key = dayKey.format(new Date(now.getTime() - back * DAY_MS));
    const ofDay = weekRuns.filter((run) => dayKey.format(run.startedAt) === key);
    week.push({ day: key, turns: ofDay.length, failed: ofDay.filter((run) => run.status === "failed").length });
  }

  const lastBySlug = new Map(lastActivity.map((row) => [slugOf.get(row.agentId), row.at]));
  const agentStats = await Promise.all(
    state.agents.map(async (agent) => {
      const mine = todayRuns.filter((run) => slugOf.get(run.agentId) === agent.slug);
      const memory = await memoryFile(agent.slug);
      const last = lastBySlug.get(agent.slug);
      return {
        slug: agent.slug,
        state: agent.state,
        turnsToday: mine.length,
        failedToday: mine.filter((run) => run.status === "failed").length,
        workMsToday: mine.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
        lastActivityAt: last ? new Date(last).toISOString() : null,
        memoryBytes: memory.bytes,
        memoryLines: memory.lines,
        notesBytes: await sizeOf(join(agentDir(agent.slug), NOTES_FILE)),
      };
    }),
  );

  const enabled = routineList.filter((routine) => routine.enabled);
  const nextFollowup = pending[0];
  const memory = process.memoryUsage();

  return {
    generatedAt: now.toISOString(),
    engine: {
      pid: process.pid,
      uptimeMs: now.getTime() - startedAt.getTime(),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      claude,
      running: state.agents.filter((agent) => agent.state === "running").map((agent) => agent.slug),
    },
    machine: { totalMemBytes: totalmem(), usedMemBytes: usedMem, load: loadavg(), cpus: cpus().length, diskFreeBytes: space.free, diskTotalBytes: space.total },
    plan: state.planUsage,
    today: {
      turns: todayRuns.length,
      succeeded: todayRuns.filter((run) => run.status === "succeeded").length,
      failed: todayRuns.filter((run) => run.status === "failed").length,
      byTrigger,
      workMs,
      avgMs: finished.length ? Math.round(finished.reduce((sum, run) => sum + (run.durationMs ?? 0), 0) / finished.length) : 0,
      messages: todayMessages,
      fromPerson: personMessages,
    },
    week,
    agents: agentStats,
    routines: {
      enabled: enabled.length,
      disabled: routineList.length - enabled.length,
      failing: routineList
        .filter((routine) => routine.failureStreak > 0)
        .map((routine) => ({ title: routine.title, agent: routine.agent, streak: routine.failureStreak })),
      next: enabled
        .toSorted((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
        .slice(0, 3)
        .map((routine) => ({ title: routine.title, agent: routine.agent, at: routine.nextRunAt.toISOString() })),
    },
    followups: {
      pending: pending.length,
      next: nextFollowup ? { agent: slugOf.get(nextFollowup.agentId) ?? "?", reason: nextFollowup.reason, dueAt: nextFollowup.dueAt.toISOString() } : null,
    },
    attention: state.attention.length,
    storage: {
      home: NEOTERM_HOME,
      databaseBytes: (await sizeOf(DATABASE_FILE)) + (await sizeOf(`${DATABASE_FILE}-wal`)),
      imagesBytes: images.bytes,
      images: images.count,
      messages: totalMessages,
    },
  };
}
