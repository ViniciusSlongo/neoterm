import { spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { CLAUDE_BIN, NEOTERM_HOME } from "../config.ts";

/*
 * Um turno de um agente é uma execução do Claude Code oficial em modo não interativo (`claude -p`),
 * com o login que a pessoa já fez nele. O neoterm nunca toca em senha ou token.
 *
 * SEM PERMISSÕES: os agentes rodam com `--dangerously-skip-permissions`, como a pessoa rodaria o
 * Claude Code. Têm todas as ferramentas e nada pede confirmação. O escopo são as pastas: ele roda
 * na primeira, as outras entram com `--add-dir`, e o prompt diz para trabalhar só nelas.
 */

export type ClaudeTurn = {
  prompt: string;
  cwd: string;
  model: string;
  /** O esforço de raciocínio (--effort); sem isto, o padrão do Claude Code. */
  effort?: string;
  systemPrompt: string;
  addDirs: readonly string[];
  sessionId: string;
  /** Continuar a sessão `sessionId` em vez de começá-la. */
  resume: boolean;
  /**
   * O agente: vai no ambiente como NEOTERM_AGENT, e tudo o que ele rodar herda. É assim que o
   * neoterm acha depois os processos que ele deixou rodando, mesmo órfãos.
   */
  agent?: string;
  /** Mensagens novas durante o turno (a conversa com a pessoa): ele as lê no próximo passo. */
  input?: TurnInput;
  /** O servidor MCP do neoterm e a chave desta execução. */
  mcp?: { url: string; token: string };
  signal?: AbortSignal;
};

/** A variável de ambiente que marca os processos de um agente: `<agente>@<instância>`. */
export const AGENT_ENV = "NEOTERM_AGENT";

/**
 * Esta instância do neoterm (pela pasta dele), para dois neoterm na mesma máquina, ou os testes,
 * não verem os processos um do outro.
 */
export const INSTANCE = createHash("sha256").update(NEOTERM_HOME).digest("hex").slice(0, 8);

export function agentMarker(slug: string): string {
  return `${slug}@${INSTANCE}`;
}

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
  /** A sessão foi compactada (pelo autocompact) para caber na janela do modelo. */
  | { type: "compacted" }
  /** O Claude Code leu uma mensagem que chegou (o eco do --replay-user-messages). */
  | { type: "replay"; text: string }
  /** O agente leu uma mensagem mandada durante o turno (via `input`). */
  | { type: "injected"; text: string }
  | { type: "result"; ok: boolean; text: string; durationMs: number; context?: ContextUsage; queued?: number };

/**
 * A entrada de um turno em andamento. A mensagem que abre o turno e as que chegam depois vão em
 * stream-json; o Claude Code lê as novas no próximo passo (depois da ferramenta em curso) e
 * considera na mesma resposta. Uma que chega depois da resposta vira o turno seguinte dele.
 */
export class TurnInput {
  #write: ((text: string) => void) | null = null;
  #closed = false;
  /** Mandadas e ainda não lidas pelo agente, na ordem. */
  readonly pending: string[] = [];

  /** Liga a um processo do claude; as que esperam (de um processo que caiu) vão de novo. */
  attach(write: (text: string) => void): void {
    this.#write = write;
    for (const text of this.pending) write(text);
  }

  /** Manda uma mensagem para o turno; `false` se ele já terminou (aí ela vai para a fila normal). */
  send(text: string): boolean {
    if (this.#closed) return false;
    this.pending.push(text);
    this.#write?.(text);
    return true;
  }

  /** Fecha: não aceita mais nada. Devolve as que não chegaram a ser lidas. */
  close(): string[] {
    this.#closed = true;
    return this.pending.splice(0);
  }
}

/** Uma mensagem de quem usa, no formato do --input-format stream-json. */
export const userLine = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;

/** Quanto do contexto a sessão ocupa, depois da última chamada ao modelo, e o tamanho da janela. */
export type ContextUsage = { used: number; window: number };

/** O contexto do `result`: a última chamada ao modelo (entrada, cache e saída) e a janela dele. */
export function contextUsage(message: Record<string, unknown>): ContextUsage | undefined {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations.filter(isRecord) : [];
  const last = iterations.at(-1) ?? usage;
  if (!last) return undefined;
  const count = (key: string) => (typeof last[key] === "number" ? (last[key] as number) : 0);
  const used = count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens") + count("output_tokens");
  const models = isRecord(message.modelUsage) ? Object.values(message.modelUsage).filter(isRecord) : [];
  const window = Math.max(0, ...models.map((model) => (typeof model.contextWindow === "number" ? model.contextWindow : 0)));
  return used > 0 && window > 0 ? { used, window } : undefined;
}

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
    // A entrada também em stream-json: dá para mandar mensagens com o turno andando, e o eco diz
    // quando o agente leu cada uma.
    "--input-format",
    "stream-json",
    "--replay-user-messages",
    "--model",
    turn.model,
    // Compacta sozinho quando a conversa chega perto do limite da janela do modelo.
    "--autocompact",
    "auto",
    ...(turn.effort ? ["--effort", turn.effort] : []),
    "--append-system-prompt",
    turn.systemPrompt,
    // Por padrão o Claude Code grava o prompt de sistema na primeira mensagem e o reusa em toda
    // continuação, mesmo que depois venha outro texto. O neoterm monta o prompt a cada turno (o
    // AGENT.md editado, a memória nova, se é rotina ou conversa), então ele precisa ser lido de novo
    // a cada vez.
    "--system-prompt-snapshot",
    "off",
    "--dangerously-skip-permissions",
    // Sem os hooks, plugins e servidores MCP da sua configuração pessoal. A configuração da pasta
    // (o CLAUDE.md e o .claude/ do projeto) vale, como valeria para você ali.
    "--setting-sources",
    "project",
    "--strict-mcp-config",
  ];
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
  }
  for (const dir of turn.addDirs) args.push("--add-dir", dir);
  args.push(turn.resume ? "--resume" : "--session-id", turn.sessionId);
  return args;
}

