import { Box, Text, Transform } from "ink";
import { createElement as h, type ReactNode } from "react";
import { theme } from "./theme.ts";

/*
 * O markdown que os agentes escrevem, desenhado no terminal: **negrito**, `código`, títulos (#),
 * listas, citações (>) e blocos de código (```). Sem renderizador completo: o resto (tabelas,
 * links) aparece como texto, que já é legível.
 */

/**
 * Quando o ink quebra uma linha bem num espaço, a linha seguinte começa com ele. Um espaço só antes
 * do texto é isso; recuos de verdade (listas aninhadas, código) têm dois ou mais e ficam.
 */
export const dropWrapSpace = (line: string, index: number) => (index > 0 ? line.replace(/^ (?=\S)/, "") : line);

const INLINE = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|@[\p{L}\p{N}_-]+)/u;

/** Os pedaços de uma linha: negrito, código e menções destacados. */
export function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).map((piece, index) => {
    const k = `${key}-${index}`;
    if (/^(\*\*|__).+\1$/.test(piece) && piece.length > 4) return h(Text, { key: k, bold: true }, piece.slice(2, -2));
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) return h(Text, { key: k, color: theme.accent }, piece.slice(1, -1));
    if (piece.startsWith("@") && piece.length > 1) return h(Text, { key: k, color: /^@voc[eê]$/i.test(piece) ? theme.amber : theme.accent }, piece);
    return piece;
  });
}

const line = (key: string, ...children: ReactNode[]) =>
  h(Transform, { key, transform: dropWrapSpace }, h(Text, { wrap: "wrap" }, ...children));

export function renderMarkdown(text: string, key: string): ReactNode {
  const out: ReactNode[] = [];
  let code: string[] | null = null;
  text.split("\n").forEach((raw, index) => {
    const k = `${key}-${index}`;
    if (/^\s*```/.test(raw)) {
      if (code === null) code = [];
      else {
        out.push(
          h(
            Box,
            { key: k, flexDirection: "column", paddingLeft: 2, flexShrink: 0 },
            ...code.map((codeLine, at) => h(Text, { key: at, color: theme.muted, wrap: "truncate-end" }, codeLine || " ")),
          ),
        );
        code = null;
      }
      return;
    }
    if (code !== null) {
      code.push(raw);
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) return void out.push(line(k, h(Text, { bold: true, color: theme.accent }, ...inline(heading[2]!.replace(/\*\*/g, ""), k))));
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) return void out.push(line(k, h(Text, { color: theme.muted }, "┃ ", ...inline(quote[1]!, k))));
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) return void out.push(line(k, `${bullet[1]}• `, ...inline(bullet[2]!, k)));
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return void out.push(h(Text, { key: k, color: theme.border }, "─".repeat(20)));
    out.push(line(k, ...(raw ? inline(raw, k) : [" "])));
  });
  // Um bloco de código sem o ``` de fechar (a resposta ainda chegando): mostra o que já veio.
  if (code !== null) {
    out.push(h(Box, { key: `${key}-open`, flexDirection: "column", paddingLeft: 2 }, ...(code as string[]).map((codeLine, at) => h(Text, { key: at, color: theme.muted, wrap: "truncate-end" }, codeLine || " "))));
  }
  return h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0 }, ...out);
}
