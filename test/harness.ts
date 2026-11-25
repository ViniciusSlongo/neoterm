import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Um neoterm de teste: pasta e banco próprios num diretório temporário, o "claude falso" no lugar do
 * Claude Code e o motor ouvindo numa porta livre. Os módulos leem as variáveis de ambiente ao
 * carregar, então este arquivo as define antes de importar qualquer coisa do neoterm.
 */

export const ROOT = mkdtempSync(join(tmpdir(), "neoterm-test-"));
export const HOME = join(ROOT, "home");
export const FAKE_STATE = join(ROOT, "fake");
export const SCRIPT_FILE = join(ROOT, "script.json");

process.env.NEOTERM_HOME = HOME;
process.env.NEOTERM_DATABASE = join(HOME, "neoterm.db");
process.env.NEOTERM_CLAUDE_BIN = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
process.env.FAKE_CLAUDE_STATE = FAKE_STATE;
process.env.FAKE_CLAUDE_SCRIPT = SCRIPT_FILE;
mkdirSync(HOME, { recursive: true });
writeFileSync(join(HOME, "config.json"), JSON.stringify({ defaultModel: "claude-haiku-5-5", timezone: "America/Sao_Paulo" }));

const { applyMigrations, connect } = await import("../src/db/client.ts");
const { Neoterm } = await import("../src/app.ts");
const { listen } = await import("../src/daemon/server.ts");
const { createAgent } = await import("../src/agents/identity.ts");

export type TestNeoterm = Awaited<ReturnType<typeof startNeoterm>>;

export async function startNeoterm(options: { now?: () => Date } = {}) {
  const connection = connect();
  await applyMigrations(connection);
  const neoterm = new Neoterm(connection.db, options);
  const { server, port } = await listen(neoterm, 0);
  const base = `http://127.0.0.1:${port}`;
  const api = async <T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  return {
    neoterm,
    db: connection.db,
    base,
    api,
    async close() {
      neoterm.stop();
      await new Promise((resolve) => server.close(resolve));
      connection.close();
    },
  };
}

/** Uma pasta do "computador" para o escopo de um agente. */
export function makeFolder(name: string): string {
  const repo = join(ROOT, "repos", name);
  mkdirSync(repo, { recursive: true });
  return repo;
}

export async function makeAgent(
  slug: string,
  extra: { name?: string; title?: string; role?: string; folders?: string[] } = {},
) {
  await createAgent({
    slug,
    folders: extra.folders ?? [makeFolder(slug)],
    name: extra.name ?? slug,
    title: extra.title ?? `Agente ${slug}`,
    role: extra.role ?? `Você é o agente ${slug} de teste.`,
  });
}

export function setScript(script: Record<string, string | string[]>): void {
  writeFileSync(SCRIPT_FILE, JSON.stringify(script));
}

export type FakeCall = { agent: string; cwd: string; args: string[]; prompt: string; system: string };

export function fakeCalls(): FakeCall[] {
  try {
    return readFileSync(join(FAKE_STATE, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall);
  } catch {
    return [];
  }
}

export function argOf(call: FakeCall, name: string): string | undefined {
  const index = call.args.indexOf(name);
  return index === -1 ? undefined : call.args[index + 1];
}

export async function waitFor<T>(check: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error("waitFor: o tempo acabou");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
