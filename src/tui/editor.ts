/*
 * O texto do input da conversa e a posição do cursor, em caracteres (não em unidades UTF-16, para um
 * emoji contar como um só). Funções puras: cada tecla recebe o rascunho e devolve o próximo. Um
 * `[imagem N]` se comporta como um caractere só: as setas pulam e o backspace apaga ele inteiro.
 */

export type Draft = { text: string; cursor: number };

export const EMPTY: Draft = { text: "", cursor: 0 };

const TOKEN_BEFORE = /\[imagem \d+\]$/;
const TOKEN_AFTER = /^\[imagem \d+\]/;

const chars = (text: string) => [...text];
const length = (text: string) => chars(text).length;

function split(draft: Draft): [string, string] {
  const all = chars(draft.text);
  const at = Math.min(Math.max(draft.cursor, 0), all.length);
  return [all.slice(0, at).join(""), all.slice(at).join("")];
}

export function insert(draft: Draft, text: string): Draft {
  const [before, after] = split(draft);
  return { text: before + text + after, cursor: length(before + text) };
}

export function backspace(draft: Draft): Draft {
  const [before, after] = split(draft);
  const token = TOKEN_BEFORE.exec(before);
  const kept = token ? before.slice(0, token.index) : chars(before).slice(0, -1).join("");
  return { text: kept + after, cursor: length(kept) };
}

/** Apaga a palavra antes do cursor (cmd+backspace, option+backspace, ctrl+w); um `[imagem N]` conta como uma. */
export function deleteWordBack(draft: Draft): Draft {
  const [before, after] = split(draft);
  // Só dentro da linha: no começo de uma, apaga a quebra de linha, como um backspace.
  const match = /(\[imagem \d+\]|\S+)[^\S\n]*$/u.exec(before) ?? /[^\S\n]+$/u.exec(before);
  if (!match) return backspace(draft);
  const kept = before.slice(0, match.index);
  return { text: kept + after, cursor: length(kept) };
}

export function deleteForward(draft: Draft): Draft {
  const [before, after] = split(draft);
  const token = TOKEN_AFTER.exec(after);
  const rest = token ? after.slice(token[0].length) : chars(after).slice(1).join("");
  return { text: before + rest, cursor: draft.cursor };
}

export function left(draft: Draft): Draft {
  const [before] = split(draft);
  const token = TOKEN_BEFORE.exec(before);
  return { ...draft, cursor: Math.max(token ? length(before.slice(0, token.index)) : draft.cursor - 1, 0) };
}

export function right(draft: Draft): Draft {
  const [before, after] = split(draft);
  const token = TOKEN_AFTER.exec(after);
  return { ...draft, cursor: Math.min(length(before) + (token ? token[0].length : 1), length(draft.text)) };
}

export function wordLeft(draft: Draft): Draft {
  const [before] = split(draft);
  const match = /\S+\s*$/u.exec(before);
  return { ...draft, cursor: match ? length(before.slice(0, match.index)) : 0 };
}

export function wordRight(draft: Draft): Draft {
  const [before, after] = split(draft);
  const match = /^\s*\S+/u.exec(after);
  return { ...draft, cursor: length(before) + (match ? length(match[0]) : length(after)) };
}

/** Linha e coluna do cursor, contando as quebras de linha do texto. */
export function position(draft: Draft): { line: number; column: number } {
  const lines = split(draft)[0].split("\n");
  return { line: lines.length - 1, column: length(lines.at(-1)!) };
}

function moveTo(draft: Draft, line: number, column: number): Draft {
  const lines = draft.text.split("\n");
  const offset = lines.slice(0, line).reduce((sum, entry) => sum + length(entry) + 1, 0);
  return { ...draft, cursor: offset + Math.min(column, length(lines[line]!)) };
}

/** A linha de cima, na mesma coluna; `null` se o cursor já está na primeira. */
export function up(draft: Draft): Draft | null {
  const { line, column } = position(draft);
  return line === 0 ? null : moveTo(draft, line - 1, column);
}

/** A linha de baixo, na mesma coluna; `null` se o cursor já está na última. */
export function down(draft: Draft): Draft | null {
  const { line, column } = position(draft);
  return line >= draft.text.split("\n").length - 1 ? null : moveTo(draft, line + 1, column);
}

export function lineStart(draft: Draft): Draft {
  return moveTo(draft, position(draft).line, 0);
}

export function lineEnd(draft: Draft): Draft {
  return moveTo(draft, position(draft).line, Number.POSITIVE_INFINITY);
}
