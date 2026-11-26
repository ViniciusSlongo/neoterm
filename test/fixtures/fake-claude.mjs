#!/usr/bin/env node
// Um `claude -p --output-format stream-json` de mentira, para testar o neoterm sem gastar o plano.
//
// O que ele faz vem de diretivas no prompt (ou nas respostas roteirizadas por agente em
// FAKE_CLAUDE_SCRIPT, um JSON { "Nome do agente": ["resposta 1", ...] | "sempre esta" }):
//   !ferramenta <Nome> <detalhe>   usa uma ferramenta, que dá certo
//   !negado <Nome> <detalhe>       usa uma ferramenta, que é negada
//   !mcp <ferramenta> <json>       chama uma ferramenta do neoterm pelo MCP de verdade
//   !sessao                        responde quantos prompts esta sessão já recebeu
//   !falhar <mensagem>             morre no meio, sem resultado
//   !erro <mensagem>               termina com resultado de erro
//   !dormir <ms>                   espera
//   !servico <ms>                  deixa um processo rodando em segundo plano (órfão) por <ms>
// O resto do texto é a resposta. Sem nada, responde "eco: <última linha do prompt>".
// Cada chamada é registrada em $FAKE_CLAUDE_STATE/calls.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
// `claude mcp list`: as integrações como o Claude Code mostraria (FAKE_MCP_LIST, ou um exemplo).
if (argv[0] === "mcp" && argv[1] === "list") {
  process.stdout.write(
    process.env.FAKE_MCP_LIST ??
      [
        "Checking MCP server health…",
        "",
        "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1?token=segredo - ✔ Connected",
        "claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication",
        "github: npx -y @modelcontextprotocol/server-github - ✗ Failed to connect",
        "",
      ].join("\n"),
  );
  process.exit(0);
}

const state = process.env.FAKE_CLAUDE_STATE ?? join(process.cwd(), ".fake-claude");
mkdirSync(join(state, "sessions"), { recursive: true });

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const system = option("--append-system-prompt") ?? "";
const agent = /Você é ([^,.\n]+)/.exec(system)?.[1]?.trim() ?? "agente";
const resume = option("--resume");
const sessionId = resume ?? option("--session-id") ?? "sem-sessao";
const sessionFile = join(state, "sessions", `${sessionId}.json`);
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

appendFileSync(
  join(state, "calls.jsonl"),
  `${JSON.stringify({ agent, cwd: process.cwd(), args: argv, prompt, system, at: Date.now() })}\n`,
);

if (resume && !existsSync(sessionFile)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
const history = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8")) : [];
history.push(prompt);
writeFileSync(sessionFile, JSON.stringify(history));

function scripted() {
  const file = process.env.FAKE_CLAUDE_SCRIPT;
  if (!file || !existsSync(file)) return undefined;
  const script = JSON.parse(readFileSync(file, "utf8"));
  const entry = script[agent];
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return entry;
  const counterFile = join(state, `counter-${agent}.txt`);
  const used = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;
  writeFileSync(counterFile, String(used + 1));
  return entry[used] ?? "(sem mais respostas no roteiro)";
}

const source = scripted() ?? prompt;
const tools = (option("--tools") ?? "").split(",").filter(Boolean);

out({ type: "system", subtype: "init", session_id: sessionId, model: option("--model") ?? "fake", tools, cwd: process.cwd() });
out({
  type: "rate_limit_event",
  rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1795649400 }, seven_day: { utilization: 0.2, resetsAt: 1795939200 } } },
});

let toolCounter = 0;
const useTool = (name, detail, error) => {
  const id = `toolu_${++toolCounter}`;
  const input = ["Read", "Write", "Edit"].includes(name) ? { file_path: detail } : name === "Bash" ? { command: detail } : { query: detail };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, session_id: sessionId });
  out({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: error ?? "ok", ...(error ? { is_error: true } : {}) }] },
    session_id: sessionId,
  });
};

async function callMcp(tool, args) {
  const config = JSON.parse(option("--mcp-config") ?? "{}");
  const server = config.mcpServers?.neoterm;
  if (!server) return "[sem servidor mcp]";
  const post = async (body) => {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...server.headers },
      body: JSON.stringify(body),
    });
    return response.status === 202 ? undefined : response.json();
  };
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  const id = `toolu_mcp_${++toolCounter}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__neoterm__${tool}`, input: args }] } });
  const text = result?.result?.content?.[0]?.text ?? JSON.stringify(result);
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(result?.result?.isError ? { is_error: true } : {}) }] } });
  return text;
}

const reply = [];
for (const line of source.split("\n")) {
  const directive = /^!(\S+)\s*(.*)$/.exec(line.trim());
  if (!directive) {
    if (scripted !== undefined && source !== prompt) reply.push(line);
    continue;
  }
  const [, name, rest] = directive;
  if (name === "ferramenta" || name === "negado") {
    const [tool, ...detail] = rest.split(" ");
    useTool(tool, detail.join(" "), name === "negado" ? "File is in a directory that is denied by your permission settings." : undefined);
  } else if (name === "mcp") {
    const space = rest.indexOf(" ");
    const tool = space === -1 ? rest : rest.slice(0, space);
    const args = space === -1 ? {} : JSON.parse(rest.slice(space + 1));
    reply.push(`[${tool}] ${await callMcp(tool, args)}`);
  } else if (name === "sessao") {
    reply.push(`sessão com ${history.length} mensagens`);
  } else if (name === "servico") {
    const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${Number(rest) || 60000})`], { detached: true, stdio: "ignore" });
    child.unref();
    reply.push(`servico ${child.pid}`);
  } else if (name === "dormir") {
    await sleep(Number(rest));
  } else if (name === "falhar") {
    process.stderr.write(`${rest}\n`);
    process.exit(1);
  } else if (name === "erro") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: rest, duration_ms: 5 });
    process.exit(0);
  }
}

let text = reply.join("\n").trim();
if (!text) {
  const lines = prompt.trim().split("\n").filter((line) => line.trim() && !line.trim().startsWith("!"));
  text = `eco: ${lines.at(-1) ?? ""}`;
}
out({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: sessionId });
out({ type: "result", subtype: "success", is_error: false, result: text, duration_ms: 12, session_id: sessionId });
