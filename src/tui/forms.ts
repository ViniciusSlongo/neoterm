import { DEFAULT_TOOLS, DEFAULT_UNATTENDED_TOOLS } from "../agents/identity.ts";
import { describeCron, describeWhen, nextOccurrence, validateSchedule } from "../routines/schedule.ts";
import type { NeotermApi, ViewScope } from "./api.ts";
import type { FormState, Values } from "./form.ts";

/* Os três formulários das telas: novo agente, novo grupo e nova rotina. */

const TOOL_OPTIONS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch"].map((tool) => ({ value: tool, label: tool }));
const MODELS = [
  { value: "", label: "padrão" },
  { value: "claude-opus-5-5", label: "opus" },
  { value: "claude-sonnet-5-5", label: "sonnet" },
  { value: "claude-haiku-5-5", label: "haiku" },
];

const text = (values: Values, key: string) => String(values[key] ?? "").trim();
const list = (values: Values, key: string) => (Array.isArray(values[key]) ? (values[key] as string[]) : []);

export function newAgentForm(api: NeotermApi, done: (slug: string) => void): FormState {
  return {
    title: "novo agente",
    subtitle: "vira ~/.neoterm/agents/<nome>/AGENT.md",
    index: 0,
    fields: [
      { key: "slug", label: "Nome", kind: "text", value: "", placeholder: "analista", hint: "letras minúsculas, números e -" },
      { key: "title", label: "Título", kind: "text", value: "", placeholder: "Acompanhamento financeiro" },
      {
        key: "role",
        label: "Função",
        kind: "text",
        value: "",
        placeholder: "o que ele faz, em qualquer conversa",
        hint: "dá para detalhar depois no AGENT.md",
      },
      {
        key: "tools",
        label: "Com você",
        kind: "multi",
        value: [...DEFAULT_TOOLS],
        options: TOOL_OPTIONS,
        cursor: 0,
        hint: "←→ escolhe · espaço marca · o que ele pode usar com você por perto",
      },
      {
        key: "unattended",
        label: "Sozinho",
        kind: "multi",
        value: [...DEFAULT_UNATTENDED_TOOLS],
        options: TOOL_OPTIONS,
        cursor: 0,
        hint: "o que ele pode usar em rotinas, sem ninguém olhando",
      },
      { key: "model", label: "Modelo", kind: "choice", value: "", options: MODELS },
    ],
    submit: async (values) => {
      const slug = text(values, "slug");
      if (!text(values, "role")) throw new Error("escreva a função dele");
      const tools = list(values, "tools");
      await api.createAgent({
        slug,
        title: text(values, "title"),
        role: text(values, "role"),
        tools,
        unattended: list(values, "unattended").filter((tool) => tools.includes(tool)),
        ...(text(values, "model") ? { model: text(values, "model") } : {}),
      });
      done(slug);
    },
  };
}

export function newGroupForm(api: NeotermApi, agents: string[], done: (slug: string) => void): FormState {
  return {
    title: "novo grupo",
    subtitle: "agentes trabalhando juntos num projeto",
    index: 0,
    fields: [
      { key: "slug", label: "Nome", kind: "text", value: "", placeholder: "crm" },
      { key: "folder", label: "Pasta", kind: "text", value: "", placeholder: "~/Projects/crm", hint: "a pasta do projeto; é criada se não existir" },
      {
        key: "members",
        label: "Membros",
        kind: "multi",
        value: [],
        options: agents.map((agent) => ({ value: agent, label: agent })),
        cursor: 0,
        hint: "espaço marca · o primeiro marcado coordena · eles se chamam com @nome",
      },
      { key: "objective", label: "Objetivo", kind: "text", value: "", placeholder: "opcional" },
    ],
    submit: async (values) => {
      const members = list(values, "members");
      if (members.length === 0) throw new Error("marque pelo menos um agente");
      if (!text(values, "folder")) throw new Error("diga a pasta do projeto");
      const slug = text(values, "slug");
      await api.createGroup({
        slug,
        folder: text(values, "folder"),
        members,
        ...(text(values, "objective") ? { objective: text(values, "objective") } : {}),
      });
      done(slug);
    },
  };
}