export async function* runClaude(turn: ClaudeTurn): AsyncGenerator<ClaudeEvent> {
  const child = spawn(CLAUDE_BIN, claudeArgs(turn), {
    cwd: turn.cwd,
    ...(turn.agent ? { env: { ...process.env, [AGENT_ENV]: agentMarker(turn.agent) } } : {}),
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
  child.stdin.write(userLine(turn.prompt));
  // Sem `input`, ninguém manda mais nada: a entrada fecha e ele termina ao responder.
  const input = turn.input;
  if (input) input.attach((text) => child.stdin.write(userLine(text)));
  else child.stdin.end();

  let started = false;
  let finished = false;
  let openingEcho = true;
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
        if (event.type === "replay") {
          // O primeiro eco é a mensagem que abriu o turno; os outros, as mandadas depois.
          if (openingEcho) {
            openingEcho = false;
            continue;
          }
          const text = input?.pending.shift() ?? event.text;
          yield { type: "injected", text };
          continue;
        }
        if (event.type === "result") {
          // Ainda há mensagem mandada e não lida (ou um turno na fila dele): a resposta continua.
          if (input && (input.pending.length > 0 || (event.queued ?? 0) > 0)) continue;
          input?.close();
          child.stdin.end();
          finished = true;
        }
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
      if (message.subtype === "compact_boundary") yield { type: "compacted" };
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
      if (message.isReplay === true) {
        const inner = isRecord(message.message) ? message.message.content : undefined;
        const text =
          typeof inner === "string"
            ? inner
            : contentOf(message)
                .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
                .join("");
        yield { type: "replay", text };
        return;
      }
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
        ...(contextUsage(message) ? { context: contextUsage(message)! } : {}),
        ...(typeof message.queued_turn_count === "number" ? { queued: message.queued_turn_count } : {}),
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
    // Uma consulta a outro agente: para quem e o quê.
    if (pick("agent") && pick("question")) return truncate(firstLine(`→ ${pick("agent")}: ${pick("question")}`), 120);
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
