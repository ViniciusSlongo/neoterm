import { join } from "node:path";
import { parseArgs } from "node:util";
import { AGENT_FILE, createAgent } from "../agents/identity.ts";
import type { MessagePart } from "../db/schema.ts";
import type { TurnEvent } from "../runner/turn.ts";
import { DaemonUnavailable, getJson, readEvents, request } from "./client.ts";
import { init } from "./init.ts";
import { accent, bold, fail, green, indent, muted, ok, red, seconds, yellow } from "./style.ts";

const HELP = `${bold("neoterm")} ${muted("· agentes no terminal, com o Claude Code do seu plano")}

  neoterm init [--model <modelo>]       configura: Claude Code, banco, pastas
  neoterm daemon                        liga o motor (deixe rodando num terminal)

  neoterm agents                        lista os agentes
  neoterm agent new <nome> [--name <nome>] [--title <título>] [--role <função>] [--model <modelo>]
  neoterm ask <agente> <mensagem>       manda uma mensagem e acompanha a resposta
  neoterm history <agente> [--limit n]  mostra a conversa
`;

type AgentSummary = { slug: string; name: string; title: string; state: "idle" | "running" | "paused" };
type MessageView = { author: "person" | "agent"; text: string; parts: MessagePart[]; createdAt: string };

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init": {
      const { values } = parseArgs({ args: rest, options: { model: { type: "string" } } });
      return (await init(values.model ? { model: values.model } : {})) ? 0 : 1;
    }
    case "daemon": {
      const { startDaemon } = await import("../daemon/server.ts");
      await startDaemon();
      return -1; // continua rodando
    }
    case "agents":
      return listAgentsCommand();
    case "agent":
      return agentCommand(rest);
    case "ask":
      return askCommand(rest);
    case "history":
      return historyCommand(rest);
    case undefined:
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

async function listAgentsCommand(): Promise<number> {
  const { agents, problems } = await getJson<{ agents: AgentSummary[]; problems: { slug: string; error: string }[] }>(
    "/agents",
  );
  if (agents.length === 0 && problems.length === 0) {
    console.log(muted("nenhum agente ainda. Crie um com: neoterm agent new <nome>"));
    return 0;
  }
  const width = Math.max(...agents.map((agent) => agent.slug.length), 8);
  for (const agent of agents) {
    const glyph = agent.state === "running" ? green("●") : agent.state === "paused" ? yellow("‖") : muted("○");
    console.log(`${glyph} ${agent.slug.padEnd(width)}  ${muted(agent.title || agent.name)}`);
  }
  for (const problem of problems) console.log(fail(`${problem.slug}: ${problem.error}`));
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
    },
  });
  const [action, slug] = positionals;
  if (action !== "new" || !slug) {
    console.error(HELP);
    return 1;
  }
  const agent = await createAgent({ slug, ...values });
  console.log(ok(`agente ${bold(agent.slug)} criado`));
  console.log(muted(`  função e escopo: ${join(agent.dir, AGENT_FILE)}`));
  console.log(muted(`  pasta de trabalho: ${agent.workspace}`));
  if (!values.role) console.log(`\n  Escreva a função dele no ${AGENT_FILE} antes de conversar.`);
  return 0;
}

async function askCommand(args: string[]): Promise<number> {
  const [slug, ...words] = args;
  const text = words.join(" ").trim();
  if (!slug || !text) {
    console.error(HELP);
    return 1;
  }
  const response = await request(`/agents/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.body) throw new Error("o motor não devolveu a resposta");
  let failed = false;
  for await (const { data } of readEvents(response.body)) {
    const event = JSON.parse(data) as TurnEvent;
    switch (event.type) {
      case "start":
        console.log(`\n${bold(event.agent)}`);
        break;
      case "tool":
        console.log(`  ${muted(`⎿ ${event.name.padEnd(5)}`)}  ${event.detail}`);
        break;
      case "tool_error":
        console.log(`           ${red("✗")} ${muted(event.error)}`);
        break;
      case "text":
        console.log(`\n${indent(event.text)}`);
        break;
      case "done":
        console.log(`\n  ${muted(seconds(event.durationMs))}\n`);
        break;
      case "error":
        failed = true;
        console.log(`\n${fail(event.message)}\n`);
        break;
    }
  }
  return failed ? 1 : 0;
}

async function historyCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { limit: { type: "string", default: "20" } },
  });
  const [slug] = positionals;
  if (!slug) {
    console.error(HELP);
    return 1;
  }
  const { messages } = await getJson<{ messages: MessageView[] }>(
    `/agents/${encodeURIComponent(slug)}/messages?limit=${Number(values.limit) || 20}`,
  );
  if (messages.length === 0) console.log(muted("conversa vazia"));
  for (const message of messages) {
    if (message.author === "person") {
      console.log(`\n${accent("›")} ${bold(message.text)}`);
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "tool") {
        console.log(`  ${muted(`⎿ ${part.name.padEnd(5)}`)}  ${part.detail}`);
        if (part.error) console.log(`           ${red("✗")} ${muted(part.error)}`);
      } else {
        console.log(`\n${indent(part.text)}`);
      }
    }
    if (message.parts.length === 0) console.log(`\n${indent(message.text)}`);
  }
  console.log();
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
