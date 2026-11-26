import { basename, extname } from "node:path";
import type { BundledLanguage, GrammarState, ThemedToken } from "shiki";

/*
 * As cores de código do visualizador, pelo shiki: as gramáticas e os temas do VS Code. O tema
 * padrão é o Dark+, o do próprio VS Code. Carrega só quando um arquivo é aberto, e colore em partes
 * (continuando a gramática de uma para a outra), para a tela não travar num arquivo grande.
 */

export const CODE_THEME = "dark-plus";

/** Um pedaço de uma linha com o estilo dele. */
export type Segment = { text: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };

export type Language = { id: string; name: string };

type Shiki = typeof import("shiki");
type Loaded = { shiki: Shiki; highlighter: Awaited<ReturnType<Shiki["createHighlighter"]>> };
let loading: Promise<Loaded> | undefined;

function load(): Promise<Loaded> {
  loading ??= (async () => {
    const shiki = await import("shiki");
    const highlighter = await shiki.createHighlighter({ themes: [CODE_THEME], langs: [] });
    return { shiki, highlighter };
  })();
  return loading;
}

/** Arquivos que a extensão não diz o que são. */
const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
};

/** Extensões que não são o nome nem um apelido da linguagem no shiki ("" é texto puro). */
const BY_EXTENSION: Record<string, string> = { htm: "html", h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp", txt: "" };

/** A linguagem de um arquivo, pelo nome e pela extensão; `null` é texto puro. */
export async function detectLanguage(path: string): Promise<Language | null> {
  const { shiki } = await load();
  const find = (word: string): Language | null => {
    const info = shiki.bundledLanguagesInfo.find((entry) => entry.id === word || entry.aliases?.includes(word));
    return info ? { id: info.id, name: info.name } : null;
  };
  const name = basename(path).toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return find("dotenv");
  if (/^[tj]sconfig.*\.json$/.test(name)) return find("jsonc");
  if (BY_NAME[name]) return find(BY_NAME[name]);
  const extension = extname(name).slice(1);
  if (!extension) return null;
  if (extension in BY_EXTENSION) return BY_EXTENSION[extension] ? find(BY_EXTENSION[extension]) : null;
  return find(extension);
}

// O fontStyle do shiki é uma máscara: 1 itálico, 2 negrito, 4 sublinhado, 8 riscado (-1: nenhum).
function toSegment(token: ThemedToken): Segment {
  const style = token.fontStyle ?? 0;
  const has = (bit: number) => style > 0 && (style & bit) !== 0;
  return {
    text: token.content,
    ...(token.color ? { color: token.color } : {}),
    ...(has(1) ? { italic: true } : {}),
    ...(has(2) ? { bold: true } : {}),
    ...(has(4) ? { underline: true } : {}),
    ...(has(8) ? { strikethrough: true } : {}),
  };
}

/**
 * As linhas coloridas, em partes de `chunkLines`, cada parte continuando a gramática da anterior
 * (um comentário de várias linhas atravessa as partes certo). Entre uma parte e outra, a tela
 * respira.
 */
export async function* highlightChunks(
  text: string,
  language: string,
  options: { chunkLines?: number } = {},
): AsyncGenerator<{ from: number; lines: Segment[][] }> {
  const { highlighter } = await load();
  const lang = language as BundledLanguage;
  await highlighter.loadLanguage(lang);
  const lines = text.split("\n");
  const size = options.chunkLines ?? 200;
  let state: GrammarState | undefined;
  for (let from = 0; from < lines.length; from += size) {
    const result = highlighter.codeToTokens(lines.slice(from, from + size).join("\n"), {
      lang,
      theme: CODE_THEME,
      // Linhas enormes (código minificado) ficam sem cores, em vez de travar.
      tokenizeMaxLineLength: 2000,
      ...(state ? { grammarState: state } : {}),
    });
    state = result.grammarState;
    yield { from, lines: result.tokens.map((line) => line.map(toSegment)) };
    await new Promise((resolve) => setImmediate(resolve));
  }
}
