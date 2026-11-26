import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/*
 * O navegador de arquivos do :path. Mostra só o escopo da conversa (as pastas do agente, ou a do
 * grupo): não sobe acima delas. Com mais de uma pasta, o topo é a lista delas.
 */

export type Entry = { name: string; path: string; dir: boolean };

/** O conteúdo de uma pasta: pastas primeiro, depois arquivos, em ordem alfabética. */
export async function listDir(path: string, showHidden: boolean): Promise<Entry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name), dir: entry.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "pt-BR", { numeric: true }) : a.dir ? -1 : 1));
}

/** O topo do escopo, quando ele tem mais de uma pasta: cada uma como uma entrada. */
export function rootEntries(roots: readonly string[]): Entry[] {
  return roots.map((root) => ({ name: root, path: root, dir: true }));
}

/** As entradas cujo nome contém o filtro (sem diferenciar maiúsculas e acentos). */
export function filterEntries(entries: readonly Entry[], filter: string): Entry[] {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wanted = fold(filter.trim());
  return wanted ? entries.filter((entry) => fold(entry.name).includes(wanted)) : [...entries];
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A pasta de cima, ou `null` no topo do escopo (a lista das pastas, se houver várias). */
export function parentOf(path: string, roots: readonly string[]): string | null {
  if (roots.includes(path)) return null;
  const up = dirname(path);
  return roots.some((root) => inside(up, root)) ? up : null;
}

/**
 * Como o caminho entra na mensagem: relativo à pasta onde o agente roda (a primeira do escopo),
 * que é de onde ele parte; fora dela, completo. Com espaço no nome, entre aspas.
 */
export function referenceFor(path: string, workspace: string): string {
  const rel = relative(workspace, path);
  const text = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  return /\s/.test(text) ? `"${text}"` : text;
}

/** Um arquivo para mostrar: relativo à pasta do agente, se estiver nela; senão, com ~. */
export function displayFile(path: string, workspace: string): string {
  const rel = relative(workspace, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path.replace(homedir(), "~");
}

/**
 * Os arquivos que o agente leu ou mexeu (o detalhe das ferramentas Read, Edit, Write…), do mais
 * recente para o mais antigo, sem repetir e só os que ainda existem.
 */
export function recentFiles(details: readonly string[], workspace: string, limit = 8): Entry[] {
  const found: Entry[] = [];
  const seen = new Set<string>();
  for (const detail of details) {
    if (found.length >= limit) break;
    // Um detalhe cortado (…) não é um caminho inteiro.
    if (!detail || detail.endsWith("…")) continue;
    const path = detail.startsWith("~/") ? join(homedir(), detail.slice(2)) : isAbsolute(detail) ? detail : join(workspace, detail);
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    found.push({ name: displayFile(path, workspace), path, dir: false });
  }
  return found;
}

/** O caminho para mostrar no topo do navegador: a partir do nome da pasta do escopo. */
export function displayPath(path: string | null, roots: readonly string[]): string {
  if (path === null) return "pastas";
  const root = roots.find((candidate) => inside(path, candidate));
  if (!root) return path;
  const rel = relative(root, path);
  return rel ? `${basename(root)}${sep}${rel}` : basename(root);
}
