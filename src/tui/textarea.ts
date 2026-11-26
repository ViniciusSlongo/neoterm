import { Text, type useInput } from "ink";
import { createElement as h, type ReactNode } from "react";
import * as editor from "./editor.ts";

/*
 * O que o input da conversa e as notas têm em comum: as teclas de edição e o desenho das linhas com
 * o cursor. Quem usa decide o resto (o enter, o esc, o que acontece nas pontas do ↑↓).
 */

type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

/**
 * Quebra de linha onde o enter sozinho envia: shift+enter (terminais com o protocolo kitty) e, onde
 * ele não chega diferente do enter, option+enter ou ctrl+j.
 */
export function isNewlineKey(input: string, key: InkKey): boolean {
  return (key.return && (key.shift || key.meta)) || (input === "\n" && !key.return);
}

/**
 * O rascunho depois de uma tecla de edição, ou `null` se a tecla não é de edição. ↑↓ nas pontas do
 * texto levam o cursor ao começo ou ao fim. Texto colado sem bracketed paste chega aqui também.
 */
export function editKey(draft: editor.Draft, input: string, key: InkKey): editor.Draft | null {
  // Apagar a palavra: cmd+backspace (o iTerm2 e o Ghostty mandam ctrl+u; com o protocolo kitty
  // chega como super), option+backspace e ctrl+w, como no shell.
  if (key.backspace && (key.super || key.meta || key.ctrl)) return editor.deleteWordBack(draft);
  if (key.ctrl && (input === "u" || input === "w")) return editor.deleteWordBack(draft);
  if (key.backspace) return editor.backspace(draft);
  if (key.delete) return editor.deleteForward(draft);
  if (key.leftArrow) return key.meta || key.ctrl ? editor.wordLeft(draft) : editor.left(draft);
  if (key.rightArrow) return key.meta || key.ctrl ? editor.wordRight(draft) : editor.right(draft);
  if (key.meta && input === "b") return editor.wordLeft(draft);
  if (key.meta && input === "f") return editor.wordRight(draft);
  if (key.home || (key.ctrl && input === "a")) return editor.lineStart(draft);
  if (key.end || (key.ctrl && input === "e")) return editor.lineEnd(draft);
  if (key.upArrow) return editor.up(draft) ?? { ...draft, cursor: 0 };
  if (key.downArrow) return editor.down(draft) ?? { ...draft, cursor: [...draft.text].length };
  if (input && !key.ctrl && !key.meta && !key.return && !key.escape && !key.tab) {
    return editor.insert(draft, input.replace(/\r\n?/g, "\n"));
  }
  return null;
}

/**
 * As linhas do texto de `first` até `first + count`, cada uma com `prefix(índice)` na frente e o
 * cursor (um bloco invertido) na dele, se `focused`.
 */
export function renderLines(
  draft: editor.Draft,
  options: { first: number; count: number; focused: boolean; prefix?: (index: number) => ReactNode },
): ReactNode[] {
  const { line: cursorLine, column } = editor.position(draft);
  return draft.text
    .split("\n")
    .slice(options.first, options.first + options.count)
    .map((text, at) => {
      const index = options.first + at;
      const prefix = options.prefix?.(index) ?? null;
      if (index !== cursorLine || !options.focused) return h(Text, { key: index, wrap: "wrap" }, prefix, text || " ");
      const chars = [...text];
      return h(
        Text,
        { key: index, wrap: "wrap" },
        prefix,
        chars.slice(0, column).join(""),
        h(Text, { inverse: true }, chars[column] ?? " "),
        chars.slice(column + 1).join(""),
      );
    });
}

/** A primeira linha a mostrar para o cursor continuar à vista, mexendo o mínimo a partir de `top`. */
export function followCursor(draft: editor.Draft, top: number, height: number): number {
  const { line } = editor.position(draft);
  const total = draft.text.split("\n").length;
  let first = Math.min(top, Math.max(total - height, 0));
  if (line < first) first = line;
  if (line >= first + height) first = line - height + 1;
  return Math.max(first, 0);
}
