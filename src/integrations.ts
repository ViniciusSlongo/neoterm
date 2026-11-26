import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { listAgents } from "./agents/identity.ts";
import { CLAUDE_BIN } from "./config.ts";

/*
 * As integrações (servidores MCP), como o Claude Code as vê. O neoterm não guarda nem gerencia
 * nenhuma: quem lista e testa cada uma é o próprio `claude mcp list`; as dos projetos vêm do
 * .mcp.json de cada pasta de agente. Aqui só se mostra.
 *
 * SEM SEGREDOS. De uma URL fica só o endereço (o caminho e a query podem levar tokens); de um
 * comando, só o programa. Variáveis de ambiente e cabeçalhos nunca são lidos para exibir.
 */

export type IntegrationStatus = "connected" | "needs_auth" | "failed" | "pending" | "unchecked";

export type Integration = {
  name: string;
  /** `conta`: conector da conta claude.ai; `claude-code`: configurado no Claude Code; `projeto`: .mcp.json de uma pasta. */
  source: "conta" | "claude-code" | "projeto";
  /** Num de projeto, a pasta. */
  folder?: string;
  /** O endereço (só o host) ou o programa que roda. */
  target: string;
  status: IntegrationStatus;
};

export type Integrations = {
  checkedAt: string;
  servers: Integration[];
  /** Os agentes do neoterm rodam com --strict-mcp-config: só com as ferramentas do neoterm. */
  agentsUseThem: boolean;
  error?: string;
};

const STATUS: Record<string, IntegrationStatus> = { "✔": "connected", "✓": "connected", "!": "needs_auth", "✗": "failed", "✘": "failed", "⏸": "pending" };

/** Só o que dá para mostrar de um destino: o host de uma URL, o nome do programa de um comando. */
export function safeTarget(target: string): string {
  const trimmed = target.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return new URL(trimmed).host;
  } catch {
    // não é URL
  }
  const [program, ...args] = trimmed.split(/\s+/);
  if (!program) return "";
  // npx/uvx/node rodam um pacote ou script: o nome dele é o que identifica.
  const runner = ["npx", "uvx", "node", "bunx", "pnpm", "python", "python3", "docker"].includes(basename(program));
  const subject = runner ? args.find((arg) => !arg.startsWith("-")) : undefined;
  return subject ? `${basename(program)} ${subject}` : basename(program);
}

/** As linhas do `claude mcp list`: "nome: destino - ✔ Connected". */
export function parseMcpList(output: string): Integration[] {
  const servers: Integration[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?): (.+) - (✔|✓|!|✗|✘|⏸)/u.exec(line.trim());
    if (!match) continue;
    const [, rawName, target, symbol] = match as unknown as [string, string, string, string];
    const fromAccount = rawName.startsWith("claude.ai ");
    servers.push({
      name: fromAccount ? rawName.slice("claude.ai ".length) : rawName,
      source: fromAccount ? "conta" : "claude-code",
      target: safeTarget(target),
      status: STATUS[symbol] ?? "unchecked",
    });
  }
  return servers;
}

/** Os .mcp.json das pastas dos agentes: só os nomes e o destino, sem testar. */
async function projectServers(): Promise<Integration[]> {
  const { agents } = await listAgents();
  const folders = [...new Set(agents.flatMap((agent) => agent.folders))];
  const found: Integration[] = [];
  for (const folder of folders) {
    let config: { mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }> };
    try {
      config = JSON.parse(await readFile(join(folder, ".mcp.json"), "utf8"));
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      const target = server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
      found.push({ name, source: "projeto", folder, target: safeTarget(target), status: "unchecked" });
    }
  }
  return found;
}

const TTL_MS = 5 * 60_000;
let cache: { at: number; value: Integrations } | undefined;
let checking: Promise<Integrations> | undefined;

async function check(): Promise<Integrations> {
  const checkedAt = new Date().toISOString();
  const projects = await projectServers().catch(() => []);
  try {
    // Na home: as da conta e as do Claude Code (as de projeto vêm dos .mcp.json acima).
    const { stdout } = await promisify(execFile)(CLAUDE_BIN, ["mcp", "list"], { cwd: homedir(), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { checkedAt, servers: [...parseMcpList(stdout), ...projects], agentsUseThem: false };
  } catch (error) {
    return { checkedAt, servers: projects, agentsUseThem: false, error: `o claude mcp list falhou: ${(error as Error).message.split("\n")[0]}` };
  }
}

/**
 * As integrações. O `claude mcp list` testa cada uma e leva alguns segundos, então o resultado vale
 * por 5 minutos; `refresh` testa de novo. Duas telas pedindo ao mesmo tempo esperam o mesmo teste.
 */
export async function listIntegrations(options: { refresh?: boolean } = {}): Promise<Integrations> {
  if (!options.refresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  checking ??= check().finally(() => {
    checking = undefined;
  });
  const value = await checking;
  cache = { at: Date.now(), value };
  return value;
}
