import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";
import { COMMANDS, KEYS } from "./commands.ts";
import { theme } from "./theme.ts";

/* A ajuda: os comandos da conversa e as teclas de cada lugar, numa tela. */

export function renderHelp(width: number): ReactNode {
  const lines: ReactNode[] = [];
  const nameWidth = 14;
  lines.push(h(Text, { key: "t-cmd", color: theme.muted, bold: true }, "COMANDOS (escreva na conversa, com : ou /)"));
  for (const command of COMMANDS) {
    lines.push(
      h(
        Text,
        { key: `c-${command.name}`, wrap: "truncate-end" },
        h(Text, { color: theme.accent }, ` :${command.name}`.padEnd(nameWidth)),
        command.description,
        command.agentOnly ? h(Text, { color: theme.muted }, " · só agente") : null,
      ),
    );
  }
  lines.push(h(Text, { key: "path-tip", color: theme.muted, wrap: "wrap" }, " dica: escreva :path no fim de uma frase para inserir o arquivo ali"));
  const keyWidth = Math.min(28, Math.max(...KEYS.flatMap((group) => group.keys.map(([key]) => key.length))) + 3);
  const columns = width >= 110;
  const groups = KEYS.map((group) =>
    h(
      Box,
      { key: group.where, flexDirection: "column", width: columns ? Math.floor((width - 3) / 2) : width, marginTop: 1, flexShrink: 0 },
      h(Text, { color: theme.muted, bold: true }, `TECLAS · ${group.where.toUpperCase()}`),
      ...group.keys.map(([key, what]) => h(Text, { key, wrap: "truncate-end" }, h(Text, { color: theme.accent }, ` ${key}`.padEnd(keyWidth)), what)),
    ),
  );
  if (columns) {
    for (let at = 0; at < groups.length; at += 2) lines.push(h(Box, { key: `row-${at}`, flexDirection: "row", gap: 3 }, groups[at], groups[at + 1] ?? null));
  } else lines.push(...groups);
  lines.push(h(Box, { key: "docs", marginTop: 1 }, h(Text, { color: theme.muted, wrap: "wrap" }, "Mais no terminal: neoterm docs")));
  return h(Box, { flexDirection: "column", flexShrink: 0, paddingTop: 1 }, ...lines.map((line, at) => h(Box, { key: at, flexShrink: 0 }, line)));
}
