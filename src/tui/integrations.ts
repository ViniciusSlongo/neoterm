import { homedir } from "node:os";
import { Box, Text, Transform } from "ink";
import { dropWrapSpace } from "./markdown.ts";
import { createElement as h, type ReactNode } from "react";
import type { Integration, IntegrationStatus, Integrations } from "../integrations.ts";
import { theme } from "./theme.ts";

/*
 * A tela de integrações: só mostra. Quem conecta, autentica e testa é o Claude Code; aqui fica
 * dito como fazer cada coisa por lá.
 */

const GROUPS: { status: IntegrationStatus; title: string; glyph: string; color: string }[] = [
  { status: "connected", title: "CONECTADAS", glyph: "●", color: theme.green },
  { status: "needs_auth", title: "PRECISAM DE AUTENTICAÇÃO", glyph: "!", color: theme.amber },
  { status: "failed", title: "COM FALHA", glyph: "✗", color: theme.red },
  { status: "pending", title: "AGUARDANDO APROVAÇÃO", glyph: "⏸", color: theme.amber },
  { status: "unchecked", title: "NAS PASTAS DOS AGENTES (.mcp.json)", glyph: "○", color: theme.muted },
];

const SOURCE = { conta: "conta claude.ai", "claude-code": "Claude Code", projeto: "projeto" } as const;

function row(server: Integration, glyph: string, color: string, nameWidth: number): ReactNode {
  const where = server.source === "projeto" && server.folder ? server.folder.replace(homedir(), "~") : SOURCE[server.source];
  return h(
    Text,
    { key: `${server.source}:${server.folder ?? ""}:${server.name}`, wrap: "truncate-end" },
    h(Text, { color }, ` ${glyph} `),
    h(Text, { bold: true }, server.name.padEnd(nameWidth)),
    h(Text, { color: theme.muted }, `${where.padEnd(18)}  ${server.target}`),
  );
}

export function renderIntegrations(data: Integrations | null, options: { loading: boolean; error: string | null }): ReactNode {
  const lines: ReactNode[] = [];
  if (!data) {
    lines.push(
      options.error
        ? h(Text, { key: "error", color: theme.red, wrap: "wrap" }, `não carreguei as integrações: ${options.error}`)
        : h(Text, { key: "loading", color: theme.muted, wrap: "wrap" }, "verificando com o Claude Code… leva alguns segundos: ele testa cada integração."),
    );
    return h(Box, { flexDirection: "column", flexShrink: 0, paddingTop: 1 }, ...lines);
  }

  const count = (status: IntegrationStatus) => data.servers.filter((server) => server.status === status).length;
  const summary = [
    `${data.servers.length} integraç${data.servers.length === 1 ? "ão" : "ões"}`,
    count("connected") ? `${count("connected")} ${count("connected") === 1 ? "conectada" : "conectadas"}` : "",
    count("needs_auth") ? `${count("needs_auth")} ${count("needs_auth") === 1 ? "precisa" : "precisam"} de autenticação` : "",
    count("failed") ? `${count("failed")} com falha` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  lines.push(h(Text, { key: "summary", bold: true }, summary));
  if (options.loading) lines.push(h(Text, { key: "reloading", color: theme.muted }, "verificando de novo…"));
  if (data.error) lines.push(h(Text, { key: "err", color: theme.red, wrap: "wrap" }, data.error));

  if (!data.agentsUseThem) {
    lines.push(
      h(
        Box,
        { key: "notice", marginTop: 1, flexShrink: 0, borderStyle: "bold", borderTop: false, borderRight: false, borderBottom: false, borderColor: theme.amber, paddingLeft: 1 },
        h(
          Transform,
          { transform: dropWrapSpace },
          h(
          Text,
          { wrap: "wrap" },
          h(Text, { color: theme.amber, bold: true }, "Os agentes do neoterm ainda não usam estas integrações. "),
          h(Text, { color: theme.muted }, "Eles rodam só com as ferramentas do neoterm (rotinas, retornos, memória, ask_agent); estas valem no Claude Code que você usa direto."),
          ),
        ),
      ),
    );
  }

  const nameWidth = Math.min(Math.max(...data.servers.map((server) => server.name.length), 8) + 2, 26);
  for (const group of GROUPS) {
    const servers = data.servers.filter((server) => server.status === group.status);
    if (servers.length === 0) continue;
    lines.push(h(Box, { key: `t-${group.status}`, marginTop: 1, flexShrink: 0 }, h(Text, { color: theme.muted, bold: true }, `${group.title} (${servers.length})`)));
    for (const server of servers.toSorted((a, b) => a.name.localeCompare(b.name, "pt-BR"))) lines.push(row(server, group.glyph, group.color, nameWidth));
  }
  if (data.servers.length === 0) lines.push(h(Box, { key: "none", marginTop: 1 }, h(Text, { color: theme.muted }, "Nenhuma integração no Claude Code.")));

  lines.push(
    h(Box, { key: "how-title", marginTop: 1, flexShrink: 0 }, h(Text, { color: theme.muted, bold: true }, "COMO GERENCIAR (no Claude Code)")),
    h(Text, { key: "how-1", wrap: "wrap" }, h(Text, { color: theme.muted }, " conectar da conta   "), "claude.ai → Configurações → Conectores"),
    h(Text, { key: "how-2", wrap: "wrap" }, h(Text, { color: theme.muted }, " autenticar          "), "/mcp dentro do Claude Code"),
    h(Text, { key: "how-3", wrap: "wrap" }, h(Text, { color: theme.muted }, " adicionar uma       "), "claude mcp add <nome> <comando ou url>"),
    h(Text, { key: "how-4", wrap: "wrap" }, h(Text, { color: theme.muted }, " de um projeto       "), ".mcp.json na pasta do projeto"),
  );
  return h(Box, { flexDirection: "column", flexShrink: 0, paddingTop: 1 }, ...lines.map((line, at) => h(Box, { key: at, flexShrink: 0 }, line)));
}
