import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";
import type { AgentProcess } from "../processes.ts";
import { bytes, duration } from "./format.ts";
import { theme } from "./theme.ts";

/* A tela de processos de um agente: o turno em andamento e os serviços que ele deixou rodando. */

export type ProcessView = { processes: AgentProcess[]; totalBytes: number };

/** O comando sem o caminho do programa e sem argumentos longos demais. */
function shortCommand(command: string): string {
  const [program = "", ...args] = command.split(/\s+/);
  const name = program.split("/").at(-1) ?? program;
  if (name === "claude") return "claude (o turno em andamento)";
  return [name, ...args].join(" ");
}

export function renderProcesses(
  data: ProcessView | null,
  options: { index: number; confirming: "one" | "all" | null; error: string | null; width: number; expanded: boolean },
): ReactNode {
  if (!data) {
    return h(Text, { color: options.error ? theme.red : theme.muted }, options.error ? `não li os processos: ${options.error}` : "lendo os processos…");
  }
  const lines: ReactNode[] = [];
  const services = data.processes.filter((entry) => entry.kind === "service");
  const left = services.filter((entry) => !entry.inTurn);
  lines.push(
    h(
      Text,
      { key: "total", wrap: "truncate-end" },
      h(Text, { bold: true }, bytes(data.totalBytes)),
      h(Text, { color: theme.muted }, ` em ${data.processes.length} ${data.processes.length === 1 ? "processo" : "processos"}`),
      left.length ? h(Text, { color: theme.amber }, ` · ${left.length} ${left.length === 1 ? "serviço deixado rodando" : "serviços deixados rodando"}`) : null,
    ),
  );
  if (data.processes.length === 0) {
    // Vazio: só a frase, sem total nem legenda.
    return h(
      Box,
      { flexDirection: "column", flexShrink: 0, paddingTop: 1 },
      h(Text, { color: theme.muted, wrap: "wrap" }, "Nada rodando por este agente agora."),
      h(Text, { color: theme.muted, wrap: "wrap" }, "Servidores e processos que ele deixar rodando aparecem aqui, com a memória de cada um."),
    );
  }
  const commandWidth = Math.max(options.width - 34, 20);
  data.processes.forEach((entry, at) => {
    const active = at === options.index;
    const bg = active ? { backgroundColor: theme.selected } : {};
    const [glyph, color, label] =
      entry.kind === "claude" ? ["●", theme.green, "turno"] : entry.inTurn ? ["●", theme.green, "no turno"] : ["◆", theme.amber, "rodando"];
    const command = shortCommand(entry.command);
    lines.push(
      h(
        Text,
        { key: entry.pid, wrap: "truncate-end", ...bg },
        h(Text, { ...bg }, active ? "▌" : " "),
        h(Text, { color, ...bg }, `${glyph} `),
        h(Text, { bold: active, ...bg }, (command.length > commandWidth ? `${command.slice(0, commandWidth - 1)}…` : command).padEnd(commandWidth)),
        h(Text, { color: theme.muted, ...bg }, ` ${bytes(entry.rssBytes).padStart(7)}  ${duration(entry.uptimeSeconds * 1000).padEnd(9)} ${label.padEnd(9)}`),
        entry.ports.length ? h(Text, { color: theme.accent, ...bg }, ` :${entry.ports.join(",")}`) : null,
      ),
    );
  });
  const selected = data.processes[options.index];
  if (selected) {
    // O comando completo pode ser enorme (o do `claude` leva o prompt inteiro): numa linha, e
    // inteiro só com enter. Do `claude`, nunca o prompt: só o programa e o modelo.
    const full =
      selected.kind === "claude"
        ? `claude -p${/--model\s+(\S+)/.exec(selected.command)?.[1] ? ` --model ${/--model\s+(\S+)/.exec(selected.command)![1]}` : ""} …`
        : selected.command;
    const expandable = selected.kind !== "claude" && full.length > options.width - 4;
    lines.push(
      h(
        Box,
        { key: "detail", marginTop: 1, flexDirection: "column" },
        h(
          Text,
          { color: theme.muted },
          `pid ${selected.pid}${selected.ports.length ? ` · porta ${selected.ports.join(", ")}` : ""}${expandable ? (options.expanded ? " · enter recolhe" : " · enter mostra o comando inteiro") : ""}`,
        ),
        options.expanded && expandable
          ? h(Box, { maxHeight: 8, overflow: "hidden" }, h(Text, { color: theme.muted, wrap: "wrap" }, full))
          : h(Text, { color: theme.muted, wrap: "truncate-end" }, full),
      ),
    );
  }
  if (options.confirming) {
    const what =
      options.confirming === "all"
        ? `os ${services.length} ${services.length === 1 ? "serviço" : "serviços"} do agente`
        : selected?.kind === "claude"
          ? "o turno em andamento (a resposta dele para no meio)"
          : `${shortCommand(selected?.command ?? "")} (pid ${selected?.pid})`;
    lines.push(
      h(
        Box,
        { key: "confirm", marginTop: 1, flexDirection: "column" },
        h(Text, { color: theme.red, bold: true, wrap: "wrap" }, `Aperte ${options.confirming === "all" ? "X" : "x"} de novo para encerrar ${what}.`),
        h(Text, { color: theme.muted }, "Pede para parar e, se não sair em 3 s, força. Qualquer outra tecla desiste."),
      ),
    );
  }
  if (options.error) lines.push(h(Text, { key: "err", color: theme.red, wrap: "wrap" }, `✗ ${options.error}`));
  lines.push(
    h(
      Box,
      { key: "legend", marginTop: 1 },
      h(Text, { color: theme.muted, wrap: "wrap" }, "● turno em andamento   ◆ deixado rodando pelo agente · só aparece o que ele iniciou (marcado no ambiente)"),
    ),
  );
  return h(Box, { flexDirection: "column", flexShrink: 0, paddingTop: 1 }, ...lines.map((line, at) => h(Box, { key: at, flexShrink: 0 }, line)));
}
