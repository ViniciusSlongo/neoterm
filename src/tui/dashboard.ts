import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";
import type { Dashboard } from "../dashboard.ts";
import { ago, bar, bytes, clockOrDay, duration, percent, sparkline } from "./format.ts";
import { theme } from "./theme.ts";

/*
 * O painel: o resumo do neoterm em cartões. Em duas colunas quando cabe; numa só quando não.
 */

const TRIGGER_LABEL = { chat: "conversa", routine: "rotina", followup: "retorno", group: "grupo", agent: "consulta" } as const;
const STATE_LABEL = { running: "trabalhando", paused: "pausado", idle: "livre" } as const;

type Line = ReactNode;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function card(key: string, title: string, width: number, lines: Line[]): ReactNode {
  return h(
    Box,
    { key, flexDirection: "column", width, flexShrink: 0, marginBottom: 1 },
    h(Text, { color: theme.muted, bold: true }, title),
    ...lines.map((line, index) => h(Box, { key: index, flexShrink: 0 }, typeof line === "string" ? h(Text, { wrap: "truncate-end" }, line) : line)),
  );
}

const label = (text: string, size = 10) => h(Text, { color: theme.muted }, text.padEnd(size));

/** Uma barra com o valor ao lado; âmbar a partir de 70%, vermelha a partir de 90%. */
function meter(name: string, ratio: number, width: number, after: string): ReactNode {
  const { filled, empty } = bar(ratio, width);
  const color = ratio >= 0.9 ? theme.red : ratio >= 0.7 ? theme.amber : theme.green;
  return h(Text, { wrap: "truncate-end" }, label(name), h(Text, { color }, filled), h(Text, { color: theme.border }, empty), ` ${after}`);
}

const when = clockOrDay;

