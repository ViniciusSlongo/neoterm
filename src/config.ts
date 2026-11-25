import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Onde mora tudo o que é do usuário: agentes, memória, configuração. */
export const NEOTERM_HOME =
  process.env.NEOTERM_HOME ?? join(homedir(), ".neoterm");
export const AGENTS_DIR = join(NEOTERM_HOME, "agents");
export const USER_FILE = join(NEOTERM_HOME, "USER.md");
const SETTINGS_FILE = join(NEOTERM_HOME, "config.json");

/** A raiz deste repositório: onde ficam as migrações. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const DATABASE_FILE = process.env.NEOTERM_DATABASE ?? join(NEOTERM_HOME, "neoterm.db");
export const DAEMON_PORT = Number(process.env.NEOTERM_PORT ?? 4777);
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
export const CLAUDE_BIN = process.env.NEOTERM_CLAUDE_BIN ?? "claude";

export const DEFAULT_MODEL = "claude-opus-5-5";

const Settings = z.object({
  defaultModel: z.string().min(1).default(DEFAULT_MODEL),
  timezone: z
    .string()
    .min(1)
    .default(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
});
export type Settings = z.infer<typeof Settings>;

export async function readSettings(): Promise<Settings> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return Settings.parse(raw);
}

export async function writeSettings(settings: Settings): Promise<void> {
  await writeFileAtomic(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Escreve num arquivo temporário e renomeia, para nunca deixar um arquivo pela metade. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
