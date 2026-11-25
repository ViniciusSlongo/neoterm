import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AGENT_FILE } from "../agents/identity.ts";
import type { MessageMeta, MessagePart } from "../db/schema.ts";
import type { NeotermEvent, TurnEvent } from "../events.ts";
import type { NeotermState } from "../state.ts";
import { DaemonUnavailable, getJson, readEvents, request } from "./client.ts";
import { init } from "./init.ts";
import { accent, bold, fail, green, indent, muted, ok, red, seconds, yellow } from "./style.ts";

const HELP = `${bold("neoterm")} ${muted("· agentes no terminal, com o Claude Code do seu plano")}

  neoterm                               abre a interface
  neoterm init [--model <modelo>]       configura: Claude Code, banco, pastas
  neoterm daemon                        liga o motor (deixe rodando num terminal)

${muted("agentes")}
  neoterm agents
  neoterm agent new <nome> [--name <nome>] [--title <título>] [--role <função>] [--model <modelo>]
  neoterm agent pause|resume <nome>
  neoterm agent reset <nome> [--yes]    recomeça do zero (conversas, rotinas, memória)
  neoterm agent delete <nome> [--yes]   manda para ~/.neoterm/trash
  neoterm ask <agente> <mensagem>
  neoterm history <agente|#grupo> [--limit n]

${muted("rotinas")}
  neoterm routines [agente]
  neoterm routine add <agente> --title <nome> --cron "<0 9 * * 1-5>" --do "<o que fazer>" [--group <grupo>] [--notify]
  neoterm routine run|on|off|rm <id>

${muted("grupos")}
  neoterm groups
  neoterm group new <nome> --folder <pasta> --members a,b,c [--coordinator a] [--objective "<texto>"]
  neoterm group say <grupo> <mensagem>  escreve no grupo e acompanha a conversa

  neoterm attention                     o que precisa de você
`;

type MessageView = {
  author: "person" | "agent" | "routine" | "system";
  agent?: string | null;
  text: string;
  parts: MessagePart[];
  meta: MessageMeta;
  createdAt: string;
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined: {
      if (!process.stdout.isTTY) {
        console.log(HELP);
        return 0;
      }
      const { runTui } = await import("../tui/main.ts");
      await runTui();
      return 0;
    }
    case "init": {
      const { values } = parseArgs({ args: rest, options: { model: { type: "string" } } });
      return (await init(values.model ? { model: values.model } : {})) ? 0 : 1;
    }
    case "daemon": {
      const { startDaemon } = await import("../daemon/server.ts");
      await startDaemon();
      return -1;
    }
    case "agents":
      return agentsCommand();
    case "agent":
      return agentCommand(rest);
    case "ask":
      return askCommand(rest);
    case "history":
      return historyCommand(rest);
    case "routines":
      return routinesCommand(rest[0]);
    case "routine":
      return routineCommand(rest);
    case "groups":
      return groupsCommand();
    case "group":
      return groupCommand(rest);
    case "attention":
      return attentionCommand();
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`${fail(`comando desconhecido: ${command}`)}\n\n${HELP}`);
      return 1;
  }
}

