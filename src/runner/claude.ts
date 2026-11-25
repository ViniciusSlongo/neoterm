import { spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import { CLAUDE_BIN } from "../config.ts";

/*
 * Um turno de um agente é uma execução do Claude Code oficial em modo não interativo (`claude -p`),
 * com o login que a pessoa já fez nele. O neoterm nunca toca em senha ou token.
 *
 * O ESCOPO É `--tools`, NÃO `--allowedTools`. `--tools` decide quais ferramentas existem na sessão;
 * a lista de liberadas só decide o que roda sem perguntar, e o Claude Code libera sozinho comandos
 * de leitura (um `date` roda mesmo sem Bash liberado). Então o que o agente não pode usar, ele
 * nem tem.
 */

export type ClaudeTurn = {
  prompt: string;
  cwd: string;
  model: string;
  systemPrompt: string;
  /** As ferramentas que existem nesta sessão, todas liberadas. */
  tools: readonly string[];
  /** Regras que recusam dentro delas, como editar numa pasta só de leitura. */
  disallowed: readonly string[];
  addDirs: readonly string[];
  sessionId: string;
  /** Continuar a sessão `sessionId` em vez de começá-la. */
  resume: boolean;
  /** O servidor MCP do neoterm e a chave desta execução. */
  mcp?: { url: string; token: string };
  signal?: AbortSignal;
};

/** O nome com que as ferramentas do neoterm aparecem para o agente: mcp__neoterm__<nome>. */
export const MCP_SERVER_NAME = "neoterm";

/** Quanto do plano já foi usado, como o Claude Code informa a cada turno. */
export type PlanUsage = {
  fiveHour?: { utilization: number; resetsAt: Date };
  sevenDay?: { utilization: number; resetsAt: Date };
};

export type ClaudeEvent =
  | { type: "init"; sessionId: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; detail: string }
  | { type: "tool_result"; id: string; error?: string }
  | { type: "plan_usage"; usage: PlanUsage }
  | { type: "result"; ok: boolean; text: string; durationMs: number };

export class ClaudeError extends Error {
  readonly exitCode: number | null;
  /** Se a sessão chegou a começar; sem isso, um `--resume` pode ter falhado por sessão inexistente. */
  readonly started: boolean;
  constructor(message: string, exitCode: number | null, started: boolean) {
    super(message);
    this.name = "ClaudeError";
    this.exitCode = exitCode;
    this.started = started;
  }
}

export function claudeArgs(turn: ClaudeTurn): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    turn.model,
    "--append-system-prompt",
    turn.systemPrompt,
    // Por padrão o Claude Code grava o prompt de sistema na primeira mensagem e o reusa em toda
    // continuação, mesmo que depois venha outro texto. O neoterm monta o prompt a cada turno (o
    // AGENT.md editado, a memória nova, se é rotina ou conversa, as ferramentas desta execução),
    // então ele precisa ser lido de novo a cada vez.
    "--system-prompt-snapshot",
    "off",
    "--tools",
    turn.tools.join(","),
    // Ninguém responde pedidos de permissão: o que precisaria perguntar é negado na hora.
    "--permission-prompts",
    "none",
    // Sem hooks, plugins e servidores MCP da pessoa: o agente tem só o que o AGENT.md dá.
    "--setting-sources",
    "project",
    "--strict-mcp-config",
  ];
  const allowed = [...turn.tools];
  if (turn.mcp) {
    args.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "http",
            url: turn.mcp.url,
            headers: { Authorization: `Bearer ${turn.mcp.token}` },
          },
        },
      }),
    );
    allowed.push(`mcp__${MCP_SERVER_NAME}`);
  }
  if (allowed.length > 0) args.push("--allowedTools", ...allowed);
  if (turn.disallowed.length > 0) args.push("--disallowedTools", ...turn.disallowed);
  for (const dir of turn.addDirs) args.push("--add-dir", dir);
  args.push(turn.resume ? "--resume" : "--session-id", turn.sessionId);
  return args;
}

