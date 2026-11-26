import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Text } from "ink";
import { createElement as h, type ReactNode } from "react";
import { detectLanguage, type Language, type Segment } from "./highlight.ts";
import { theme } from "./theme.ts";

/*
 * O visualizador de arquivos: o conteúdo em tela cheia, com números de linha e as cores do código.
 * Só desenha as linhas à vista, então um arquivo grande rola tão leve quanto um pequeno.
 */

export const VIEWER_MAX_BYTES = 5 * 1024 * 1024;
/** Acima disso, o arquivo abre sem cores (colorir levaria tempo demais). */
export const HIGHLIGHT_MAX_LINES = 20_000;
const TAB_WIDTH = 4;

export type ViewerFile = {
  path: string;
  name: string;
  language: Language | null;
  /** O texto como está no disco (para colorir). */
  raw: string;
  /** O texto de cada linha, com os tabs como espaços. */
  lines: string[];
  /** Cada linha colorida, conforme fica pronta. */
  styled: (Segment[] | undefined)[];
  mtimeMs: number;
  size: number;
  /** Abriu sem cores, e por quê. */
  note?: string;
};

export class ViewerProblem extends Error {}

/** Tabs viram espaços até a próxima parada de 4, contando a coluna ao longo dos pedaços da linha. */
export function expandTabs(segments: Segment[]): Segment[] {
  let column = 0;
  return segments.map((segment) => {
    if (!segment.text.includes("\t")) {
      column += segment.text.length;
      return segment;
    }
    let text = "";
    for (const char of segment.text) {
      if (char === "\t") {
        const spaces = TAB_WIDTH - (column % TAB_WIDTH);
        text += " ".repeat(spaces);
        column += spaces;
      } else {
        text += char;
        column += char.length;
      }
    }
    return { ...segment, text };
  });
}