const post = (path: string, body: unknown = {}, method = "POST") =>
  request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function confirm(question: string, yes: boolean | undefined): Promise<boolean> {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} ${muted("(s/N)")} `);
  rl.close();
  return /^s(im)?$/i.test(answer.trim());
}

function glyph(state: string): string {
  return state === "running" ? green("●") : state === "paused" ? yellow("‖") : muted("○");
}

async function agentsCommand(): Promise<number> {
  const state = await getJson<NeotermState>("/state");
  if (state.agents.length === 0 && state.problems.length === 0) {
    console.log(muted("nenhum agente ainda. Crie um com: neoterm agent new <nome>"));
    return 0;
  }
  const width = Math.max(...state.agents.map((agent) => agent.slug.length), 8);
  for (const agent of state.agents) {
    console.log(`${glyph(agent.state)} ${agent.slug.padEnd(width)}  ${muted(agent.title || agent.name)}`);
  }
  for (const problem of state.problems) console.log(fail(`${problem.slug}: ${problem.error}`));
  return 0;
}

async function agentCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      title: { type: "string" },
      role: { type: "string" },
      model: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
  });
  const [action, slug] = positionals;
  if (!action || !slug) {
    console.error(HELP);
    return 1;
  }
  switch (action) {
    case "new": {
      const { yes: _yes, ...fields } = values;
      const response = await post("/agents", { slug, ...fields });
      const { agent } = (await response.json()) as { agent: { slug: string; dir: string; workspace: string } };
      console.log(ok(`agente ${bold(agent.slug)} criado`));
      console.log(muted(`  função e escopo: ${join(agent.dir, AGENT_FILE)}`));
      console.log(muted(`  pasta de trabalho: ${agent.workspace}`));
      if (!values.role) console.log(`\n  Escreva a função dele no ${AGENT_FILE} antes de conversar.`);
      return 0;
    }
    case "pause":
    case "resume":
      await post(`/agents/${slug}/${action}`);
      console.log(ok(action === "pause" ? `${slug} pausado: rotinas e retornos esperam` : `${slug} retomado`));
      return 0;
    case "reset": {
      const { plan } = await getJson<{ plan: Record<string, number | boolean> }>(`/agents/${slug}/reset`);
      console.log(`Recomeçar ${bold(slug)} apaga:`);
      console.log(`  ${plan.conversations} conversa(s) com ${plan.messages} mensagem(ns)`);
      console.log(`  ${plan.routines} rotina(s) e ${plan.followups} retorno(s) agendado(s)`);
      console.log(`  ${plan.memory ? "a memória (MEMORY.md)" : "nada na memória"}; ${plan.groupSessions} sessão(ões) em grupos`);
      console.log(muted("  ficam: o AGENT.md e o que ele disse nos grupos"));
      if (!(await confirm("Recomeçar?", values.yes))) return 1;
      await post(`/agents/${slug}/reset`, { confirm: true });
      console.log(ok(`${slug} recomeçou do zero`));
      return 0;
    }
    case "delete": {
      if (!(await confirm(`Excluir ${bold(slug)}? A pasta vai para ~/.neoterm/trash.`, values.yes))) return 1;
      const response = await post(`/agents/${slug}`, { confirm: true }, "DELETE");
      const { trash } = (await response.json()) as { trash: string };
      console.log(ok(`${slug} excluído ${muted(`(${trash})`)}`));
      return 0;
    }
    default:
      console.error(HELP);
      return 1;
  }
}

function renderTurnEvent(event: TurnEvent, who?: string): boolean {
  switch (event.type) {
    case "start":
      console.log(`\n${bold(who ?? event.agent)}`);
      return false;
    case "tool":
      console.log(`  ${muted(`⎿ ${event.name.replace(/^mcp__neoterm__/, "").padEnd(5)}`)}  ${event.detail}`);
      return false;
    case "tool_error":
      console.log(`           ${red("✗")} ${muted(event.error)}`);
      return false;
    case "text":
      console.log(`\n${indent(event.text)}`);
      return false;
    case "done":
      console.log(`\n  ${muted(seconds(event.durationMs))}`);
      return false;
    case "error":
      console.log(`\n${fail(event.message)}`);
      return true;
  }
}

async function askCommand(args: string[]): Promise<number> {
  const [slug, ...words] = args;
  const text = words.join(" ").trim();
  if (!slug || !text) {
    console.error(HELP);
    return 1;
  }
  const response = await post(`/agents/${encodeURIComponent(slug)}/messages`, { text });
  if (!response.body) throw new Error("o motor não devolveu a resposta");
  let failed = false;
  for await (const { data } of readEvents(response.body)) {
    if (renderTurnEvent(JSON.parse(data) as TurnEvent)) failed = true;
  }
  console.log();
  return failed ? 1 : 0;
}

function renderMessage(message: MessageView): void {
  switch (message.author) {
    case "person":
      console.log(`\n${accent("›")} ${bold(message.text)}`);
      return;
    case "routine":
      console.log(`\n${accent(`◷ rotina ${message.meta.routineTitle ?? ""}`)}${message.agent ? muted(` · ${message.agent}`) : ""}`);
      console.log(muted(indent(message.text)));
      return;
    case "system":
      console.log(`\n${yellow("!")} ${muted(message.text)}`);
      return;
    case "agent":
      if (message.agent) console.log(`\n${bold(message.agent)}`);
      for (const part of message.parts) {
        if (part.type === "tool") {
          console.log(`  ${muted(`⎿ ${part.name.replace(/^mcp__neoterm__/, "").padEnd(5)}`)}  ${part.detail}`);
          if (part.error) console.log(`           ${red("✗")} ${muted(part.error)}`);
        } else {
          console.log(`\n${indent(part.text)}`);
        }
      }
      if (message.parts.length === 0) console.log(`\n${indent(message.text)}`);
  }
}

async function historyCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { limit: { type: "string", default: "20" } } });
  const [target] = positionals;
  if (!target) {
    console.error(HELP);
    return 1;
  }
  const limit = Number(values.limit) || 20;
  const path = target.startsWith("#")
    ? `/groups/${encodeURIComponent(target.slice(1))}/messages?limit=${limit}`
    : `/agents/${encodeURIComponent(target)}/messages?limit=${limit}`;
  const { messages } = await getJson<{ messages: MessageView[] }>(path);
  if (messages.length === 0) console.log(muted("conversa vazia"));
  for (const message of messages) renderMessage(message);
  console.log();
  return 0;
}

type RoutineView = {
  id: string;
  title: string;
  cron: string;
  timezone: string;
  mode: string;
  enabled: boolean;
  nextRunAt: string;
  failureStreak: number;
  agent: string;
  group: string | null;
};

async function routinesCommand(agent?: string): Promise<number> {
  const { describeCron, describeWhen } = await import("../routines/schedule.ts");
  const { routines } = await getJson<{ routines: RoutineView[] }>(`/routines${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`);
  if (routines.length === 0) {
    console.log(muted("nenhuma rotina"));
    return 0;
  }
  for (const routine of routines) {
    const state = routine.enabled ? green("●") : muted("○");
    const next = routine.enabled ? describeWhen(new Date(routine.nextRunAt), routine.timezone) : routine.failureStreak >= 10 ? red("desligada após 10 falhas") : "desligada";
    console.log(
      `${state} ${bold(routine.title)} ${muted(`· ${routine.agent}${routine.group ? ` em #${routine.group}` : ""} · ${describeCron(routine.cron)} · ${routine.mode === "notify" ? "só avisa" : "age"} ·`)} ${next}`,
    );
    console.log(muted(`  ${routine.id}`));
  }
  return 0;
}