export function renderDashboard(data: Dashboard, options: { width: number; timeZone: string }): ReactNode {
  const now = new Date(data.generatedAt);
  const { timeZone } = options;
  const twoColumns = options.width >= 80;
  const half = twoColumns ? Math.floor((options.width - 3) / 2) : options.width;
  const barWidth = Math.max(Math.min(half - 30, 20), 6);

  // ---- motor ----
  const engine = data.engine;
  const motor = card("motor", "MOTOR", half, [
    h(Text, null, h(Text, { color: theme.green }, "● "), `rodando há ${duration(engine.uptimeMs)}`, h(Text, { color: theme.muted }, ` · pid ${engine.pid}`)),
    h(Text, null, label("memória"), bytes(engine.rssBytes), h(Text, { color: theme.muted }, ` (heap ${bytes(engine.heapUsedBytes)})`)),
    h(
      Text,
      { wrap: "truncate-end" },
      label("claude"),
      engine.claude === null
        ? h(Text, { color: theme.muted }, "não consegui medir")
        : engine.claude.processes === 0
          ? h(Text, { color: theme.muted }, "nenhum rodando")
          : `${engine.claude.processes} ${engine.claude.processes === 1 ? "processo" : "processos"} · ${bytes(engine.claude.rssBytes)}`,
    ),
    h(
      Text,
      { wrap: "truncate-end" },
      label("agora"),
      engine.running.length ? h(Text, { color: theme.green }, engine.running.join(", ")) : h(Text, { color: theme.muted }, "ninguém trabalhando"),
    ),
  ]);

  // ---- máquina ----
  const machine = data.machine;
  const memRatio = machine.usedMemBytes / machine.totalMemBytes;
  const diskUsed = machine.diskTotalBytes && machine.diskFreeBytes !== null ? 1 - machine.diskFreeBytes / machine.diskTotalBytes : null;
  const maquina = card("maquina", "MÁQUINA", half, [
    meter("memória", memRatio, barWidth, `${bytes(machine.usedMemBytes)} de ${bytes(machine.totalMemBytes)}`),
    diskUsed === null
      ? h(Text, { color: theme.muted }, "disco: não consegui medir")
      : meter("disco", diskUsed, barWidth, `${bytes(machine.diskFreeBytes!)} livres`),
    h(Text, null, label("carga"), machine.load.map((value) => value.toFixed(1)).join(" · "), h(Text, { color: theme.muted }, ` · ${machine.cpus} núcleos`)),
  ]);

  // ---- plano ----
  const plan = data.plan;
  // Uma janela que já renovou: o número é da anterior; o novo chega com a próxima resposta.
  const windowLine = (name: string, entry: { utilization: number; resetsAt: string | Date } | undefined) => {
    if (!entry) return null;
    const resetsAt = new Date(entry.resetsAt);
    if (resetsAt <= now) return h(Text, null, label(name), h(Text, { color: theme.muted }, `renovou ${when(resetsAt, timeZone, now)} · o uso novo chega com a próxima resposta`));
    return meter(name, entry.utilization, barWidth, `${percent(entry.utilization)} · renova ${when(resetsAt, timeZone, now)}`);
  };
  const plano = card(
    "plano",
    "PLANO",
    half,
    plan ? [windowLine("5 horas", plan.fiveHour), windowLine("semana", plan.sevenDay)].filter(Boolean) : [h(Text, { color: theme.muted }, "aparece depois do primeiro turno")],
  );

  // ---- hoje ----
  const today = data.today;
  const origins = Object.entries(today.byTrigger)
    .filter(([, value]) => value > 0)
    .map(([trigger, value]) => `${TRIGGER_LABEL[trigger as keyof typeof TRIGGER_LABEL]} ${value}`)
    .join(" · ");
  const hoje = card("hoje", "HOJE", half, [
    h(
      Text,
      { wrap: "truncate-end" },
      label("turnos"),
      `${today.turns}`,
      today.turns ? h(Text, { color: theme.muted }, ` · ${today.succeeded} ok`) : null,
      today.failed ? h(Text, { color: theme.red }, ` · ${today.failed} ${today.failed === 1 ? "falha" : "falhas"}`) : null,
    ),
    h(Text, { wrap: "truncate-end" }, label("origem"), origins || h(Text, { color: theme.muted }, "nada ainda")),
    h(Text, { wrap: "truncate-end" }, label("trabalho"), duration(today.workMs), today.avgMs ? h(Text, { color: theme.muted }, ` · média ${duration(today.avgMs)}`) : null),
    h(Text, { wrap: "truncate-end" }, label("mensagens"), `${today.messages}`, h(Text, { color: theme.muted }, ` · ${today.fromPerson} ${today.fromPerson === 1 ? "sua" : "suas"}`)),
    h(
      Text,
      { wrap: "truncate-end" },
      label("7 dias"),
      h(Text, { color: theme.accent }, sparkline(data.week.map((day) => day.turns))),
      h(Text, { color: theme.muted }, ` ${plural(data.week.reduce((sum, day) => sum + day.turns, 0), "turno", "turnos")}`),
    ),
  ]);

  // ---- agentes ----
  // As colunas que cabem na largura: as menos importantes saem primeiro.
  const all = [
    { title: "agente", width: Math.min(Math.max(...data.agents.map((agent) => agent.slug.length), 6) + 2, 22), keep: 0 },
    { title: "estado", width: 13, keep: 0 },
    { title: "hoje", width: 6, keep: 1 },
    { title: "trabalho", width: 11, keep: 3 },
    { title: "última vez", width: 12, keep: 2 },
    { title: "memória", width: 17, keep: 4 },
    { title: "notas", width: 8, keep: 5 },
  ];
  const visible = new Set(all.map((_, at) => at));
  for (const drop of all.map((column, at) => ({ at, keep: column.keep })).sort((a, b) => b.keep - a.keep)) {
    const total = [...visible].reduce((sum, at) => sum + all[at]!.width, 0);
    if (total <= options.width - 14 || drop.keep === 0) break;
    visible.delete(drop.at);
  }
  const columns = all.map((column, at) => ({ ...column, width: visible.has(at) ? column.width : 0 }));
  const cell = (text: string, at: number) => (visible.has(at) ? text.padEnd(columns[at]!.width).slice(0, columns[at]!.width) : "");
  const agentes = card("agentes", "AGENTES", options.width, [
    h(Text, { color: theme.muted, wrap: "truncate-end" }, all.map((column, at) => cell(column.title, at)).join("")),
    ...(data.agents.length === 0
      ? [h(Text, { color: theme.muted }, "nenhum agente")]
      : data.agents.map((agent) =>
          h(
            Text,
            { wrap: "truncate-end" },
            h(Text, { bold: true }, cell(agent.slug, 0)),
            h(Text, { color: agent.state === "running" ? theme.green : agent.state === "paused" ? theme.amber : theme.muted }, cell(STATE_LABEL[agent.state], 1)),
            cell(`${agent.turnsToday}`, 2),
            cell(agent.workMsToday ? duration(agent.workMsToday) : "–", 3),
            cell(ago(agent.lastActivityAt, now), 4),
            cell(agent.memoryBytes ? `${bytes(agent.memoryBytes)} · ${agent.memoryLines} lin` : "vazia", 5),
            cell(agent.notesBytes ? bytes(agent.notesBytes) : "–", 6),
            agent.failedToday ? h(Text, { color: theme.red }, `${agent.failedToday} falha${agent.failedToday > 1 ? "s" : ""} hoje`) : null,
          ),
        )),
  ]);

  // ---- rotinas ----
  const routines = data.routines;
  const rotinas = card("rotinas", "ROTINAS", half, [
    h(
      Text,
      null,
      plural(routines.enabled, "ativa", "ativas"),
      routines.disabled ? h(Text, { color: theme.muted }, ` · ${plural(routines.disabled, "desligada", "desligadas")}`) : null,
    ),
    ...routines.next.map((next) =>
      h(Text, { wrap: "truncate-end" }, h(Text, { color: theme.muted }, "○ "), `${when(next.at, timeZone, now)} ${next.title}`, h(Text, { color: theme.muted }, ` · ${next.agent}`)),
    ),
    ...routines.failing.map((failing) =>
      h(Text, { wrap: "truncate-end" }, h(Text, { color: theme.red }, "✗ "), failing.title, h(Text, { color: theme.muted }, ` · ${failing.streak} falha${failing.streak > 1 ? "s" : ""} seguidas`)),
    ),
  ]);

  // ---- retornos e o que precisa de você ----
  const followups = data.followups;
  const pendencias = card("pendencias", "RETORNOS E PENDÊNCIAS", half, [
    h(
      Text,
      { wrap: "truncate-end" },
      label("retornos"),
      followups.pending ? `${followups.pending} agendado${followups.pending > 1 ? "s" : ""}` : h(Text, { color: theme.muted }, "nenhum"),
    ),
    followups.next
      ? h(Text, { wrap: "truncate-end" }, label("próximo"), `${when(followups.next.dueAt, timeZone, now)} ${followups.next.agent}`, h(Text, { color: theme.muted }, ` · ${followups.next.reason}`))
      : null,
    h(
      Text,
      null,
      label("para você"),
      data.attention ? h(Text, { color: theme.amber }, `${data.attention} ${data.attention === 1 ? "item" : "itens"}`) : h(Text, { color: theme.muted }, "nada"),
    ),
  ].filter(Boolean));

  // ---- armazenamento ----
  const storage = data.storage;
  const armazenamento = card("armazenamento", "ARMAZENAMENTO", options.width, [
    h(
      Text,
      { wrap: "truncate-end" },
      label("banco"),
      `${bytes(storage.databaseBytes)} · ${new Intl.NumberFormat("pt-BR").format(storage.messages)} mensagens`,
      h(Text, { color: theme.muted }, "   imagens "),
      `${storage.images} · ${bytes(storage.imagesBytes)}`,
      h(Text, { color: theme.muted }, `   ${storage.home}`),
    ),
  ]);

  const pair = (key: string, left: ReactNode, right: ReactNode) =>
    twoColumns ? h(Box, { key, flexDirection: "row", flexShrink: 0, gap: 3 }, left, right) : h(Box, { key, flexDirection: "column", flexShrink: 0 }, left, right);

  return h(
    Box,
    { flexDirection: "column", flexShrink: 0, paddingTop: 1 },
    pair("a", motor, maquina),
    pair("b", plano, hoje),
    agentes,
    pair("c", rotinas, pendencias),
    armazenamento,
  );
}