const megabytes = (bytes: number) => `${(bytes / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;

export async function loadViewerFile(path: string): Promise<ViewerFile> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ViewerProblem("o arquivo não existe");
  }
  if (info.isDirectory()) throw new ViewerProblem("é uma pasta");
  if (info.size > VIEWER_MAX_BYTES) throw new ViewerProblem(`grande demais para abrir aqui (${megabytes(info.size)})`);
  const buffer = await readFile(path);
  if (buffer.subarray(0, 8000).includes(0)) throw new ViewerProblem("arquivo binário: não dá para mostrar");
  let raw = buffer.toString("utf8").replace(/\r\n?/g, "\n");
  // Como nos editores: o \n do fim não vira uma linha vazia a mais.
  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  const lines = raw.split("\n").map((line) => expandTabs([{ text: line }])[0]!.text);
  const language = await detectLanguage(path);
  return {
    path,
    name: basename(path),
    language,
    raw,
    lines,
    styled: [],
    mtimeMs: info.mtimeMs,
    size: info.size,
    ...(language && lines.length > HIGHLIGHT_MAX_LINES ? { note: "sem cores: arquivo grande" } : {}),
  };
}

export type Match = { line: number; start: number; end: number };

/** Onde o termo aparece, sem diferenciar maiúsculas. */
export function findMatches(lines: readonly string[], term: string): Match[] {
  const wanted = term.toLowerCase();
  if (!wanted) return [];
  const found: Match[] = [];
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (let at = lower.indexOf(wanted); at !== -1; at = lower.indexOf(wanted, at + wanted.length)) {
      found.push({ line: index, start: at, end: at + wanted.length });
    }
  });
  return found;
}

type Piece = { text: string; segment: Segment; match: "current" | "other" | null };

/**
 * Os pedaços de uma linha entre as colunas `from` e `to`, cortados nas bordas dos pedaços coloridos
 * e das ocorrências da busca.
 */
export function slicePieces(segments: Segment[], from: number, to: number, matches: { start: number; end: number; current: boolean }[]): Piece[] {
  const pieces: Piece[] = [];
  let position = 0;
  for (const segment of segments) {
    const start = position;
    const end = position + segment.text.length;
    position = end;
    if (end <= from || start >= to) continue;
    let cursor = Math.max(start, from);
    const stop = Math.min(end, to);
    while (cursor < stop) {
      const inside = matches.find((match) => match.start <= cursor && cursor < match.end);
      const nextStart = Math.min(stop, ...matches.filter((match) => match.start > cursor).map((match) => match.start));
      const next = inside ? Math.min(inside.end, stop) : nextStart;
      pieces.push({ text: segment.text.slice(cursor - start, next - start), segment, match: inside ? (inside.current ? "current" : "other") : null });
      cursor = next;
    }
  }
  return pieces;
}

/** As linhas à vista, com o número de cada uma e as cores; `‹` e `›` dizem que a linha continua de lado. */
export function renderViewerLines(
  file: ViewerFile,
  view: { top: number; left: number; width: number; height: number; matches: Match[]; current: number },
): ReactNode[] {
  const digits = String(file.lines.length).length;
  const available = Math.max(view.width - digits - 2, 1);
  const rows: ReactNode[] = [];
  const last = Math.min(view.top + view.height, file.lines.length);
  for (let index = view.top; index < last; index++) {
    const line = file.lines[index]!;
    const segments = file.styled[index] ?? [{ text: line }];
    const continuesLeft = view.left > 0 && line.length > view.left;
    const continuesRight = line.length > view.left + available;
    const from = view.left + (continuesLeft ? 1 : 0);
    const to = view.left + available - (continuesRight ? 1 : 0);
    const lineMatches = view.matches
      .map((match, at) => ({ ...match, current: at === view.current }))
      .filter((match) => match.line === index);
    const pieces = slicePieces(segments, from, to, lineMatches).map((piece, at) => {
      const style = piece.segment;
      const highlight =
        piece.match === "current"
          ? { backgroundColor: theme.accent, color: theme.onAccent }
          : piece.match === "other"
            ? { backgroundColor: theme.amber, color: theme.onAccent }
            : {};
      return h(
        Text,
        {
          key: at,
          ...(style.color ? { color: style.color } : {}),
          ...(style.bold ? { bold: true } : {}),
          ...(style.italic ? { italic: true } : {}),
          ...(style.underline ? { underline: true } : {}),
          ...(style.strikethrough ? { strikethrough: true } : {}),
          ...highlight,
        },
        piece.text,
      );
    });
    rows.push(
      h(
        Text,
        { key: index, wrap: "truncate-end" },
        h(Text, { color: theme.muted }, `${String(index + 1).padStart(digits)}  `),
        continuesLeft ? h(Text, { color: theme.muted }, "‹") : null,
        ...pieces,
        continuesRight ? h(Text, { color: theme.muted }, "›") : null,
      ),
    );
  }
  return rows;
}

export type ViewerView = {
  top: number;
  left: number;
  /** Digitando a busca (o / do less); null quando não. */
  input: string | null;
  term: string;
  /** A ocorrência da busca em destaque. */
  current: number;
};

export const NEW_VIEW: ViewerView = { top: 0, left: 0, input: null, term: "", current: 0 };

type Key = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export type ViewerAction = { type: "view"; view: ViewerView; notFound?: boolean } | { type: "close" } | { type: "none" };

const SIDE_STEP = 8;

/** O que uma tecla faz no visualizador. `height`: quantas linhas cabem. */
export function viewerKey(view: ViewerView, file: ViewerFile, matches: Match[], input: string, key: Key, height: number): ViewerAction {
  const maxTop = Math.max(file.lines.length - height, 0);
  const at = (top: number, extra: Partial<ViewerView> = {}): ViewerAction => ({ type: "view", view: { ...view, ...extra, top: Math.min(Math.max(top, 0), maxTop) } });

  // Digitando a busca.
  if (view.input !== null) {
    if (key.escape) return { type: "view", view: { ...view, input: null } };
    if (key.return) {
      const term = view.input;
      const found = term ? findMatches(file.lines, term) : [];
      if (!term) return { type: "view", view: { ...view, input: null, term: "", current: 0 } };
      // A primeira ocorrência a partir de onde se está lendo.
      const next = Math.max(found.findIndex((match) => match.line >= view.top), 0);
      if (found.length === 0) return { type: "view", view: { ...view, input: null, term, current: 0 }, notFound: true };
      return goTo(view, file, found, next, height, { input: null, term });
    }
    if (key.backspace || key.delete) return { type: "view", view: { ...view, input: view.input.slice(0, -1) } };
    if (input && !key.ctrl && !key.meta) return { type: "view", view: { ...view, input: view.input + input } };
    return { type: "none" };
  }

  if (key.escape) return view.term ? { type: "view", view: { ...view, term: "", current: 0 } } : { type: "close" };
  if (input === "q") return { type: "close" };
  if (key.upArrow || input === "k") return at(view.top - 1);
  if (key.downArrow || input === "j") return at(view.top + 1);
  if (key.pageUp || input === "b") return at(view.top - Math.max(height - 1, 1));
  if (key.pageDown || input === " ") return at(view.top + Math.max(height - 1, 1));
  if (key.home || input === "g") return at(0);
  if (key.end || input === "G") return at(maxTop);
  if (key.leftArrow || input === "h") return at(view.top, { left: Math.max(view.left - SIDE_STEP, 0) });
  if (key.rightArrow || input === "l") {
    const longest = Math.max(...file.lines.slice(view.top, view.top + height).map((line) => line.length), 0);
    return at(view.top, { left: Math.min(view.left + SIDE_STEP, Math.max(longest - SIDE_STEP, 0)) });
  }
  if (input === "/") return { type: "view", view: { ...view, input: "" } };
  if ((input === "n" || input === "N") && matches.length > 0) {
    const step = input === "n" ? 1 : -1;
    return goTo(view, file, matches, (view.current + step + matches.length) % matches.length, height, {});
  }
  return { type: "none" };
}

/** Leva a vista até a ocorrência `index` (no primeiro terço da tela, se estiver fora dela). */
function goTo(view: ViewerView, file: ViewerFile, matches: Match[], index: number, height: number, extra: Partial<ViewerView>): ViewerAction {
  const match = matches[index]!;
  const maxTop = Math.max(file.lines.length - height, 0);
  const visible = match.line >= view.top && match.line < view.top + height;
  const top = visible ? view.top : Math.min(Math.max(match.line - Math.floor(height / 3), 0), maxTop);
  const left = match.start < view.left || match.end > view.left + 60 ? Math.max(match.start - 8, 0) : view.left;
  return { type: "view", view: { ...view, ...extra, top, left, current: index } };
}