async function routineCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      cron: { type: "string" },
      do: { type: "string" },
      group: { type: "string" },
      timezone: { type: "string" },
      notify: { type: "boolean" },
    },
  });
  const [action, target] = positionals;
  if (!action || !target) {
    console.error(HELP);
    return 1;
  }
  if (action === "add") {
    if (!values.title || !values.cron || !values.do) {
      console.error(fail("diga --title, --cron e --do"));
      return 1;
    }
    const response = await post("/routines", {
      agent: target,
      title: values.title,
      cron: values.cron,
      instruction: values.do,
      ...(values.group ? { group: values.group } : {}),
      ...(values.timezone ? { timezone: values.timezone } : {}),
      mode: values.notify ? "notify" : "act",
    });
    const { routine } = (await response.json()) as { routine: RoutineView };
    const { describeCron, describeWhen } = await import("../routines/schedule.ts");
    console.log(ok(`rotina ${bold(routine.title)} · ${describeCron(routine.cron)} · próxima ${describeWhen(new Date(routine.nextRunAt), routine.timezone)}`));
    return 0;
  }
  const actions: Record<string, () => Promise<Response>> = {
    run: () => post(`/routines/${target}/run`),
    on: () => post(`/routines/${target}`, { enabled: true }, "PATCH"),
    off: () => post(`/routines/${target}`, { enabled: false }, "PATCH"),
    rm: () => post(`/routines/${target}`, {}, "DELETE"),
  };
  const run = actions[action];
  if (!run) {
    console.error(HELP);
    return 1;
  }
  await run();
  console.log(ok({ run: "disparada", on: "ligada", off: "desligada", rm: "apagada" }[action] ?? "feito"));
  return 0;
}