export async function* runClaude(turn: ClaudeTurn): AsyncGenerator<ClaudeEvent> {
  const child = spawn(CLAUDE_BIN, claudeArgs(turn), {
    cwd: turn.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    ...(turn.signal ? { signal: turn.signal } : {}),
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  exited.catch(() => {});
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(turn.prompt);

  let started = false;
  let finished = false;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of toEvents(message, turn.cwd)) {
        if (event.type === "init") started = true;
        if (event.type === "result") finished = true;
        yield event;
      }
    }
    let code: number | null;
    try {
      code = await exited;
    } catch (error) {
      throw new ClaudeError(spawnFailure(error), null, started);
    }
    if (!finished) {
      throw new ClaudeError(
        stderr.trim() || `o claude terminou sem resposta (código ${code})`,
        code,
        started,
      );
    }
  } finally {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

function spawnFailure(error: unknown): string {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return `não encontrei o "${CLAUDE_BIN}". Instale o Claude Code e faça login (claude, depois /login).`;
  }
  return error instanceof Error ? error.message : String(error);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentOf(message: Json): Json[] {
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return [];
  return inner.content.filter(isRecord);
}

/** Uma linha do stream-json do Claude Code, traduzida no que o neoterm mostra e guarda. */
export function* toEvents(message: unknown, cwd: string): Generator<ClaudeEvent> {
  if (!isRecord(message)) return;
  switch (message.type) {
    case "system":
      if (message.subtype === "init" && typeof message.session_id === "string") {
        yield { type: "init", sessionId: message.session_id, model: String(message.model ?? "") };
      }
      return;
    case "assistant":
      for (const block of contentOf(message)) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          yield { type: "text", text: block.text };
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "ferramenta");
          yield { type: "tool", id: String(block.id ?? ""), name, detail: describeToolInput(name, block.input, cwd) };
        }
      }
      return;
    case "user":
      for (const block of contentOf(message)) {
        if (block.type !== "tool_result") continue;
        const id = String(block.tool_use_id ?? "");
        yield block.is_error === true
          ? { type: "tool_result", id, error: firstLine(resultText(block.content)) }
          : { type: "tool_result", id };
      }
      return;
    case "rate_limit_event": {
      const usage = planUsage(message.rate_limit_info);
      if (usage) yield { type: "plan_usage", usage };
      return;
    }
    case "result":
      yield {
        type: "result",
        ok: message.subtype === "success" && message.is_error !== true,
        text: typeof message.result === "string" ? message.result : "",
        durationMs: Number(message.duration_ms ?? 0),
      };
      return;
  }
}

/** Uma linha que diga o que a ferramenta fez: o arquivo, o comando, a busca. */
export function describeToolInput(name: string, input: unknown, cwd: string): string {
  if (!isRecord(input)) return "";
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  };
  const path = pick("file_path", "notebook_path", "path");
  let detail: string;
  if (name.startsWith("mcp__")) {
    // As ferramentas do neoterm: o nome da rotina, o fato, o motivo; e o horário, se houver.
    const minutes = typeof input.minutes === "number" ? `em ${input.minutes} min` : undefined;
    detail = [pick("title", "routine", "fact", "text", "tool"), pick("cron"), minutes, pick("reason")]
      .filter(Boolean)
      .join(" · ");
    return truncate(firstLine(detail || JSON.stringify(input)), 120);
  }
  switch (name) {
    case "Bash":
      detail = pick("command") ?? "";
      break;
    case "Glob":
    case "Grep":
      detail = [pick("pattern"), path ? shortPath(path, cwd) : undefined].filter(Boolean).join("  em ");
      break;
    case "WebSearch":
      detail = pick("query") ?? "";
      break;
    case "WebFetch":
      detail = pick("url") ?? "";
      break;
    default:
      detail = path ? shortPath(path, cwd) : (pick("description", "prompt", "query") ?? JSON.stringify(input));
  }
  return truncate(firstLine(detail), 120);
}

function shortPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function planUsage(info: unknown): PlanUsage | undefined {
  if (!isRecord(info) || !isRecord(info.unifiedWindows)) return undefined;
  const windowOf = (value: unknown) =>
    isRecord(value) && typeof value.utilization === "number" && typeof value.resetsAt === "number"
      ? { utilization: value.utilization, resetsAt: new Date(value.resetsAt * 1000) }
      : undefined;
  const fiveHour = windowOf(info.unifiedWindows.five_hour);
  const sevenDay = windowOf(info.unifiedWindows.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
