import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isMissingFile, writeFileAtomic } from "../config.ts";
import { MEMORY_FILE } from "./identity.ts";

/*
 * A memória de um agente é o MEMORY.md dele: uma lista de fatos, um por linha, que vai no prompt de
 * cada turno. Ele acrescenta com `remember` e tira com `forget`; a pessoa pode editar à mão.
 */

export const MEMORY_LIMIT_BYTES = 16_000;

export class MemoryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRefused";
  }
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw error;
  }
}

export async function remember(agentDir: string, fact: string, now: Date, timeZone: string): Promise<string> {
  const line = fact.replace(/\s+/g, " ").trim();
  if (!line) throw new MemoryRefused("o fato está vazio");
  const path = join(agentDir, MEMORY_FILE);
  const current = await read(path);
  if (current.split("\n").some((existing) => existing.replace(/^- /, "").replace(/ \(\d\d\/\d\d\/\d{4}\)$/, "") === line)) {
    return "já estava na memória";
  }
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const next = `${current.trimEnd()}${current.trim() ? "\n" : ""}- ${line} (${date})\n`;
  if (Buffer.byteLength(next) > MEMORY_LIMIT_BYTES) {
    throw new MemoryRefused("a memória está cheia; esqueça (forget) o que não vale mais antes de guardar outra coisa");
  }
  await writeFileAtomic(path, next);
  return "guardado na memória";
}

/** Tira as linhas que contêm `text`. Devolve quantas saíram. */
export async function forget(agentDir: string, text: string): Promise<number> {
  const needle = text.trim().toLowerCase();
  if (!needle) throw new MemoryRefused("diga o que esquecer");
  const path = join(agentDir, MEMORY_FILE);
  const lines = (await read(path)).split("\n");
  const kept = lines.filter((line) => !line.toLowerCase().includes(needle));
  const removed = lines.length - kept.length;
  if (removed > 0) await writeFileAtomic(path, kept.join("\n"));
  return removed;
}
