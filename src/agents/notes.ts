import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFile, writeFileAtomic } from "../config.ts";
import { AGENT_FILE, AgentNotFound, agentDir, isValidSlug } from "./identity.ts";

/*
 * As notas de quem usa sobre um agente: um texto livre em ~/.neoterm/agents/<slug>/notas.txt,
 * aberto na interface com :notes. São da pessoa, não do agente: não entram no prompt dele.
 */

export const NOTES_FILE = "notas.txt";

/** Até onde as notas vão; um arquivo de texto de anotações não passa disso. */
export const NOTES_MAX_LENGTH = 1_000_000;

export function notesPath(slug: string): string {
  return join(agentDir(slug), NOTES_FILE);
}

/** As notas valem para um agente que existe, mesmo com algum problema nas pastas dele. */
async function ensureAgent(slug: string): Promise<void> {
  if (!isValidSlug(slug)) throw new AgentNotFound(slug);
  try {
    await access(join(agentDir(slug), AGENT_FILE));
  } catch {
    throw new AgentNotFound(slug);
  }
}

export async function readNotes(slug: string): Promise<{ text: string; path: string }> {
  await ensureAgent(slug);
  const path = notesPath(slug);
  try {
    return { text: await readFile(path, "utf8"), path };
  } catch (error) {
    if (isMissingFile(error)) return { text: "", path };
    throw error;
  }
}

export async function writeNotes(slug: string, text: string): Promise<void> {
  await ensureAgent(slug);
  await writeFileAtomic(notesPath(slug), text);
}
