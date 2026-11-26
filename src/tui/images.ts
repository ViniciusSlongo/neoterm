import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { NEOTERM_HOME } from "../config.ts";

/*
 * Imagens coladas na conversa. Chegam de dois jeitos: a imagem em si no clipboard (um print), que o
 * cmd+v manda como colagem vazia e a interface lê; ou o caminho de um arquivo, colado ou arrastado
 * (às vezes entre aspas, ou com espaços escapados por \). O input mostra só `[imagem N]`; no envio o
 * token vira `[imagem N: /caminho]`, que diz ao agente o que abrir, e o histórico volta a mostrar
 * `[imagem N]`.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i;
const TOKEN = /\[imagem (\d+)\]/g;
const SENT = /\[imagem (\d+): [^\]\n]+\]/g;

function isImageFile(path: string): boolean {
  if (!path.startsWith("/") || !IMAGE_EXT.test(path)) return false;
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Os caminhos de imagem colados; `null` se o texto colado não for só isso. */
export function pastedImages(text: string): string[] | null {
  // Separado como o shell faria: 'entre aspas', "entre aspas" ou com espaços escapados por \.
  const pattern = /'([^']*)'|"([^"]*)"|((?:\\.|[^\s\\'"])+)/g;
  if (text.replace(pattern, "").trim()) return null;
  const paths = [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? match[3]!.replace(/\\(.)/g, "$1"));
  return paths.length > 0 && paths.every(isImageFile) ? paths : null;
}

/** O rascunho com cada `[imagem N]` trocado pelo token completo, com o caminho. */
export function expandImages(draft: string, images: ReadonlyMap<number, string>): string {
  return draft.replace(TOKEN, (token, n: string) => {
    const path = images.get(Number(n));
    return path ? `[imagem ${n}: ${path}]` : token;
  });
}

/** Para mostrar uma mensagem enviada: `[imagem N: /caminho]` volta a ser `[imagem N]`. */
export function shortenImages(text: string): string {
  return text.replace(SENT, (_, n: string) => `[imagem ${n}]`);
}

/** Onde ficam as imagens lidas do clipboard: fora do temporário, para a conversa não perder a referência. */
export const IMAGES_DIR = join(NEOTERM_HOME, "imagens");

// Converte o que houver no clipboard para PNG e grava no caminho dado; "none" se não houver imagem.
const CLIPBOARD_SCRIPT = [
  "on run argv",
  "try",
  "set img to the clipboard as «class PNGf»",
  "on error",
  'return "none"',
  "end try",
  "set f to open for access (POSIX file (item 1 of argv)) with write permission",
  "set eof f to 0",
  "write img to f",
  "close access f",
  'return "ok"',
  "end run",
];

/** Lê a imagem do clipboard do macOS e a salva como PNG; `null` se não houver imagem. */
export async function clipboardImage(dir = IMAGES_DIR): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${Math.random().toString(36).slice(2, 6)}.png`);
  const args = CLIPBOARD_SCRIPT.flatMap((line) => ["-e", line]);
  const { stdout } = await promisify(execFile)("osascript", [...args, path], { timeout: 10_000 });
  return stdout.trim() === "ok" ? path : null;
}
