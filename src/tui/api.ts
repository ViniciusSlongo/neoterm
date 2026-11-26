import type { Dashboard } from "../dashboard.ts";
import type { Integrations } from "../integrations.ts";
import type { AgentProcess } from "../processes.ts";
import type { AgentFields, GroupFields } from "./forms.ts";
import { readEvents } from "../cli/client.ts";
import { DAEMON_URL } from "../config.ts";
import type { MessageAuthor, MessageMeta, MessagePart, RoutineMode, RunStatus } from "../db/schema.ts";
import type { NeotermEvent } from "../events.ts";
import type { NeotermState } from "../state.ts";

/* O que a interface pede ao motor. Uma interface (e não fetch direto) para os testes trocarem. */

export type ViewScope = { kind: "agent" | "group"; slug: string };

export type ViewMessage = {
  id: string;
  author: MessageAuthor;
  agent?: string | null;
  text: string;
  parts: MessagePart[];
  meta: MessageMeta;
  createdAt: string;
};

export type RoutineItem = {
  id: string;
  title: string;
  instruction: string;
  cron: string;
  timezone: string;
  mode: RoutineMode;
  enabled: boolean;
  nextRunAt: string;
  failureStreak: number;
  agent: string;
  group: string | null;
};

export type RunItem = { id: string; status: RunStatus; error: string | null; durationMs: number | null; startedAt: string };

export type NewAgentInput = { slug: string; folders: string[]; title?: string; role?: string; model?: string; effort?: string };
export type NewGroupInput = { slug: string; folder: string; members: string[]; objective?: string };
export type NewRoutineInput = {
  agent: string;
  group?: string;
  title: string;
  instruction: string;
  cron: string;
  mode: RoutineMode;
};

export type UiSettings = { defaultModel: string; timezone: string; accent?: string; notesPinned?: boolean };

export interface NeotermApi {
  state(): Promise<NeotermState>;
  messages(scope: ViewScope): Promise<ViewMessage[]>;
  send(scope: ViewScope, text: string): Promise<void>;
  routines(): Promise<RoutineItem[]>;
  routineRuns(id: string): Promise<RunItem[]>;
  createRoutine(input: NewRoutineInput): Promise<void>;
  updateRoutine(id: string, patch: { enabled?: boolean }): Promise<void>;
  deleteRoutine(id: string): Promise<void>;
  runRoutine(id: string): Promise<void>;
  createAgent(input: NewAgentInput): Promise<void>;
  createGroup(input: NewGroupInput): Promise<void>;
  setPaused(slug: string, paused: boolean): Promise<void>;
  /** O que está no AGENT.md hoje (para editar) e a edição. */
  agentDefinition(slug: string): Promise<AgentFields>;
  updateAgent(slug: string, patch: { title?: string; role?: string; model?: string | null; effort?: string | null; folders?: string[] }): Promise<void>;
  /** As integrações (MCP), como o Claude Code as vê. */
  integrations(refresh?: boolean): Promise<Integrations>;
  /** O que o grupo é hoje (membros em ordem: o primeiro coordena) e a edição. */
  groupDefinition(slug: string): Promise<GroupFields>;
  updateGroup(slug: string, patch: { folder?: string; objective?: string; members?: string[] }): Promise<void>;
  /** Excluir: o agente vai para a lixeira (~/.neoterm/trash); do grupo, a conversa fica guardada. */
  deleteAgent(slug: string): Promise<void>;
  deleteGroup(slug: string): Promise<void>;
  /** Os processos do agente (o turno e os serviços que ele deixou rodando) e encerrar. */
  processes(slug: string): Promise<{ processes: AgentProcess[]; totalBytes: number }>;
  stopProcesses(slug: string, target: { pids: number[] } | { all: true }): Promise<number[]>;
  /** As preferências (cor da interface, modelo padrão) e a mudança. */
  settings(): Promise<UiSettings>;
  saveSettings(patch: { accent?: string | null; defaultModel?: string; notesPinned?: boolean }): Promise<UiSettings>;
  /** O resumo do painel. */
  dashboard(): Promise<Dashboard>;
  /** As notas de quem usa sobre um agente: o texto e o arquivo onde ficam. */
  notes(slug: string): Promise<{ text: string; path: string }>;
  saveNotes(slug: string, text: string): Promise<void>;
  dismiss(attentionId: string): Promise<void>;
  /** Escuta o motor; reconecta sozinho. Devolve como parar. */
  subscribe(onEvent: (event: NeotermEvent) => void, onConnection: (connected: boolean) => void): () => void;
}

