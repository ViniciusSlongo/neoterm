import { dirname } from "node:path";
import { absolutePath } from "../config.ts";
import { describeCron, describeWhen, nextOccurrence, validateSchedule } from "../routines/schedule.ts";
import type { NeotermApi, ViewScope } from "./api.ts";
import type { FormState, Values } from "./form.ts";

/* Os três formulários das telas: novo agente, novo grupo e nova rotina. */

const MODELS = [
  { value: "", label: "padrão" },
  { value: "claude-opus-5-5", label: "opus" },
  { value: "claude-sonnet-5-5", label: "sonnet" },
  { value: "claude-haiku-5-5", label: "haiku" },
];

const text = (values: Values, key: string) => String(values[key] ?? "").trim();
const list = (values: Values, key: string) => (Array.isArray(values[key]) ? (values[key] as string[]) : []);

export function newAgentForm(api: NeotermApi, done: (slug: string) => void, cwd = process.cwd()): FormState {
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
        kind: "textarea",
        value: "",
        cursor: 0,
        placeholder: "o que ele faz, em qualquer conversa",
        hint: "enter quebra a linha · tab segue · dá para mudar depois com :editar",
      },
      {
        key: "folders",
        label: "Pastas",
        kind: "folders",
        value: [],
        placeholder: "nenhuma ainda · escolha na lista ao lado",
        hint: "o escopo dele: só trabalha nestas pastas",
      },
      { key: "model", label: "Modelo", kind: "choice", value: "", options: MODELS },
    ],
    submit: async (values) => {
      const slug = text(values, "slug");
      if (!text(values, "role")) throw new Error("escreva a função dele");
      const paths = list(values, "folders");
      if (paths.length === 0) throw new Error("escolha pelo menos uma pasta na lista: o escopo dele");
      await api.createAgent({
        slug,
        folders: paths.map((path) => absolutePath(path, cwd)),
        title: text(values, "title"),
        role: text(values, "role"),
        ...(text(values, "model") ? { model: text(values, "model") } : {}),
      });
      done(slug);
    },
  };
}

/** O que está no AGENT.md hoje, para o formulário de edição começar preenchido. */
export type AgentFields = { title: string; role: string; model: string | null; folders: string[] };

export function editAgentForm(api: NeotermApi, slug: string, current: AgentFields, done: (deleted: boolean) => void): FormState {
  return {
    title: `editar ${slug}`,
    subtitle: "muda o AGENT.md · vale a partir da próxima resposta",
    index: 0,
    fields: [
      { key: "title", label: "Título", kind: "text", value: current.title, placeholder: "Acompanhamento financeiro" },
      {
        key: "role",
        label: "Função",
        kind: "textarea",
        value: current.role,
        cursor: [...current.role].length,
        placeholder: "o que ele faz, em qualquer conversa",
        hint: "enter quebra a linha · ←→↑↓ andam pelo texto · tab segue",
      },
      {
        key: "folders",
        label: "Pastas",
        kind: "folders",
        value: current.folders,
        ...(current.folders[0] ? { start: dirname(current.folders[0]) } : {}),
        placeholder: "nenhuma · escolha na lista ao lado",
        hint: "o escopo dele: só trabalha nestas pastas",
      },
      { key: "model", label: "Modelo", kind: "choice", value: current.model ?? "", options: MODELS },
    ],
    remove: {
      what: `o agente ${slug}`,
      consequence: "A pasta dele vai para ~/.neoterm/trash (dá para recuperar); as rotinas desligam e ele sai dos grupos.",
      run: async () => {
        await api.deleteAgent(slug);
        done(true);
      },
    },
    submit: async (values) => {
      const folders = list(values, "folders");
      if (!text(values, "role")) throw new Error("a função não pode ficar vazia");
      if (folders.length === 0) throw new Error("escolha pelo menos uma pasta na lista: o escopo dele");
      await api.updateAgent(slug, {
        title: text(values, "title"),
        role: String(values.role ?? ""),
        model: text(values, "model") || null,
        folders,
      });
      done(false);
    },
  };
}

/** O que o grupo é hoje: membros em ordem (o primeiro coordena). */
export type GroupFields = { folder: string; objective: string; members: string[] };

export function editGroupForm(api: NeotermApi, slug: string, agents: string[], current: GroupFields, done: (deleted: boolean) => void): FormState {
  return {
    title: `editar #${slug}`,
    subtitle: "pasta, membros e objetivo",
    index: 0,
    fields: [
      {
        key: "folder",
        label: "Pasta",
        kind: "folders",
        single: true,
        value: [current.folder],
        start: dirname(current.folder),
        placeholder: "nenhuma · escolha na lista ao lado",
        hint: "a pasta do projeto, onde os agentes do grupo trabalham",
      },
      {
        key: "members",
        label: "Membros",
        kind: "multi",
        value: current.members,
        options: [...new Set([...current.members, ...agents])].map((agent) => ({ value: agent, label: agent })),
        cursor: 0,
        hint: "espaço marca e desmarca · o primeiro marcado coordena",
      },
      { key: "objective", label: "Objetivo", kind: "textarea", value: current.objective, cursor: [...current.objective].length, placeholder: "opcional" },
    ],
    remove: {
      what: `o grupo #${slug}`,
      consequence: "O grupo some da lateral; a conversa dele fica guardada e os agentes continuam existindo.",
      run: async () => {
        await api.deleteGroup(slug);
        done(true);
      },
    },
    submit: async (values) => {
      const folder = list(values, "folder")[0];
      if (!folder) throw new Error("escolha a pasta do projeto na lista");
      const members = list(values, "members");
      if (members.length === 0) throw new Error("marque pelo menos um agente");
      await api.updateGroup(slug, { folder, members, objective: String(values.objective ?? "").trim() });
      done(false);
    },
  };
}

export function newGroupForm(api: NeotermApi, agents: string[], done: (slug: string) => void, cwd = process.cwd()): FormState {
  return {
    title: "novo grupo",
    subtitle: "agentes trabalhando juntos num projeto",
    index: 0,
    fields: [
      { key: "slug", label: "Nome", kind: "text", value: "", placeholder: "crm" },
      {
        key: "folder",
        label: "Pasta",
        kind: "folders",
        single: true,
        value: [],
        placeholder: "nenhuma ainda · escolha na lista ao lado",
        hint: "a pasta do projeto, onde os agentes do grupo trabalham",
      },
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
      // Na ordem dos campos na tela.
      const folder = list(values, "folder")[0];
      if (!folder) throw new Error("escolha a pasta do projeto na lista");
      const members = list(values, "members");
      if (members.length === 0) throw new Error("marque pelo menos um agente");
      const slug = text(values, "slug");
      await api.createGroup({
        slug,
        folder: absolutePath(folder, cwd),
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
      hint: "agir: faz o que a rotina pede · só avisar: verifica e informa, sem mudar nada",
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