async function groupsCommand(): Promise<number> {
  const state = await getJson<NeotermState>("/state");
  if (state.groups.length === 0) console.log(muted("nenhum grupo. Crie um com: neoterm group new <nome> --folder <pasta> --members a,b"));
  for (const group of state.groups) {
    const status = group.busy ? green("●") : group.waiting ? yellow("!") : muted("#");
    console.log(`${status} ${bold(group.slug)} ${muted(`· ${group.members.join(", ")} · ${group.folder}`)}`);
  }
  return 0;
}

async function groupCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      folder: { type: "string" },
      members: { type: "string" },
      coordinator: { type: "string" },
      objective: { type: "string" },
      timeout: { type: "string", default: "900" },
    },
  });
  const [action, slug, ...words] = positionals;
  if (action === "new" && slug) {
    if (!values.folder || !values.members) {
      console.error(fail("diga --folder e --members"));
      return 1;
    }
    await post("/groups", {
      slug,
      folder: values.folder,
      members: values.members.split(",").map((member) => member.trim()).filter(Boolean),
      ...(values.coordinator ? { coordinator: values.coordinator } : {}),
      ...(values.objective ? { objective: values.objective } : {}),
    });
    console.log(ok(`grupo ${bold(`#${slug}`)} criado`));
    return 0;
  }
  if (action === "say" && slug && words.length > 0) {
    return groupSay(slug.replace(/^#/, ""), words.join(" "), Number(values.timeout) * 1000);
  }
  console.error(HELP);
  return 1;
}

/** Escreve no grupo e mostra a conversa enquanto os agentes falam. */
async function groupSay(slug: string, text: string, timeoutMs: number): Promise<number> {
  const controller = new AbortController();
  const events = await request("/events", { signal: controller.signal });
  const posted = await post(`/groups/${slug}/messages`, { text });
  const { responders } = (await posted.json()) as { responders: string[] };
  console.log(muted(`→ ${responders.join(", ")}`));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let speaker = "";
  try {
    for await (const { data } of readEvents(events.body!)) {
      const event = JSON.parse(data) as NeotermEvent | Record<string, never>;
      if (!("type" in event)) continue;
      if (event.type === "turn" && event.scope.kind === "group" && event.scope.slug === slug) {
        if (event.event.type === "start") speaker = event.agent;
        renderTurnEvent(event.event, speaker);
      }
      if (event.type === "changed" && event.what === "groups") {
        const state = await getJson<NeotermState>("/state");
        const group = state.groups.find((candidate) => candidate.slug === slug);
        if (group && !group.busy) break;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  const state = await getJson<NeotermState>("/state");
  if (state.groups.find((group) => group.slug === slug)?.waiting) console.log(`\n${yellow("!")} o grupo está esperando você`);
  console.log();
  return 0;
}

async function attentionCommand(): Promise<number> {
  const state = await getJson<NeotermState>("/state");
  if (state.attention.length === 0) console.log(muted("nada precisa de você"));
  for (const item of state.attention) console.log(`${yellow("!")} ${item.text} ${muted(`· ${item.id}`)}`);
  return 0;
}

try {
  const code = await main(process.argv.slice(2));
  if (code >= 0) process.exitCode = code;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof DaemonUnavailable ? `${yellow("!")} ${message}` : fail(message));
  process.exitCode = 1;
}
