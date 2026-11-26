import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";
import { ACCENTS, theme } from "./theme.ts";

/*
 * A tela de configuração: a cor de destaque da interface (com prévia ao passar por cada uma) e o
 * modelo padrão dos agentes. Uma linha por opção: as cores prontas, uma personalizada e o modelo.
 */

export const MODEL_OPTIONS = [
  { value: "claude-opus-5-5", label: "opus" },
  { value: "claude-sonnet-5-5", label: "sonnet" },
  { value: "claude-haiku-5-5", label: "haiku" },
];

/** As linhas da tela, na ordem: cada cor pronta, a personalizada e o modelo. */
export const CONFIG_ROWS = ACCENTS.length + 2;
export const CUSTOM_ROW = ACCENTS.length;
export const MODEL_ROW = ACCENTS.length + 1;

export type ConfigView = {
  index: number;
  /** A cor salva. */
  saved: string;
  /** Digitando uma cor personalizada: o que já foi digitado. */
  typing: string | null;
  model: string;
  focused: boolean;
  error: string | null;
};

export function renderConfig(view: ConfigView): ReactNode {
  const lines: ReactNode[] = [];
  const row = (at: number, ...children: ReactNode[]) => {
    const active = at === view.index && view.focused;
    const bg = active ? { backgroundColor: theme.selected } : {};
    return h(Text, { key: `r${at}`, wrap: "truncate-end", ...bg }, h(Text, { ...bg }, active ? "▌" : " "), ...children);
  };

  lines.push(h(Text, { key: "t-cor", color: theme.muted, bold: true }, "COR DE DESTAQUE"));
  ACCENTS.forEach((accent, at) => {
    const current = accent.hex.toUpperCase() === view.saved.toUpperCase();
    lines.push(
      row(
        at,
        h(Text, { color: accent.hex }, " ███ "),
        h(Text, { bold: at === view.index }, accent.name.padEnd(10)),
        h(Text, { color: theme.muted }, accent.hex),
        current ? h(Text, { color: theme.green }, "  ✓ em uso") : null,
      ),
    );
  });
  const customSaved = !ACCENTS.some((accent) => accent.hex.toUpperCase() === view.saved.toUpperCase());
  lines.push(
    row(
      CUSTOM_ROW,
      view.typing !== null
        ? h(Text, null, h(Text, { color: theme.muted }, " cor: "), h(Text, null, view.typing), h(Text, { inverse: true }, " "), h(Text, { color: theme.muted }, "  #RRGGBB · enter aplica · esc desiste"))
        : h(
            Text,
            null,
            h(Text, { color: customSaved ? view.saved : theme.muted }, " ███ "),
            h(Text, { bold: view.index === CUSTOM_ROW }, "personalizada".padEnd(14)),
            customSaved ? h(Text, null, h(Text, { color: theme.muted }, view.saved), h(Text, { color: theme.green }, "  ✓ em uso")) : h(Text, { color: theme.muted }, "enter e digite #RRGGBB"),
          ),
    ),
  );

  // O erro logo abaixo de onde se digitou, à vista mesmo num terminal baixo.
  if (view.error) lines.push(h(Text, { key: "err", color: theme.red, wrap: "wrap" }, `  ✗ ${view.error}`));
  lines.push(h(Box, { key: "t-modelo", marginTop: 1 }, h(Text, { color: theme.muted, bold: true }, "MODELO PADRÃO DOS AGENTES")));
  lines.push(
    row(
      MODEL_ROW,
      " ",
      ...MODEL_OPTIONS.flatMap((option, position) => [
        position > 0 ? "  " : "",
        option.value === view.model
          ? h(Text, { key: option.value, backgroundColor: theme.accent, color: theme.onAccent, bold: true }, ` ${option.label} `)
          : h(Text, { key: option.value, color: theme.muted }, ` ${option.label} `),
      ]),
      h(Text, { color: theme.muted }, "   ←→ troca · vale para agentes sem modelo no AGENT.md"),
    ),
  );

  // Prévia: as peças da interface que usam o destaque.
  lines.push(h(Box, { key: "t-previa", marginTop: 1 }, h(Text, { color: theme.muted, bold: true }, "PRÉVIA")));
  lines.push(
    h(
      Box,
      { key: "previa", flexDirection: "column", paddingLeft: 1 },
      h(Text, null, h(Text, { bold: true, color: theme.onAccent, backgroundColor: theme.accent }, " analista "), h(Text, { color: theme.muted }, " · Financeiro")),
      h(
        Box,
        { marginTop: 1, paddingX: 1, backgroundColor: theme.person, borderStyle: "bold", borderTop: false, borderRight: false, borderBottom: false, borderColor: theme.accent, width: 44 },
        h(Text, null, "quanto entrou essa semana? @dev"),
      ),
      h(Text, null, h(Text, { color: theme.green }, "● "), "O extrato está em ", h(Text, { color: theme.accent }, "docs/novembro.csv")),
      h(Text, null, h(Text, { color: theme.accent, bold: true }, "> "), h(Text, { color: theme.muted }, "mensagem para analista"), "   ", h(Text, { color: theme.accent }, "◆ painel")),
    ),
  );
  return h(Box, { flexDirection: "column", flexShrink: 0, paddingTop: 1 }, ...lines.map((line, at) => h(Box, { key: at, flexShrink: 0 }, line)));
}
