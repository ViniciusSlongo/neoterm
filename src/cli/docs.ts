import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../config.ts";
import { accent, bold, fail, muted } from "./style.ts";

/*
 * `neoterm docs`: lista os docs (docs/*.md) e mostra um no terminal. Cada doc começa com
 * `# Título` e uma linha `> resumo`; o número na frente do nome do arquivo é a ordem.
 */

export const DOCS_DIR = join(REPO_ROOT, "docs");

export type Doc = { number: number; name: string; file: string; title: string; summary: string };

export async function listDocs(dir = DOCS_DIR): Promise<Doc[]> {
  const files = (await readdir(dir)).filter((file) => /^\d+-.+\.md$/.test(file)).sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(dir, file), "utf8");
      const [, number = "0", name = file] = /^(\d+)-(.+)\.md$/.exec(file) ?? [];
      return {
        number: Number(number),
        name,
        file: join(dir, file),
        title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name,
        summary: /^>\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "",
      };
    }),
  );
}

/** Um doc pelo nome ("agentes"), número ("4") ou começo do nome ("seg"), sem ligar para acentos. */
export function findDoc(docs: readonly Doc[], query: string): Doc | undefined {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wanted = fold(query.trim());
  if (/^\d+$/.test(wanted)) return docs.find((doc) => doc.number === Number(wanted));
  return (
    docs.find((doc) => doc.name === wanted) ??
    docs.find((doc) => doc.name.startsWith(wanted)) ??
    docs.find((doc) => fold(doc.title).includes(wanted))
  );
}

/** Tabelas markdown com as colunas alinhadas. */
function alignTables(lines: string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < lines.length; ) {
    if (!/^\|.*\|\s*$/.test(lines[at]!)) {
      out.push(lines[at++]!);
      continue;
    }
    const block: string[][] = [];
    while (at < lines.length && /^\|.*\|\s*$/.test(lines[at]!)) {
      const cells = lines[at++]!.trim().slice(1, -1).split("|").map((cell) => cell.trim());
      if (!cells.every((cell) => /^:?-+:?$/.test(cell))) block.push(cells);
    }
    const plain = (cell: string) => cell.replace(/`|\*\*/g, "");
    const widths = block[0]!.map((_, column) => Math.max(...block.map((row) => plain(row[column] ?? "").length)));
    block.forEach((row, index) => {
      const line = row.map((cell, column) => cell + " ".repeat(Math.max(widths[column]! - plain(cell).length, 0))).join("   ");
      out.push(index === 0 ? `  ${muted(plain(line))}` : `  ${line}`);
    });
  }
  return out;
}

/** O markdown com um pouco de cor: títulos, `código`, **negrito**, tabelas e blocos de código. */
export function renderForTerminal(text: string): string {
  let inCode = false;
  return alignTables(text.split("\n"))
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        return "";
      }
      if (inCode) return `    ${accent(line)}`;
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) return heading[1]!.length === 1 ? `\n${bold(accent(heading[2]!.toUpperCase()))}` : `\n${bold(heading[2]!)}`;
      if (/^>\s/.test(line)) return muted(line.replace(/^>\s/, ""));
      return line
        .replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => bold(inner))
        .replace(/`([^`]+)`/g, (_, inner: string) => accent(inner))
        .replace(/^(\s*)- /, "$1• ");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Mostra pelo `less` quando a saída é um terminal (sai sozinho se couber na tela). */
async function page(text: string): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${text}\n`);
    return;
  }
  await new Promise<void>((resolve) => {
    const pager = spawn(process.env.PAGER?.trim() || "less", ["-RFX"], { stdio: ["pipe", "inherit", "inherit"] });
    pager.on("error", () => {
      process.stdout.write(`${text}\n`);
      resolve();
    });
    pager.on("close", () => resolve());
    pager.stdin.end(`${text}\n`);
  });
}

export async function docsCommand(args: string[]): Promise<number> {
  const docs = await listDocs();
  const query = args.join(" ").trim();
  if (!query) {
    const width = Math.max(...docs.map((doc) => doc.name.length));
    const lines = [
      `${bold("neoterm docs")} ${muted("· neoterm docs <nome ou número> abre um")}`,
      "",
      ...docs.map((doc) => `  ${muted(String(doc.number).padStart(2))}  ${accent(doc.name.padEnd(width))}  ${(doc.summary || doc.title).replace(/`/g, "")}`),
      "",
      muted(`  na interface: :ajuda · arquivos em ${DOCS_DIR}`),
    ];
    console.log(lines.join("\n"));
    return 0;
  }
  const doc = findDoc(docs, query);
  if (!doc) {
    console.error(fail(`não achei um doc "${query}". Os que existem: ${docs.map((entry) => entry.name).join(", ")}`));
    return 1;
  }
  await page(renderForTerminal(await readFile(doc.file, "utf8")));
  return 0;
}