export function httpApi(base: string = DAEMON_URL): NeotermApi {
  const call = async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let json: T & { error?: string };
    try {
      json = (text ? JSON.parse(text) : {}) as T & { error?: string };
    } catch {
      // Os erros do motor vêm em JSON; texto puro num 404 é uma rota que ele não conhece: o motor
      // rodando é de uma versão anterior à da interface.
      if (response.status === 404) throw new Error("o motor está desatualizado: rode neoterm service restart");
      throw new Error(`o motor respondeu ${response.status}: ${text.slice(0, 80)}`);
    }
    if (!response.ok) throw new Error(json.error ?? `o motor respondeu ${response.status}`);
    return json;
  };
  const path = (scope: ViewScope) =>
    scope.kind === "agent" ? `/agents/${encodeURIComponent(scope.slug)}/messages` : `/groups/${encodeURIComponent(scope.slug)}/messages`;

  return {
    state: () => call<NeotermState>("/state"),
    messages: async (scope) => (await call<{ messages: ViewMessage[] }>(`${path(scope)}?limit=200`)).messages,
    send: async (scope, text) => {
      if (scope.kind === "group") {
        await call(path(scope), { body: { text } });
        return;
      }
      // A conversa com um agente responde em SSE; o progresso chega pelos eventos, então só esvazia.
      const response = await fetch(`${base}${path(scope)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? "não enviou");
      void response.text().catch(() => {});
    },
    routines: async () => (await call<{ routines: RoutineItem[] }>("/routines")).routines,
    routineRuns: async (id) => (await call<{ runs: RunItem[] }>(`/routines/${id}/runs?limit=5`)).runs,
    createRoutine: async (input) => void (await call("/routines", { body: input })),
    updateRoutine: async (id, patch) => void (await call(`/routines/${id}`, { method: "PATCH", body: patch })),
    deleteRoutine: async (id) => void (await call(`/routines/${id}`, { method: "DELETE" })),
    runRoutine: async (id) => void (await call(`/routines/${id}/run`, { body: {} })),
    createAgent: async (input) => void (await call("/agents", { body: { ...input, name: input.slug } })),
    createGroup: async (input) => void (await call("/groups", { body: input })),
    setPaused: async (slug, paused) => void (await call(`/agents/${slug}/${paused ? "pause" : "resume"}`, { body: {} })),
    dashboard: () => call<Dashboard>("/dashboard"),
    settings: () => call<UiSettings>("/settings"),
    saveSettings: (patch) => call<UiSettings>("/settings", { method: "PATCH", body: patch }),
    processes: (slug) => call<{ processes: AgentProcess[]; totalBytes: number }>(`/agents/${slug}/processes`),
    stopProcesses: async (slug, target) => (await call<{ stopped: number[] }>(`/agents/${slug}/processes/stop`, { body: target })).stopped,
    integrations: (refresh) => call<Integrations>(`/integrations${refresh ? "?refresh=1" : ""}`),
    groupDefinition: (slug) => call<GroupFields>(`/groups/${slug}/definition`),
    updateGroup: async (slug, patch) => void (await call(`/groups/${slug}`, { method: "PATCH", body: patch })),
    deleteAgent: async (slug) => void (await call(`/agents/${slug}`, { method: "DELETE", body: { confirm: true } })),
    deleteGroup: async (slug) => void (await call(`/groups/${slug}`, { method: "DELETE", body: { confirm: true } })),
    agentDefinition: (slug) => call<AgentFields>(`/agents/${slug}/definition`),
    updateAgent: async (slug, patch) => void (await call(`/agents/${slug}`, { method: "PATCH", body: patch })),
    notes: (slug) => call<{ text: string; path: string }>(`/agents/${slug}/notes`),
    saveNotes: async (slug, text) => void (await call(`/agents/${slug}/notes`, { method: "PUT", body: { text } })),
    dismiss: async (id) => void (await call(`/attention/${id}/resolve`, { body: {} })),
    subscribe(onEvent, onConnection) {
      let stopped = false;
      let controller = new AbortController();
      const loop = async () => {
        while (!stopped) {
          try {
            controller = new AbortController();
            const response = await fetch(`${base}/events`, { signal: controller.signal });
            if (!response.body) throw new Error("sem eventos");
            onConnection(true);
            for await (const { event, data } of readEvents(response.body)) {
              if (event === "ready" || event === "ping") continue;
              onEvent(JSON.parse(data) as NeotermEvent);
            }
          } catch {
            // cai para a reconexão
          }
          if (stopped) return;
          onConnection(false);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      };
      void loop();
      return () => {
        stopped = true;
        controller.abort();
      };
    },
  };
}