const WEEKDAYS = [
  { value: "1", label: "seg" },
  { value: "2", label: "ter" },
  { value: "3", label: "qua" },
  { value: "4", label: "qui" },
  { value: "5", label: "sex" },
  { value: "6", label: "sáb" },
  { value: "0", label: "dom" },
];

/** O cron que as escolhas do formulário descrevem. */
export function cronFromValues(values: Values): string {
  const frequency = text(values, "frequency");
  if (frequency === "cron") return text(values, "cron");
  const match = /^(\d{1,2}):(\d{2})$/.exec(text(values, "time"));
  if (!match) throw new Error("hora no formato 09:00");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("hora no formato 09:00");
  switch (frequency) {
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${text(values, "weekday")}`;
    case "monthly": {
      const day = Number(text(values, "day"));
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("dia do mês entre 1 e 31");
      return `${minute} ${hour} ${day} * *`;
    }
    default:
      return `${minute} ${hour} * * *`;
  }
}

export function newRoutineForm(
  api: NeotermApi,
  scope: ViewScope,
  members: string[],
  timezone: string,
  done: () => void,
): FormState {
  const fields: FormState["fields"] = [];
  if (scope.kind === "group") {
    fields.push({
      key: "agent",
      label: "Agente",
      kind: "choice",
      value: members[0] ?? "",
      options: members.map((member) => ({ value: member, label: member })),
      hint: "quem faz; a resposta aparece no grupo",
    });
  }
  fields.push(
    { key: "instruction", label: "O que fazer", kind: "text", value: "", placeholder: "em linguagem normal, como você pediria" },
    {
      key: "frequency",
      label: "Quando",
      kind: "choice",
      value: "weekdays",
      options: [
        { value: "daily", label: "todo dia" },
        { value: "weekdays", label: "dias úteis" },
        { value: "weekly", label: "toda semana" },
        { value: "monthly", label: "todo mês" },
        { value: "cron", label: "cron" },
      ],
    },
    { key: "weekday", label: "Dia", kind: "choice", value: "1", options: WEEKDAYS, when: (values) => values.frequency === "weekly" },
    { key: "day", label: "Dia do mês", kind: "text", value: "1", when: (values) => values.frequency === "monthly" },
    { key: "time", label: "Hora", kind: "text", value: "09:00", when: (values) => values.frequency !== "cron" },
    {
      key: "cron",
      label: "Cron",
      kind: "text",
      value: "",
      placeholder: "0 9 * * 1-5",
      hint: "minuto hora dia mês dia-da-semana · no mínimo a cada 15 min",
      when: (values) => values.frequency === "cron",
    },
    {
      key: "mode",
      label: "Ele deve",
      kind: "choice",
      value: "act",
      options: [
        { value: "act", label: "agir" },
        { value: "notify", label: "só me avisar" },
      ],
      hint: "agir: dentro do escopo sozinho · só avisar: lê e informa, sem mudar nada",
    },
    { key: "title", label: "Nome", kind: "text", value: "", placeholder: "resumo-diario" },
  );
  return {
    title: "nova rotina",
    subtitle: scope.kind === "group" ? `em #${scope.slug}` : scope.slug,
    index: 0,
    fields,
    preview: (values) => {
      try {
        const cron = cronFromValues(values);
        validateSchedule(cron, timezone);
        return `próxima: ${describeWhen(nextOccurrence(cron, timezone, new Date()), timezone)} · ${describeCron(cron)} · cron ${cron}`;
      } catch (error) {
        return `⚠ ${(error as Error).message}`;
      }
    },
    submit: async (values) => {
      if (!text(values, "instruction")) throw new Error("diga o que fazer");
      const cron = cronFromValues(values);
      await api.createRoutine({
        agent: scope.kind === "group" ? text(values, "agent") : scope.slug,
        ...(scope.kind === "group" ? { group: scope.slug } : {}),
        title: text(values, "title") || text(values, "instruction").split(/\s+/).slice(0, 3).join("-"),
        instruction: text(values, "instruction"),
        cron,
        mode: values.mode === "notify" ? "notify" : "act",
      });
      done();
    },
  };
}
