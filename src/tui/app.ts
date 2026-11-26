import { homedir } from "node:os";
import { Box, type DOMElement, Text, useApp, useBoxMetrics, useInput, usePaste, useStdin, useWindowSize } from "ink";
import { createElement as h, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessagePart } from "../db/schema.ts";
import type { NeotermEvent } from "../events.ts";
import { describeCron, describeWhen } from "../routines/schedule.ts";
import type { NeotermState } from "../state.ts";
import type { NeotermApi, RoutineItem, RunItem, ViewMessage, ViewScope } from "./api.ts";
import { type FormState, formKey, renderForm, setFieldValue, valuesOf } from "./form.ts";
import { editAgentForm, editGroupForm, newAgentForm, newGroupForm, newRoutineForm } from "./forms.ts";
import { renderDashboard } from "./dashboard.ts";
import { renderIntegrations } from "./integrations.ts";
import type { Integrations } from "../integrations.ts";
import type { Dashboard } from "../dashboard.ts";
import * as editor from "./editor.ts";
import { clipboardImage, expandImages, pastedImages, shortenImages } from "./images.ts";
import { type Browser, browserKey, load as loadBrowser, newBrowser, renderBrowser } from "./browser.ts";
import { referenceFor } from "./files.ts";
import { renderMarkdown } from "./markdown.ts";
import { parseCommand } from "./commands.ts";
import { renderHelp } from "./help.ts";
import { type ProcessView, renderProcesses } from "./processes.ts";
import { bytes } from "./format.ts";
import { captureMouse } from "./mouse.ts";
import { editKey, followCursor, isNewlineKey, renderLines } from "./textarea.ts";
import { SPINNER, theme } from "./theme.ts";

/*
 * A interface: lateral com agentes, grupos, rotinas de hoje e o que precisa de você; ao lado, a
 * conversa. Tudo vem do motor: o estado por /state, as mudanças por /events.
 */

type Item =
  | { kind: "agent"; slug: string }
  | { kind: "group"; slug: string }
  | { kind: "attention"; id: string }
  | { kind: "dashboard" }
  | { kind: "integrations" }
  | { kind: "new-agent" }
  | { kind: "new-group" };

type Mode = "chat" | "routines" | "form" | "attention" | "processes" | "help";
type Live = { agent: string; parts: MessagePart[] };
/** As notas abertas à direita: as de um agente, com o texto em edição e o que já está no arquivo. */
/** O navegador do :path: o de pastas, mais a conversa de onde abriu e a pasta onde o agente roda. */
type Picker = { scope: string; workspace: string; browser: Browser };
type Notes = { slug: string; draft: editor.Draft; saved: string; path: string; saving: boolean; failed: boolean };
type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

const SIDEBAR_WIDTH = 30;
/** Quantas linhas o input mostra antes de rolar junto com o cursor. */
const INPUT_MAX_LINES = 8;
/** Linhas que a roda do mouse rola por evento. */
const WHEEL_LINES = 3;

const scopeKey = (scope: { kind: string; slug: string }) => `${scope.kind}:${scope.slug}`;

function itemsOf(state: NeotermState | null): Item[] {
  if (!state) return [];
  return [
    ...state.agents.map((agent) => ({ kind: "agent", slug: agent.slug }) as const),
    ...state.groups.map((group) => ({ kind: "group", slug: group.slug }) as const),
    ...state.attention.map((item) => ({ kind: "attention", id: item.id }) as const),
    { kind: "dashboard" },
    { kind: "integrations" },
    { kind: "new-agent" },
    { kind: "new-group" },
  ];
}

function sameItem(a: Item | undefined, b: Item | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "agent" || a.kind === "group") return a.slug === (b as typeof a).slug;
  if (a.kind === "attention") return a.id === (b as typeof a).id;
  return true;
}

function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function truncate(text: string, width: number): string {
  const chars = [...text.replace(/\s+/g, " ")];
  return chars.length > width ? `${chars.slice(0, Math.max(width - 1, 0)).join("")}…` : chars.join("");
}


/** O texto com as menções em destaque. */
function withMentions(text: string, key: string): ReactNode {
  const pieces = text.split(/(@[\p{L}\p{N}_-]+)/u);
  return h(
    Text,
    { key, wrap: "wrap" },
    ...pieces.map((piece, index) =>
      piece.startsWith("@") ? h(Text, { key: index, color: /^@voc[eê]$/i.test(piece) ? theme.amber : theme.accent }, piece) : piece,
    ),
  );
}

function renderParts(parts: MessagePart[], keyPrefix: string): ReactNode[] {
  return parts.flatMap((part, index) => {
    if (part.type === "text") {
      // Cada bloco de texto do agente começa com um ponto; as ferramentas ficam recuadas, sem ele.
      return [
        h(
          Box,
          { key: `${keyPrefix}t${index}`, marginTop: index > 0 ? 1 : 0, flexShrink: 0 },
          // Ponto com largura fixa e texto com base 0: se os dois encolhessem juntos, a largura
          // do texto ficaria fracionária e o ink quebraria a linha uma coluna além do que recorta.
          h(Box, { width: 2, flexShrink: 0 }, h(Text, { color: theme.green }, "●")),
          renderMarkdown(part.text, `${keyPrefix}m${index}`),
        ),
      ];
    }
    const name = part.name.replace(/^mcp__neoterm__/, "");
    const lines = [
      h(
        Text,
        { key: `${keyPrefix}u${index}`, wrap: "truncate-end" },
        h(Text, { color: theme.muted }, `  ⎿ ${name.padEnd(5)}`),
        `  ${part.detail}`,
      ),
    ];
    if (part.error) {
      lines.push(
        h(
          Text,
          { key: `${keyPrefix}e${index}`, wrap: "truncate-end" },
          h(Text, { color: theme.red }, "       ✗ "),
          h(Text, { color: theme.muted }, part.error),
        ),
      );
    }
    return lines;
  });
}

/** O bloco das mensagens de quem usa: fundo e uma barra à esquerda, para não se confundir com as respostas. */
function personBlock(key: string, barColor: string, ...children: ReactNode[]): ReactNode {
  return h(
    Box,
    {
      key,
      flexDirection: "column",
      marginBottom: 1,
      flexShrink: 0,
      paddingX: 1,
      backgroundColor: theme.person,
      borderStyle: "bold",
      borderTop: false,
      borderRight: false,
      borderBottom: false,
      borderColor: barColor,
    },
    ...children,
  );
}

function renderPerson(message: ViewMessage, inGroup: boolean, timeZone: string): ReactNode {
  const header = inGroup
    ? h(Text, null, h(Text, { color: theme.accent, bold: true }, "você"), h(Text, { color: theme.muted }, `  ${clock(message.createdAt, timeZone)}`))
    : null;
  return personBlock(message.id, theme.accent, header, withMentions(shortenImages(message.text), "p"));
}

/**
 * O que você mandou enquanto o agente ainda respondia, num bloco só: "na fila" e as mensagens
 * numeradas, na ordem em que vão ser respondidas (uma por turno).
 */
function renderQueue(texts: readonly string[]): ReactNode {
  return personBlock(
    "queue",
    theme.muted,
    h(Text, { color: theme.muted }, "na fila"),
    ...texts.map((text, position) =>
      h(
        Box,
        { key: position, flexShrink: 0 },
        h(Box, { width: `${texts.length}`.length + 2, flexShrink: 0 }, h(Text, { color: theme.muted }, `${position + 1}.`)),
        h(Box, { flexGrow: 1, flexShrink: 1, flexBasis: 0 }, withMentions(shortenImages(text), `q${position}`)),
      ),
    ),
  );
}

/** Uma consulta de outro agente (ask_agent): quem perguntou e a pergunta, num bloco próprio. */
function renderConsult(message: ViewMessage, timeZone: string): ReactNode {
  return h(
    Box,
    {
      key: message.id,
      flexDirection: "column",
      marginBottom: 1,
      flexShrink: 0,
      paddingX: 1,
      borderStyle: "bold",
      borderTop: false,
      borderRight: false,
      borderBottom: false,
      borderColor: theme.amber,
    },
    h(
      Text,
      null,
      h(Text, { color: theme.amber, bold: true }, `${message.meta.fromAgent} pergunta`),
      h(Text, { color: theme.muted }, `  ${clock(message.createdAt, timeZone)} · consulta de outro agente`),
    ),
    withMentions(message.text, "c"),
  );
}

function renderMessage(message: ViewMessage, inGroup: boolean, timeZone: string): ReactNode {
  const time = h(Text, { color: theme.muted }, `  ${clock(message.createdAt, timeZone)}`);
  if (message.meta.fromAgent) return renderConsult(message, timeZone);
  switch (message.author) {
    case "person":
      return renderPerson(message, inGroup, timeZone);
    case "routine":
      return h(
        Box,
        { key: message.id, flexDirection: "column", flexShrink: 0, marginBottom: 1 },
        h(
          Text,
          null,
          h(Text, { color: theme.accent }, `◷ rotina ${message.meta.routineTitle ?? ""}`),
          h(Text, { color: theme.muted }, `${inGroup && message.agent ? ` · ${message.agent}` : ""} · ${clock(message.createdAt, timeZone)}`),
        ),
        h(Box, { paddingLeft: 2 }, h(Text, { color: theme.muted, wrap: "wrap" }, message.text)),
      );
    case "system":
      return h(
        Box,
        { key: message.id, marginBottom: 1, flexShrink: 0 },
        h(Text, { wrap: "wrap" }, h(Text, { color: theme.amber }, "! "), h(Text, { color: theme.muted }, message.text)),
      );
    default:
      return h(
        Box,
        { key: message.id, flexDirection: "column", marginBottom: 1, flexShrink: 0 },
        inGroup ? h(Text, null, h(Text, { bold: true }, message.agent ?? "agente"), time) : null,
        ...renderParts(message.parts.length > 0 ? message.parts : [{ type: "text", text: message.text }], message.id),
      );
  }
}

/** Uma caixa que não encolhe: quando falta altura, quem corta é o contêiner, não as linhas. */
function keep(key: string, ...children: ReactNode[]): ReactNode {
  return h(Box, { key, flexShrink: 0, flexDirection: "column" }, ...children);
}

function useDebounced(callback: () => void, ms: number): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(), ms);
  }, [ms]);
}

/**
 * `cwd`: de onde a interface foi aberta; um caminho relativo digitado num formulário parte dela.
 * `readClipboardImage`: lê a imagem do clipboard no ctrl+v (trocável nos testes).
 */
export function App({
  api,
  cwd = process.cwd(),
  readClipboardImage = clipboardImage,
}: {
  api: NeotermApi;
  cwd?: string;
  readClipboardImage?: () => Promise<string | null>;
}): ReactNode {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = size.columns || 100;
  const rows = size.rows || 30;
  const [state, setState] = useState<NeotermState | null>(null);
  const [connected, setConnected] = useState(true);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<"sidebar" | "main" | "notes" | "files">("main");
  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const [live, setLive] = useState<Record<string, Live>>({});
  const [draft, setDraft] = useState<editor.Draft>(editor.EMPTY);
  // As imagens coladas no rascunho, pelo número que aparece no input: [imagem N].
  const images = useRef(new Map<number, string>());
  // Quantas linhas acima do fim da conversa a vista está; 0 acompanha as mensagens novas.
  const [scrollUp, setScrollUp] = useState(0);
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const maxScroll = Math.max(content.height - viewport.height, 0);
  const lastContentHeight = useRef(0);
  const [form, setFormState] = useState<FormState | null>(null);
  // O formulário mais recente, mesmo antes de renderizar: teclas que chegam juntas (uma tecla
  // segurada, uma colagem) partem cada uma do resultado da anterior, e não se atropelam.
  const formRef = useRef(form);
  const formViewportRef = useRef<DOMElement>(null);
  const formContentRef = useRef<DOMElement>(null);
  const formViewport = useBoxMetrics(formViewportRef);
  const formContent = useBoxMetrics(formContentRef);
  const setForm = (next: FormState | null) => {
    formRef.current = next;
    setFormState(next);
  };
  const [routines, setRoutines] = useState<RoutineItem[]>([]);
  const [routineIndex, setRoutineIndex] = useState(0);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const formReturn = useRef<Mode>("chat");

  const items = useMemo(() => itemsOf(state), [state]);
  const index = Math.min(selected, Math.max(items.length - 1, 0));
  const item = items[index];
  const scope: ViewScope | null = item && (item.kind === "agent" || item.kind === "group") ? { kind: item.kind, slug: item.slug } : null;
  const currentKey = scope ? scopeKey(scope) : "";
  const currentRef = useRef(currentKey);
  currentRef.current = currentKey;
  const wantSelect = useRef<Item | undefined>(undefined);
  const timeZone = state?.timezone ?? "America/Sao_Paulo";

  const say = useCallback((text: string) => {
    setFlash(text);
    setTimeout(() => setFlash((current) => (current === text ? null : current)), 4000);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, [api]);
  const refreshStateSoon = useDebounced(() => void refreshState(), 120);

  const loadMessages = useCallback(async () => {
    const key = currentRef.current;
    if (!key) return;
    const [kind, slug] = key.split(":") as ["agent" | "group", string];
    try {
      const list = await api.messages({ kind, slug });
      if (currentRef.current !== key) return;
      setMessages(list);
      setPending((current) => {
        const waiting = current[key] ?? [];
        const recent = list.filter((message) => message.author === "person").slice(-waiting.length - 2).map((message) => message.text);
        const left = waiting.filter((text) => !recent.includes(text));
        return { ...current, [key]: left };
      });
    } catch (error) {
      say((error as Error).message);
    }
  }, [api, say]);
  const loadMessagesSoon = useDebounced(() => void loadMessages(), 80);

  const loadRoutines = useCallback(async () => {
    try {
      setRoutines(await api.routines());
    } catch (error) {
      say((error as Error).message);
    }
  }, [api, say]);

  // O motor avisa o que mudou; a interface busca de novo o que precisa.
  useEffect(() => {
    void refreshState();
    const onEvent = (event: NeotermEvent) => {
      if (event.type === "turn") {
        const key = scopeKey(event.scope);
        setLive((current) => {
          const next = { ...current };
          const turn = event.event;
          if (turn.type === "start") next[key] = { agent: event.agent, parts: [] };
          else if (turn.type === "done" || turn.type === "error") delete next[key];
          else {
            const existing = next[key] ?? { agent: event.agent, parts: [] };
            const parts = [...existing.parts];
            if (turn.type === "text") parts.push({ type: "text", text: turn.text });
            if (turn.type === "tool") parts.push({ type: "tool", name: turn.name, detail: turn.detail });
            if (turn.type === "tool_error") {
              const last = parts.findLastIndex((part) => part.type === "tool" && part.name === turn.name);
              const part = parts[last];
              if (part?.type === "tool") parts[last] = { ...part, error: turn.error };
            }
            next[key] = { ...existing, parts };
          }
          return next;
        });
        if (event.event.type === "error" && key === currentRef.current) say(`${event.agent}: ${event.event.message}`);
        return;
      }
      if (event.type === "changed") {
        if (event.what === "messages" && event.scope) {
          const key = scopeKey(event.scope);
          if (key === currentRef.current) loadMessagesSoon();
          else setUnread((current) => new Set(current).add(key));
        }
        if (event.what === "routines") void loadRoutines();
        refreshStateSoon();
        return;
      }
      if (event.type === "plan_usage") refreshStateSoon();
    };
    const stop = api.subscribe(onEvent, (isConnected) => {
      setConnected(isConnected);
      if (isConnected) refreshStateSoon();
    });
    const periodic = setInterval(() => void refreshState(), 30_000);
    return () => {
      stop();
      clearInterval(periodic);
    };
  }, [api, refreshState, refreshStateSoon, loadMessagesSoon, loadRoutines, say]);

  // Ao trocar de conversa: carrega e marca como lida.
  useEffect(() => {
    setMessages([]);
    setScrollUp(0);
    if (!currentKey) return;
    setUnread((current) => {
      if (!current.has(currentKey)) return current;
      const next = new Set(current);
      next.delete(currentKey);
      return next;
    });
    void loadMessages();
  }, [currentKey, loadMessages]);

  // Depois de criar algo, seleciona o que foi criado.
  useEffect(() => {
    if (!wantSelect.current) return;
    const at = items.findIndex((candidate) => sameItem(candidate, wantSelect.current));
    if (at >= 0) {
      setSelected(at);
      wantSelect.current = undefined;
    }
  }, [items]);

  // Quem está trabalhando agora: pelo estado do motor e pelos turnos chegando ao vivo (que avisam
  // antes do próximo /state), inclusive turnos dentro de grupos.
  const working = useMemo(() => {
    const slugs = new Set(Object.values(live).map((entry) => entry.agent));
    for (const agent of state?.agents ?? []) if (agent.state === "running") slugs.add(agent.slug);
    return slugs;
  }, [live, state]);
  const anyLive = working.size > 0 || (state?.groups.some((group) => group.busy) ?? false);
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [anyLive]);

  // Lendo mais acima, a vista fica onde está quando chega conteúdo novo embaixo.
  useEffect(() => {
    const grew = content.height - lastContentHeight.current;
    lastContentHeight.current = content.height;
    if (grew > 0) setScrollUp((value) => (value > 0 ? value + grew : 0));
  }, [content.height]);
  const scrollBy = (lines: number) => setScrollUp((value) => Math.min(Math.max(value + lines, 0), maxScroll));

  // ---------- páginas: painel e integrações ----------
  const isDashboard = item?.kind === "dashboard";
  const isIntegrations = item?.kind === "integrations";
  const isPage = isDashboard || isIntegrations;
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  // As páginas rolam de cima para baixo: quantas linhas do topo já passaram.
  const [pageTop, setPageTop] = useState(0);
  const scrollPage = (lines: number) => setPageTop((value) => Math.min(Math.max(value + lines, 0), maxScroll));
  useEffect(() => setPageTop(0), [item?.kind, mode]);
  // Aberto, o painel se atualiza a cada 5 segundos.
  useEffect(() => {
    if (!isDashboard) return;
    let alive = true;
    const load = () =>
      api.dashboard().then(
        (data) => {
          if (!alive) return;
          setDashboard(data);
          setDashboardError(null);
        },
        (error: Error) => alive && setDashboardError(error.message),
      );
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, isDashboard]);

  // As integrações: o Claude Code testa cada uma, então só ao abrir a tela e quando se pede (r).
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [integrationsLoading, setIntegrationsLoading] = useState(false);
  const loadIntegrations = useCallback(
    (refresh = false) => {
      setIntegrationsLoading(true);
      api.integrations(refresh).then(
        (data) => {
          setIntegrations(data);
          setIntegrationsError(null);
          setIntegrationsLoading(false);
        },
        (error: Error) => {
          setIntegrationsError(error.message);
          setIntegrationsLoading(false);
        },
      );
    },
    [api],
  );
  useEffect(() => {
    if (isIntegrations) loadIntegrations();
  }, [isIntegrations, loadIntegrations]);

  // A roda do mouse rola a conversa, de onde estiver o foco.
  const { stdin } = useStdin();
  const onWheel = useRef((_direction: 1 | -1) => {});
  onWheel.current = (direction) => {
    if (isPage || mode === "help") return scrollPage(-direction * WHEEL_LINES);
    if (mode === "chat") scrollBy(direction * WHEEL_LINES);
  };
  useEffect(() => captureMouse(stdin, (direction) => onWheel.current(direction)), [stdin]);

  const scopedRoutines = useMemo(
    () =>
      !scope
        ? []
        : routines.filter((routine) => (scope.kind === "agent" ? routine.agent === scope.slug : routine.group === scope.slug)),
    [routines, scope?.kind, scope?.slug],
  );
  const routine = scopedRoutines[Math.min(routineIndex, Math.max(scopedRoutines.length - 1, 0))];
  useEffect(() => {
    if (mode !== "routines" || !routine) {
      setRuns([]);
      return;
    }
    void api.routineRuns(routine.id).then(setRuns, () => setRuns([]));
  }, [api, mode, routine?.id, routine?.failureStreak, routine?.enabled]);

  // De onde o formulário foi aberto: ao salvar ou cancelar, volta para lá (a lateral, se foi de lá).
  const formReturnFocus = useRef<typeof focus>("main");
  const openForm = (next: FormState) => {
    formReturn.current = mode === "routines" ? "routines" : "chat";
    formReturnFocus.current = focus === "sidebar" ? "sidebar" : "main";
    setForm(next);
    setMode("form");
    setFocus("main");
  };
  const agentNames = state?.agents.map((agent) => agent.slug) ?? [];
  const openAgentForm = () =>
    openForm(
      newAgentForm(api, (slug) => {
        wantSelect.current = { kind: "agent", slug };
        say(`agente ${slug} criado`);
      }, cwd),
    );
  /** Edita (ou exclui) um agente ou um grupo: o formulário começa com o que ele é hoje. */
  const openEditForm = (target: { kind: "agent" | "group"; slug: string }) => {
    const { slug } = target;
    const finished = (deleted: boolean, label: string) => {
      say(deleted ? `${label} excluído` : target.kind === "agent" ? `${label} atualizado: vale a partir da próxima resposta` : `${label} atualizado`);
      void refreshState();
    };
    if (target.kind === "agent") {
      return void api.agentDefinition(slug).then(
        (current) => openForm(editAgentForm(api, slug, current, (deleted) => finished(deleted, slug))),
        (error: Error) => say(`não abri ${slug} para editar: ${error.message}`),
      );
    }
    void api.groupDefinition(slug).then(
      (current) => openForm(editGroupForm(api, slug, agentNames, current, (deleted) => finished(deleted, `#${slug}`))),
      (error: Error) => say(`não abri #${slug} para editar: ${error.message}`),
    );
  };
  const openGroupForm = () => {
    if (agentNames.length === 0) return say("crie um agente antes");
    openForm(
      newGroupForm(api, agentNames, (slug) => {
        wantSelect.current = { kind: "group", slug };
        say(`grupo #${slug} criado`);
      }, cwd),
    );
  };
  const openRoutineForm = () => {
    if (!scope) return;
    const members = scope.kind === "group" ? (state?.groups.find((group) => group.slug === scope.slug)?.members ?? []) : [];
    openForm(
      newRoutineForm(api, scope, members, timeZone, () => {
        say("rotina criada");
        void loadRoutines();
      }),
    );
  };
  // ---------- processos do agente ----------
  const [processes, setProcesses] = useState<ProcessView | null>(null);
  const [processesError, setProcessesError] = useState<string | null>(null);
  const [processIndex, setProcessIndex] = useState(0);
  const [confirmStop, setConfirmStop] = useState<"one" | "all" | null>(null);
  const [processExpanded, setProcessExpanded] = useState(false);
  useEffect(() => setProcessExpanded(false), [processIndex]);
  const processAgent = scope?.kind === "agent" ? scope.slug : null;
  const agentBusy = processAgent ? (state?.agents.find((agent) => agent.slug === processAgent)?.state === "running" || working.has(processAgent)) : false;
  const loadProcesses = useCallback(() => {
    if (!processAgent) return;
    const slug = processAgent;
    api.processes(slug).then(
      (data) => {
        if (currentRef.current !== `agent:${slug}`) return;
        setProcesses(data);
        setProcessesError(null);
      },
      (error: Error) => setProcessesError(error.message),
    );
  }, [api, processAgent]);
  // Lê na tela de processos (a cada 3 s) e, na conversa, enquanto ele trabalha (para a memória no cabeçalho).
  useEffect(() => {
    setProcesses(null);
    setProcessIndex(0);
    setConfirmStop(null);
  }, [processAgent]);
  useEffect(() => {
    if (!processAgent || (mode !== "processes" && !(mode === "chat" && agentBusy))) return;
    loadProcesses();
    const timer = setInterval(loadProcesses, mode === "processes" ? 3000 : 5000);
    return () => clearInterval(timer);
  }, [processAgent, mode, agentBusy, loadProcesses]);
  // Ao terminar o turno, uma leitura final: o que ficou rodando continua no cabeçalho.
  useEffect(() => {
    if (processAgent && !agentBusy) loadProcesses();
  }, [agentBusy, processAgent, loadProcesses]);

  const openProcesses = () => {
    if (!scope || scope.kind !== "agent") return say("processos são de cada agente: abra a conversa com um");
    setProcessIndex(0);
    setConfirmStop(null);
    setMode("processes");
    setFocus("main");
    loadProcesses();
  };

  const handleProcesses = (input: string, key: InkKey) => {
    const list = processes?.processes ?? [];
    if (confirmStop) {
      const confirmed = (confirmStop === "one" && input === "x") || (confirmStop === "all" && input === "X");
      const kind = confirmStop;
      setConfirmStop(null);
      if (!confirmed || !processAgent) return;
      const target = kind === "all" ? ({ all: true } as const) : { pids: [list[processIndex]?.pid ?? -1] };
      return void api.stopProcesses(processAgent, target).then(
        (stopped) => {
          say(stopped.length ? `encerrado${stopped.length > 1 ? `s ${stopped.length} processos` : ""}` : "nada para encerrar");
          loadProcesses();
        },
        (error: Error) => setProcessesError(error.message),
      );
    }
    if (key.escape || key.tab) return setMode("chat");
    if (key.upArrow || input === "k") return setProcessIndex((value) => Math.max(value - 1, 0));
    if (key.downArrow || input === "j") return setProcessIndex((value) => Math.min(value + 1, Math.max(list.length - 1, 0)));
    if (input === "r") return loadProcesses();
    if (key.return) return setProcessExpanded((value) => !value);
    if (input === "x" && list[processIndex]) return setConfirmStop("one");
    if (input === "X" && list.some((entry) => entry.kind === "service")) return setConfirmStop("all");
  };

  // ---------- ajuda ----------
  const helpReturn = useRef<{ mode: Mode; focus: typeof focus }>({ mode: "chat", focus: "main" });
  const openHelp = () => {
    helpReturn.current = { mode: mode === "help" ? "chat" : mode, focus: focus === "notes" || focus === "files" ? "main" : focus };
    setMode("help");
    setFocus("main");
  };
  const closeHelp = () => {
    setMode(helpReturn.current.mode);
    setFocus(helpReturn.current.focus);
  };

  const openRoutines = () => {
    if (!scope) return;
    void loadRoutines();
    setRoutineIndex(0);
    setMode("routines");
    setFocus("main");
  };
  const closeForm = () => {
    setForm(null);
    setMode(formReturn.current);
    setFocus(formReturnFocus.current);
  };
  const move = (step: number) => {
    setSelected((value) => Math.min(Math.max(Math.min(value, items.length - 1) + step, 0), Math.max(items.length - 1, 0)));
    setMode((current) => (current === "form" ? current : "chat"));
  };
  const attentionItem = item?.kind === "attention" ? state?.attention.find((entry) => entry.id === item.id) : undefined;

  const run = (work: Promise<unknown>, done?: string) =>
    void work.then(
      () => {
        if (done) say(done);
        void refreshState();
      },
      (error: Error) => say(error.message),
    );

  const clearDraft = () => {
    setDraft(editor.EMPTY);
    images.current = new Map();
  };
  const edit = (change: (current: editor.Draft) => editor.Draft) => setDraft(change);

  const attach = (paths: string[]) => {
    const tokens = paths.map((path) => {
      const n = images.current.size + 1;
      images.current.set(n, path);
      return `[imagem ${n}]`;
    });
    edit((current) => {
      const before = [...current.text].slice(0, current.cursor).join("");
      return editor.insert(current, `${before && !/\s$/.test(before) ? " " : ""}${tokens.join(" ")} `);
    });
  };

  /** A imagem do clipboard: o terminal não a repassa, então a interface vai buscar. */
  const pasteClipboardImage = () =>
    void readClipboardImage().then(
      (path) => (path ? attach([path]) : say("nenhuma imagem no clipboard")),
      (error: Error) => say(`não consegui ler o clipboard: ${error.message}`),
    );

  /** Texto colado: vazio é imagem no clipboard; caminhos de imagem viram [imagem N]; o resto é texto. */
  const paste = (text: string) => {
    if (!text.trim()) return pasteClipboardImage();
    const paths = pastedImages(text);
    if (paths) return attach(paths);
    edit((current) => editor.insert(current, text.replace(/\r\n?/g, "\n")));
  };

  const send = () => {
    // :path no fim de uma mensagem começada abre o navegador sem enviar: o arquivo entra ali.
    const typed = draft.text.trimEnd();
    if (scope && /(^|\s):path$/.test(typed)) {
      const kept = typed.slice(0, -":path".length);
      setDraft({ text: kept, cursor: [...kept].length });
      return openPicker();
    }
    const text = expandImages(draft.text, images.current).trim();
    if (!text || !scope) return;
    clearDraft();
    // Comandos: com : ou / na frente (:notas, /notas).
    switch (parseCommand(text)) {
      case "ajuda":
        return openHelp();
      case "rotinas":
        return openRoutines();
      case "processos":
        return openProcesses();
      case "painel":
        return openDashboard();
      case "mcp":
        return openIntegrations();
      case "editar":
        return openEditForm(scope);
      case "path":
        return openPicker();
      case "notas":
        if (scope.kind !== "agent") return say("as notas são de cada agente: abra a conversa com um");
        return openNotes(scope.slug);
      case "pausar":
      case "retomar": {
        if (scope.kind !== "agent") return say("só agentes pausam");
        const pause = parseCommand(text) === "pausar";
        return run(api.setPaused(scope.slug, pause), pause ? `${scope.slug} pausado` : `${scope.slug} retomado`);
      }
      case null:
        break;
    }
    const key = scopeKey(scope);
    setPending((current) => ({ ...current, [key]: [...(current[key] ?? []), text] }));
    setScrollUp(0);
    void api.send(scope, text).catch((error: Error) => {
      say(error.message);
      setPending((current) => ({ ...current, [key]: (current[key] ?? []).filter((entry) => entry !== text) }));
    });
  };

  // ---------- navegador de pastas do formulário ----------
  // Enquanto o campo de pastas está ativo, um navegador do computador todo (só pastas) fica ao lado.
  const [formBrowser, setFormBrowserState] = useState<Browser | null>(null);
  const formBrowserRef = useRef(formBrowser);
  const setFormBrowser = (next: Browser | null | ((current: Browser | null) => Browser | null)) => {
    const value = typeof next === "function" ? next(formBrowserRef.current) : next;
    formBrowserRef.current = value;
    setFormBrowserState(value);
  };
  const formBrowserAreaRef = useRef<DOMElement>(null);
  const formBrowserArea = useBoxMetrics(formBrowserAreaRef);
  const activeField = mode === "form" && form ? form.fields[form.index] : undefined;
  // A lista abre ao chegar no campo de pastas; esc fecha (fica o que foi escolhido) e o próximo esc
  // já é do formulário. → abre de novo, e voltar ao campo também.
  const [formBrowserOpen, setFormBrowserOpen] = useState(true);
  useEffect(() => setFormBrowserOpen(true), [mode, form?.index]);
  const choosingFolders = activeField?.kind === "folders" && formBrowserOpen;
  useEffect(() => {
    if (mode !== "form") return setFormBrowser(null);
    if (!choosingFolders || formBrowser) return;
    const start = activeField?.kind === "folders" && activeField.start ? activeField.start : cwd;
    void loadBrowser(newBrowser(["/"], { dirsOnly: true }), start).then((browser) =>
      setFormBrowser((current) => current ?? browser),
    );
  }, [mode, choosingFolders, formBrowser, cwd]);

  /** As teclas de navegar vão para o navegador; tab, ctrl+s e esc seguem para o formulário. */
  const handleFolderField = (input: string, key: InkKey): boolean => {
    const current = formRef.current;
    const field = current?.fields[current.index];
    const browser = formBrowserRef.current;
    if (!current || !browser || !formBrowserOpen || field?.kind !== "folders") return false;
    if (key.tab || (key.ctrl && input === "s")) return false;
    const toggle = (path: string) => {
      const chosen = field.value;
      const value = chosen.includes(path) ? chosen.filter((entry) => entry !== path) : field.single ? [path] : [...chosen, path];
      setForm(setFieldValue(current, field.key, value));
    };
    // Espaço escolhe (de novo, desmarca); enter e → entram na pasta; esc fecha a lista.
    const action = browserKey(browser, input, key, Math.max(formBrowserArea.height - 1, 1));
    if (action.type === "state") setFormBrowser(action.browser);
    else if (action.type === "load") void loadBrowser(action.browser, action.dir, action.select).then(setFormBrowser);
    else if (action.type === "mark") toggle(action.entry.path);
    else if (action.type === "close") setFormBrowserOpen(false);
    else return false;
    return true;
  };

  const handleForm = (input: string, key: InkKey) => {
    const form = formRef.current;
    if (!form || form.busy) return;
    if (form.fields[form.index]?.kind === "folders" && !formBrowserOpen && key.rightArrow) return setFormBrowserOpen(true);
    // Excluir: ctrl+d pede confirmação; o segundo ctrl+d exclui; qualquer outra tecla desiste.
    if (form.remove && key.ctrl && input === "d") {
      if (!form.confirmingRemove) return setForm({ ...form, confirmingRemove: true, error: undefined });
      const removing = { ...form, busy: true, confirmingRemove: false };
      setForm(removing);
      return void form.remove.run().then(
        () => closeForm(),
        (error: Error) => setForm({ ...removing, busy: false, error: error.message }),
      );
    }
    if (form.confirmingRemove) return setForm({ ...form, confirmingRemove: false });
    if (handleFolderField(input, key)) return;
    const action = formKey(form, input, key);
    if (action.type === "cancel") return closeForm();
    if (action.type === "state") return setForm(action.form);
    const submitting = { ...form, busy: true, error: undefined };
    setForm(submitting);
    form.submit(valuesOf(form)).then(
      () => {
        closeForm();
        // Criou um agente ou grupo: vai direto para a conversa dele (cancelar volta de onde veio).
        if (wantSelect.current) setFocus("main");
        void refreshState();
      },
      (error: Error) => setForm({ ...submitting, busy: false, error: error.message }),
    );
  };

  const openPage = (kind: "dashboard" | "integrations") => {
    const at = items.findIndex((candidate) => candidate.kind === kind);
    if (at < 0) return;
    setSelected(at);
    setMode("chat");
    setFocus("main");
  };
  const openDashboard = () => openPage("dashboard");
  const openIntegrations = () => openPage("integrations");

  const activate = () => {
    if (!item) return;
    if (item.kind === "new-agent") return openAgentForm();
    if (item.kind === "new-group") return openGroupForm();
    setMode(item.kind === "attention" ? "attention" : "chat");
    setFocus("main");
  };

  const handleSidebar = (input: string, key: InkKey) => {
    if (key.upArrow) return move(-1);
    if (key.downArrow) return move(1);
    if (key.return || key.tab || key.rightArrow) return activate();
    if (input === "q") return exit();
    if (input === "n") return openAgentForm();
    if (input === "g") return openGroupForm();
    if (input === "r") return openRoutines();
    if (input === "s" && item?.kind === "agent") return openProcesses();
    if (input === "d") return openDashboard();
    if (input === "?") return openHelp();
    if (input === "i") return openIntegrations();
    if (input === "e" && (item?.kind === "agent" || item?.kind === "group")) return openEditForm({ kind: item.kind, slug: item.slug });
    if (input === "p" && item?.kind === "agent") {
      const paused = state?.agents.find((agent) => agent.slug === item.slug)?.state === "paused";
      return run(api.setPaused(item.slug, !paused), paused ? `${item.slug} retomado` : `${item.slug} pausado: rotinas e retornos esperam`);
    }
    if (attentionItem) return handleAttention(input, key);
  };

  const handleAttention = (input: string, key: InkKey) => {
    if (!attentionItem) return;
    if (input === "x") return run(api.dismiss(attentionItem.id), "dispensado");
    if (key.return) {
      const target: Item | undefined = attentionItem.group
        ? { kind: "group", slug: attentionItem.group }
        : attentionItem.agent
          ? { kind: "agent", slug: attentionItem.agent }
          : undefined;
      const at = target ? items.findIndex((candidate) => sameItem(candidate, target)) : -1;
      if (at >= 0) {
        setSelected(at);
        setMode(attentionItem.routineId ? "routines" : attentionItem.kind === "idle_services" ? "processes" : "chat");
        if (attentionItem.routineId) void loadRoutines();
        setFocus("main");
      }
    }
    if (key.escape || key.tab) setFocus("sidebar");
  };

  const handleRoutines = (input: string, key: InkKey) => {
    if (key.escape || key.tab) {
      setMode("chat");
      return;
    }
    if (key.upArrow) return setRoutineIndex((value) => Math.max(Math.min(value, scopedRoutines.length - 1) - 1, 0));
    if (key.downArrow) return setRoutineIndex((value) => Math.min(value + 1, Math.max(scopedRoutines.length - 1, 0)));
    if (input === "n") return openRoutineForm();
    if (!routine) return;
    if (input === " ") return run(api.updateRoutine(routine.id, { enabled: !routine.enabled }), routine.enabled ? "desligada" : "ligada");
    if (input === "x") return run(api.runRoutine(routine.id), `${routine.title} disparada`);
    if (input === "d") {
      if (confirmDelete === routine.id) {
        setConfirmDelete(null);
        return run(api.deleteRoutine(routine.id), `${routine.title} apagada`);
      }
      setConfirmDelete(routine.id);
      say("aperte d de novo para apagar");
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  };

  const handleChat = (input: string, key: InkKey) => {
    if (key.escape || key.tab) return setFocus("sidebar");
    if (isNewlineKey(input, key)) return edit((current) => editor.insert(current, "\n"));
    if (key.return) return send();
    // ↑↓ sem texto trocam de conversa; com texto, andam pelas linhas.
    if (key.upArrow && !draft.text) return move(-1);
    if (key.downArrow && !draft.text) return move(1);
    if (key.pageUp) return scrollBy(Math.max(viewport.height - 2, 1));
    if (key.pageDown) return scrollBy(-Math.max(viewport.height - 2, 1));
    if (key.ctrl && input === "v") return pasteClipboardImage();
    if (key.ctrl && input === "r") return openRoutines();
    // Sem bracketed paste, a colagem chega aqui como um bloco de vários caracteres.
    if (input.length > 1 && !key.ctrl && !key.meta && !key.return) return paste(input);
    // Sempre a partir do estado mais recente: teclas que chegam juntas não se atropelam.
    setDraft((current) => editKey(current, input, key) ?? current);
  };

  // ---------- notas ----------
  const [notes, setNotes] = useState<Notes | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const notesTop = useRef(0);
  const notesAreaRef = useRef<DOMElement>(null);
  const notesArea = useBoxMetrics(notesAreaRef);

  /** Grava o que mudou; quem continuar editando enquanto isso fica com "não salvo". */
  const saveNotes = useCallback(
    async (current: Notes | null) => {
      if (!current || current.draft.text === current.saved) return;
      const { slug } = current;
      const text = current.draft.text;
      const update = (change: (entry: Notes) => Notes) => setNotes((entry) => (entry && entry.slug === slug ? change(entry) : entry));
      update((entry) => ({ ...entry, saving: true }));
      try {
        await api.saveNotes(slug, text);
        update((entry) => ({ ...entry, saved: text, saving: false, failed: false }));
      } catch (error) {
        update((entry) => ({ ...entry, saving: false, failed: true }));
        say(`não salvei as notas: ${(error as Error).message}`);
      }
    },
    [api, say],
  );

  // Salva sozinho logo depois que você para de digitar.
  useEffect(() => {
    if (!notes || notes.draft.text === notes.saved) return;
    const timer = setTimeout(() => void saveNotes(notesRef.current), 600);
    return () => clearTimeout(timer);
  }, [notes?.draft.text, notes?.saved, saveNotes]);
  // E ao fechar a interface.
  useEffect(() => () => void saveNotes(notesRef.current), [saveNotes]);

  const openNotes = (slug: string) => {
    if (notesRef.current?.slug === slug) return setFocus("notes");
    void saveNotes(notesRef.current);
    api.notes(slug).then(
      ({ text, path }) => {
        notesTop.current = 0;
        setNotes({ slug, draft: { text, cursor: [...text].length }, saved: text, path, saving: false, failed: false });
        setFocus("notes");
      },
      (error: Error) => say(`não abri as notas: ${error.message}`),
    );
  };
  const closeNotes = () => {
    void saveNotes(notesRef.current);
    setNotes(null);
    setFocus("main");
  };
  // As notas são do agente da conversa: trocou de conversa, elas fecham (salvas).
  useEffect(() => {
    const open = notesRef.current;
    if (open && currentKey !== `agent:${open.slug}`) {
      void saveNotes(open);
      setNotes(null);
      setFocus((value) => (value === "notes" ? "main" : value));
    }
  }, [currentKey, saveNotes]);

  const editNotes = (change: (draft: editor.Draft) => editor.Draft) =>
    setNotes((entry) => (entry ? { ...entry, draft: change(entry.draft) } : entry));

  const handleNotes = (input: string, key: InkKey) => {
    if (key.escape) return closeNotes();
    if (key.tab) return setFocus("main");
    if (key.ctrl && input === "s") return void saveNotes(notesRef.current);
    // Nas notas o enter é só quebra de linha.
    if (key.return || isNewlineKey(input, key)) return editNotes((draft) => editor.insert(draft, "\n"));
    const page = Math.max(notesArea.height - 1, 1);
    if (key.pageUp || key.pageDown) {
      return editNotes((draft) => {
        let next = draft;
        for (let step = 0; step < page; step++) next = (key.pageUp ? editor.up(next) : editor.down(next)) ?? next;
        return next;
      });
    }
    editNotes((draft) => editKey(draft, input, key) ?? draft);
  };

  // ---------- arquivos (:path) ----------
  const [picker, setPicker] = useState<Picker | null>(null);
  const pickerRef = useRef(picker);
  pickerRef.current = picker;
  const pickerAreaRef = useRef<DOMElement>(null);
  const pickerArea = useBoxMetrics(pickerAreaRef);

  /** Abre uma pasta no navegador do :path, se ele ainda for o da mesma conversa. */
  const pickerLoad = async (from: Browser, dir: string | null, select?: string) => {
    const browser = await loadBrowser(from, dir, select);
    setPicker((current) => (current ? { ...current, browser } : current));
  };

  const openPicker = () => {
    if (!scope) return;
    // Já aberto nesta conversa (você voltou para o input com tab): só volta para ele.
    if (pickerRef.current?.scope === currentKey) return setFocus("files");
    const roots =
      scope.kind === "agent"
        ? (state?.agents.find((agent) => agent.slug === scope.slug)?.folders ?? [])
        : [state?.groups.find((group) => group.slug === scope.slug)?.folder].filter((folder): folder is string => Boolean(folder));
    if (roots.length === 0) return say("esta conversa não tem pastas");
    const browser = newBrowser(roots);
    setPicker({ scope: currentKey, workspace: roots[0]!, browser });
    setFocus("files");
    void pickerLoad(browser, roots.length === 1 ? roots[0]! : null);
  };
  const closePicker = () => {
    setPicker(null);
    setFocus("main");
  };
  // O navegador é da conversa aberta: trocou de conversa, ele fecha.
  useEffect(() => {
    if (pickerRef.current && pickerRef.current.scope !== currentKey) {
      setPicker(null);
      setFocus((value) => (value === "files" ? "main" : value));
    }
  }, [currentKey]);

  /** Põe o caminho no input, onde está o cursor, e volta para a conversa. */
  const insertReference = (path: string) => {
    if (!picker) return;
    const reference = referenceFor(path, picker.workspace);
    edit((current) => {
      const before = [...current.text].slice(0, current.cursor).join("");
      return editor.insert(current, `${before && !/\s$/.test(before) ? " " : ""}${reference} `);
    });
    closePicker();
  };

  const handlePicker = (input: string, key: InkKey) => {
    if (!picker) return;
    if (key.tab) return setFocus("main");
    const action = browserKey(picker.browser, input, key, Math.max(pickerArea.height - 1, 1));
    if (action.type === "state") return setPicker({ ...picker, browser: action.browser });
    if (action.type === "load") return void pickerLoad(action.browser, action.dir, action.select);
    if (action.type === "choose" || action.type === "mark") return insertReference(action.entry.path);
    if (action.type === "close") return closePicker();
  };

  usePaste(paste, { isActive: mode === "chat" && focus === "main" && scope !== null });
  usePaste((text) => editNotes((draft) => editor.insert(draft, text.replace(/\r\n?/g, "\n"))), {
    isActive: mode === "chat" && focus === "notes" && notes !== null,
  });

  useInput((input, key) => {
    if (mode === "form") return handleForm(input, key);
    if (mode === "help") {
      if (key.escape || key.return || input === "q" || input === "?") return closeHelp();
      if (input === "j" || key.downArrow || key.pageDown) return scrollPage(key.pageDown ? Math.max(viewport.height - 2, 1) : 1);
      if (input === "k" || key.upArrow || key.pageUp) return scrollPage(key.pageUp ? -Math.max(viewport.height - 2, 1) : -1);
      return;
    }
    if (focus === "notes" && notes) return handleNotes(input, key);
    if (focus === "files" && picker) return handlePicker(input, key);
    if (focus === "sidebar") return handleSidebar(input, key);
    if (mode === "routines") return handleRoutines(input, key);
    if (mode === "processes") return handleProcesses(input, key);
    if (mode === "attention") return handleAttention(input, key);
    if (isPage) {
      if (input === "j" || key.pageDown) return scrollPage(key.pageDown ? Math.max(viewport.height - 2, 1) : 1);
      if (input === "k" || key.pageUp) return scrollPage(key.pageUp ? -Math.max(viewport.height - 2, 1) : -1);
      if (isIntegrations && input === "r") return loadIntegrations(true);
    }
    if (!scope) {
      if (key.escape || key.tab) return setFocus("sidebar");
      if (key.upArrow) return move(-1);
      if (key.downArrow) return move(1);
      if (key.return) return activate();
      if (input === "n") return openAgentForm();
      return;
    }
    return handleChat(input, key);
  });

  // ---------- input ----------
  /** O rascunho com o cursor, em linhas; só uma linha entre traços, sem caixa em volta. */
  function renderInput(): ReactNode {
    const typing = focus === "main";
    const prompt = (first: boolean) => h(Text, { color: typing ? theme.accent : theme.muted, bold: true }, first ? "> " : "  ");
    let lines: ReactNode[];
    if (!draft.text) {
      const hint = scope?.kind === "group" ? "mensagem para o grupo · @nome chama um agente" : `mensagem para ${scope?.slug} · :ajuda`;
      lines = [
        h(Text, { key: "hint", wrap: "truncate-end" }, prompt(true), typing ? h(Text, { inverse: true }, " ") : null, h(Text, { color: theme.muted }, hint)),
      ];
    } else {
      const first = followCursor(draft, Number.POSITIVE_INFINITY, INPUT_MAX_LINES);
      lines = renderLines(draft, { first, count: INPUT_MAX_LINES, focused: typing, prefix: (index) => prompt(index === 0) });
    }
    return h(
      Box,
      {
        flexDirection: "column",
        flexShrink: 0,
        borderStyle: "single",
        borderLeft: false,
        borderRight: false,
        borderColor: theme.border,
      },
      ...lines,
    );
  }

  /** O navegador de arquivos, à direita da conversa, no lugar das notas enquanto está aberto. */
  function renderPicker(open: Picker): ReactNode {
    return renderBrowser(open.browser, {
      title: "ARQUIVOS",
      width: Math.max(Math.floor(mainWidth * 0.4), 28),
      height: pickerArea.height,
      focused: focus === "files",
      areaRef: pickerAreaRef,
      footer: "enter abre · h sobe · / filtra · esc fecha",
    });
  }

  /** O painel das notas, à direita da conversa. */
  function renderNotes(open: Notes): ReactNode {
    const focused = focus === "notes";
    const height = Math.max(notesArea.height, 1);
    notesTop.current = followCursor(open.draft, notesTop.current, height);
    const status = open.failed ? "não salvo" : open.saving ? "salvando…" : open.draft.text === open.saved ? "salvo" : "editando";
    const area = open.draft.text
      ? renderLines(open.draft, { first: notesTop.current, count: height, focused })
      : [
          h(
            Text,
            { key: "empty", wrap: "wrap" },
            focused ? h(Text, { inverse: true }, " ") : null,
            h(Text, { color: theme.muted }, focused ? " escreva aqui" : "sem notas"),
          ),
        ];
    return h(
      Box,
      {
        width: Math.max(Math.floor(mainWidth * 0.4), 28),
        flexShrink: 0,
        flexDirection: "column",
        marginLeft: 1,
        paddingLeft: 1,
        borderStyle: "single",
        borderTop: false,
        borderBottom: false,
        borderRight: false,
        borderColor: focused ? theme.accent : theme.border,
      },
      h(
        Text,
        { wrap: "truncate-end" },
        h(Text, { bold: true, color: focused ? theme.accent : undefined }, "NOTAS"),
        h(Text, { color: open.failed ? theme.red : theme.muted }, ` · ${status}`),
      ),
      h(Box, { ref: notesAreaRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden", marginTop: 1 }, ...area),
      h(Text, { color: theme.muted, wrap: "truncate-start" }, open.path.replace(homedir(), "~")),
    );
  }

  // ---------- lateral ----------
  const inner = SIDEBAR_WIDTH - 3;
  const row = (key: string, active: boolean, left: ReactNode[], leftText: string, right = "", rightColor: string = theme.muted) => {
    const space = Math.max(inner - [...leftText].length - [...right].length, 1);
    const bg = active ? { backgroundColor: theme.selected } : {};
    return h(Box, { key, flexShrink: 0 }, h(
      Text,
      { wrap: "truncate-end", ...bg },
      h(Text, { ...bg }, active && focus === "sidebar" ? "▌" : " "),
      ...left,
      h(Text, { ...bg }, " ".repeat(space)),
      h(Text, { color: rightColor, ...bg }, right),
    ));
  };
  const label = (text: string, color: string = theme.muted) =>
    h(Box, { key: `l-${text}`, marginTop: 1, flexShrink: 0 }, h(Text, { color, dimColor: false }, ` ${text}`));

  const sidebar: ReactNode[] = [];
  if (!state) {
    sidebar.push(h(Text, { key: "loading", color: theme.muted }, connected ? " carregando…" : " sem o motor"));
  } else {
    sidebar.push(label("AGENTES"));
    if (state.agents.length === 0) sidebar.push(h(Text, { key: "none", color: theme.muted }, "  nenhum ainda"));
    state.agents.forEach((agent) => {
      const at = items.findIndex((candidate) => candidate.kind === "agent" && candidate.slug === agent.slug);
      const active = at === index;
      const busy = working.has(agent.slug);
      const glyph =
        busy ? h(Text, { color: theme.green }, "●") : agent.state === "paused" ? h(Text, { color: theme.amber }, "‖") : h(Text, { color: theme.muted }, "○");
      // Trabalhando: um spinner girando logo depois do nome.
      const spinner = busy ? ` ${SPINNER[frame % SPINNER.length]}` : "";
      const dot = unread.has(`agent:${agent.slug}`) ? " •" : "";
      sidebar.push(
        row(
          `a-${agent.slug}`,
          active,
          [glyph, h(Text, { bold: active }, ` ${agent.slug}`), h(Text, { color: theme.green }, spinner), h(Text, { color: theme.accent }, dot)],
          `○ ${agent.slug}${spinner}${dot}`,
          agent.state === "paused" && !busy ? "pausado" : "",
        ),
      );
    });
    for (const problem of state.problems) sidebar.push(h(Text, { key: `pr-${problem.slug}`, color: theme.red, wrap: "truncate-end" }, `  ✗ ${problem.slug}`));
    if (state.groups.length > 0) sidebar.push(label("GRUPOS"));
    state.groups.forEach((group) => {
      const at = items.findIndex((candidate) => candidate.kind === "group" && candidate.slug === group.slug);
      const active = at === index;
      const dot = unread.has(`group:${group.slug}`) ? " •" : "";
      const spinner = group.busy && !group.waiting ? ` ${SPINNER[frame % SPINNER.length]}` : "";
      sidebar.push(
        row(
          `g-${group.slug}`,
          active,
          [h(Text, { color: theme.muted }, "#"), h(Text, { bold: active }, ` ${group.slug}`), h(Text, { color: theme.green }, spinner), h(Text, { color: theme.accent }, dot)],
          `# ${group.slug}${spinner}${dot}`,
          group.waiting ? "!" : "",
          group.waiting ? theme.amber : theme.green,
        ),
      );
    });
    if (state.today.length > 0) {
      sidebar.push(label("ROTINAS HOJE"));
      for (const entry of state.today.slice(0, 8)) {
        const [glyph, color] =
          entry.status === "done" ? ["✓", theme.green] : entry.status === "failed" ? ["✗", theme.red] : entry.status === "running" ? ["●", theme.green] : entry.status === "skipped" ? ["–", theme.muted] : ["○", theme.muted];
        sidebar.push(
          keep(`t-${entry.routine}-${entry.at}`, h(Text, { wrap: "truncate-end" }, h(Text, { color }, `  ${glyph}`), ` ${entry.time} ${entry.routine}`)),
        );
      }
    }
    if (state.attention.length > 0) {
      sidebar.push(label("PRECISA DE VOCÊ", theme.amber));
      state.attention.forEach((entry) => {
        const at = items.findIndex((candidate) => candidate.kind === "attention" && candidate.id === entry.id);
        const text = truncate(entry.text, inner - 2);
        sidebar.push(row(`n-${entry.id}`, at === index, [h(Text, { color: theme.amber }, "!"), ` ${text}`], `! ${text}`));
      });
    }
    sidebar.push(h(Box, { key: "spacer", flexGrow: 1 }));
    const dashboardAt = items.findIndex((candidate) => candidate.kind === "dashboard");
    sidebar.push(row("dashboard", dashboardAt === index, [h(Text, { color: theme.accent }, "◆"), " painel"], "◆ painel", "d", theme.accent));
    const integrationsAt = items.findIndex((candidate) => candidate.kind === "integrations");
    sidebar.push(row("integrations", integrationsAt === index, [h(Text, { color: theme.accent }, "◆"), " integrações"], "◆ integrações", "i", theme.accent));
    const newAgentAt = items.findIndex((candidate) => candidate.kind === "new-agent");
    const newGroupAt = items.findIndex((candidate) => candidate.kind === "new-group");
    sidebar.push(row("new-agent", newAgentAt === index, [h(Text, { color: theme.accent }, "+"), " novo agente"], "+ novo agente", "n", theme.accent));
    sidebar.push(row("new-group", newGroupAt === index, [h(Text, { color: theme.accent }, "+"), " novo grupo"], "+ novo grupo", "g", theme.accent));
  }

  // ---------- cabeçalho ----------
  const agentState = scope?.kind === "agent" ? state?.agents.find((agent) => agent.slug === scope.slug) : undefined;
  const groupState = scope?.kind === "group" ? state?.groups.find((group) => group.slug === scope.slug) : undefined;
  // O nome da conversa em destaque: o terminal não muda o tamanho da letra, então vai num selo.
  const title = (text: string) => h(Text, { bold: true, color: theme.onAccent, backgroundColor: theme.accent }, ` ${text} `);
  let headerLeft: ReactNode = title("neoterm");
  let headerRight: ReactNode = null;
  if (mode === "help") {
    headerLeft = title("ajuda");
    headerRight = h(Text, { color: theme.muted }, "esc volta");
  } else if (mode === "form" && form) {
    headerLeft = h(Text, null, h(Text, { bold: true }, form.title), form.subtitle ? h(Text, { color: theme.muted }, ` · ${form.subtitle}`) : null);
  } else if (isIntegrations) {
    headerLeft = h(Text, null, title("integrações"), h(Text, { color: theme.muted }, " · MCP, pelo Claude Code"));
    headerRight = h(
      Text,
      { color: theme.muted },
      integrationsLoading ? "verificando…" : integrations ? `verificado ${clock(integrations.checkedAt, timeZone)} · r verifica de novo` : "",
    );
  } else if (isDashboard) {
    headerLeft = title("painel");
    headerRight = h(Text, { color: theme.muted }, dashboard ? `atualizado ${clock(dashboard.generatedAt, timeZone)} · a cada 5 s` : "carregando…");
  } else if (mode === "attention") {
    headerLeft = h(Text, { bold: true, color: theme.amber }, "precisa de você");
  } else if (agentState) {
    headerLeft = h(
      Text,
      null,
      title(mode === "routines" ? `rotinas · ${agentState.slug}` : mode === "processes" ? `processos · ${agentState.slug}` : agentState.slug),
      agentState.title ? h(Text, { color: theme.muted }, ` · ${agentState.title}`) : null,
      agentState.folders[0]
        ? h(
            Text,
            { color: theme.muted },
            ` · ${agentState.folders[0].replace(homedir(), "~")}${agentState.folders.length > 1 ? ` +${agentState.folders.length - 1}` : ""}`,
          )
        : null,
    );
    // A memória que ele está usando: o turno e os serviços que deixou rodando.
    const memory = processes && processes.totalBytes > 0 ? ` · ${bytes(processes.totalBytes)}` : "";
    const leftOver = processes?.processes.filter((entry) => entry.kind === "service" && !entry.inTurn).length ?? 0;
    const services = leftOver ? h(Text, { color: theme.amber }, ` · ◆ ${leftOver} ${leftOver === 1 ? "serviço" : "serviços"}`) : null;
    headerRight =
      agentState.state === "running"
        ? h(Text, null, h(Text, { color: theme.green }, "● "), h(Text, { color: theme.muted }, `rodando${memory}`), services)
        : agentState.state === "paused"
          ? h(Text, null, h(Text, { color: theme.amber }, "‖ pausado"), h(Text, { color: theme.muted }, memory), services)
          : h(Text, null, h(Text, { color: theme.muted }, `○ livre${memory || (agentState.model ? ` · ${agentState.model}` : "")}`), services);
  } else if (groupState) {
    headerLeft = h(
      Text,
      null,
      title(mode === "routines" ? `rotinas · #${groupState.slug}` : `# ${groupState.slug}`),
      h(Text, { color: theme.muted }, ` · ${groupState.folder.replace(homedir(), "~")}`),
    );
    headerRight = groupState.waiting
      ? h(Text, { color: theme.amber }, "esperando você")
      : h(Text, { color: theme.muted }, groupState.members.join(" · "));
  }

  // ---------- corpo ----------
  const mainWidth = Math.max(columns - SIDEBAR_WIDTH - 3, 20);
  let body: ReactNode;
  if (mode === "form" && form) {
    const formBody = h(
      Box,
      { flexDirection: "column", paddingTop: 1, flexGrow: 1, flexShrink: 1, flexBasis: 0 },
      renderForm(form, {
        viewportRef: formViewportRef,
        contentRef: formContentRef,
        overflowing: formContent.hasMeasured && formViewport.hasMeasured && formContent.height > formViewport.height,
      }),
    );
    body =
      choosingFolders && formBrowser && activeField?.kind === "folders"
        ? h(
            Box,
            { flexDirection: "row", flexGrow: 1, flexShrink: 1, flexBasis: 0 },
            formBody,
            renderBrowser(formBrowser, {
              title: "PASTAS",
              width: Math.max(Math.floor(mainWidth * 0.4), 28),
              height: formBrowserArea.height,
              focused: true,
              areaRef: formBrowserAreaRef,
              footer: "espaço escolhe · → entra · ← sobe · esc fecha",
              marked: new Set(activeField.value),
            }),
          )
        : formBody;
  } else if (mode === "help") {
    body = h(
      Box,
      { ref: viewportRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden", contentOffsetY: Math.min(pageTop, maxScroll) },
      h(Box, { ref: contentRef, flexDirection: "column", flexShrink: 0 }, renderHelp(mainWidth - 3)),
    );
  } else if (isPage) {
    const content = isIntegrations
      ? renderIntegrations(integrations, { loading: integrationsLoading, error: integrationsError })
      : dashboard
        ? renderDashboard(dashboard, { width: mainWidth - 3, timeZone })
        : h(Text, { color: dashboardError ? theme.red : theme.muted }, dashboardError ? `não carreguei o painel: ${dashboardError}` : "carregando o painel…");
    body = h(
      Box,
      { ref: viewportRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden", contentOffsetY: Math.min(pageTop, maxScroll) },
      h(Box, { ref: contentRef, flexDirection: "column", flexShrink: 0 }, content),
    );
  } else if (mode === "attention" && attentionItem) {
    const actions = attentionItem.group
      ? `enter abre #${attentionItem.group} · x dispensa`
      : attentionItem.routineId
        ? "enter abre as rotinas · x dispensa"
        : "x dispensa";
    body = h(
      Box,
      { flexDirection: "column", paddingTop: 1 },
      h(Text, { wrap: "wrap" }, h(Text, { color: theme.amber }, "! "), attentionItem.text),
      h(Box, { marginTop: 1 }, h(Text, { color: theme.muted }, actions)),
    );
  } else if (mode === "processes" && scope) {
    body = h(
      Box,
      { ref: viewportRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden" },
      renderProcesses(processes, { index: processIndex, confirming: confirmStop, error: processesError, width: mainWidth - 3, expanded: processExpanded }),
    );
  } else if (mode === "routines" && scope) {
    const lines: ReactNode[] = [];
    if (scopedRoutines.length === 0) {
      lines.push(h(Text, { key: "empty", color: theme.muted }, "nenhuma rotina. Aperte n para criar, ou peça na conversa."));
    }
    scopedRoutines.forEach((entry) => {
      const active = entry.id === routine?.id;
      const when = entry.enabled ? describeWhen(new Date(entry.nextRunAt), entry.timezone) : entry.failureStreak >= 10 ? "desligada após 10 falhas" : "desligada";
      const bg = active ? { backgroundColor: theme.selected } : {};
      lines.push(
        h(
          Text,
          { key: entry.id, wrap: "truncate-end", ...bg },
          h(Text, { color: entry.enabled ? theme.green : theme.muted, ...bg }, entry.enabled ? "● " : "○ "),
          h(Text, { bold: active, ...bg }, entry.title.padEnd(22)),
          h(Text, { color: theme.muted, ...bg }, `${describeCron(entry.cron).padEnd(18)}${(entry.mode === "notify" ? "só avisa" : "age").padEnd(10)}`),
          h(Text, { color: entry.enabled ? undefined : entry.failureStreak >= 10 ? theme.red : theme.muted, ...bg }, when),
          scope.kind === "agent" && entry.group ? h(Text, { color: theme.muted, ...bg }, `  #${entry.group}`) : null,
        ),
      );
    });
    if (routine) {
      lines.push(h(Box, { key: "sep", marginTop: 1, borderStyle: "single", borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, borderColor: theme.border }));
      lines.push(h(Text, { key: "title", bold: true, color: theme.accent }, routine.title));
      const field = (name: string, value: string) =>
        h(Text, { key: name, wrap: "wrap" }, h(Text, { color: theme.muted }, name.padEnd(12)), value);
      lines.push(field("O que faz", routine.instruction));
      lines.push(field("Quando", `${describeCron(routine.cron)} · ${routine.timezone} · ${routine.cron}`));
      lines.push(field("Ele deve", routine.mode === "notify" ? "só avisar" : "agir"));
      lines.push(field("Posta em", routine.group ? `#${routine.group}` : `conversa com ${routine.agent}`));
      if (runs.length > 0) {
        lines.push(h(Box, { key: "runs-label", marginTop: 1 }, h(Text, { color: theme.muted }, "ÚLTIMAS EXECUÇÕES")));
        for (const entry of runs) {
          const [glyph, color] = entry.status === "succeeded" ? ["✓", theme.green] : entry.status === "failed" ? ["✗", theme.red] : entry.status === "running" ? ["●", theme.green] : ["–", theme.muted];
          lines.push(
            h(
              Text,
              { key: entry.id, wrap: "truncate-end" },
              h(Text, { color }, `${glyph} `),
              describeWhen(new Date(entry.startedAt), timeZone).padEnd(16),
              h(Text, { color: theme.muted }, `${entry.durationMs ? `${Math.round(entry.durationMs / 1000)} s` : ""}${entry.error ? `  ${entry.error}` : ""}`),
            ),
          );
        }
      }
    }
    body = h(Box, { flexDirection: "column", paddingTop: 1, overflow: "hidden", flexGrow: 1, flexShrink: 1, flexBasis: 0 }, ...lines.map((line, at) => keep(`r${at}`, line)));
  } else if (scope) {
    const inGroup = scope.kind === "group";
    const shown = messages;
    const current = live[currentKey];
    // Enquanto o agente responde, o que você manda espera o próximo turno: fica embaixo, na fila,
    // e o streaming continua preso à conversa em andamento. Logo que um turno começa (ainda sem
    // nada escrito), a mensagem dele pode não ter chegado do motor: fica acima do indicador.
    const streaming = current !== undefined && current.parts.length > 0;
    const pendingTexts = pending[currentKey] ?? [];
    const waiting = streaming
      ? pendingTexts.length
        ? [renderQueue(pendingTexts)]
        : []
      : pendingTexts.map((text, position) =>
          renderPerson({ id: `pending-${position}`, author: "person", text, parts: [], meta: {}, createdAt: new Date().toISOString() }, inGroup, timeZone),
        );
    const liveBlock = current
      ? h(
          Box,
          { key: "live", flexDirection: "column", marginBottom: 1, flexShrink: 0 },
          inGroup ? h(Text, { bold: true }, current.agent) : null,
          ...renderParts(current.parts, "live"),
          h(Text, { key: "spin" }, h(Text, { color: theme.accent }, `  ${SPINNER[frame % SPINNER.length]} `), h(Text, { color: theme.muted }, "trabalhando…")),
        )
      : null;
    const empty =
      shown.length === 0 && waiting.length === 0 && !current
        ? h(Text, { key: "empty", color: theme.muted }, inGroup ? "Conversa vazia. Escreva para o grupo; @nome chama um agente." : `Conversa vazia. Escreva para ${scope.slug}.`)
        : null;
    // A conversa inteira numa caixa da altura dela; a vista mostra a janela pedida por scrollUp.
    // Enquanto cabe, fica encostada embaixo; quando passa, rola por linhas com contentOffsetY.
    const overflowing = content.hasMeasured && viewport.hasMeasured && content.height > viewport.height;
    const offset = overflowing ? maxScroll - Math.min(scrollUp, maxScroll) : 0;
    body = h(
      Box,
      {
        ref: viewportRef,
        flexDirection: "column",
        justifyContent: overflowing ? "flex-start" : "flex-end",
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        overflow: "hidden",
        contentOffsetY: offset,
      },
      h(
        Box,
        { ref: contentRef, flexDirection: "column", flexShrink: 0, paddingTop: 1 },
        ...shown.map((message) => renderMessage(message, inGroup, timeZone)),
        ...(streaming ? [liveBlock, ...waiting] : [...waiting, liveBlock]),
        empty,
      ),
    );
  } else if (state && state.agents.length === 0) {
    body = h(
      Box,
      { flexDirection: "column", paddingTop: 1 },
      h(Text, { bold: true }, "Nenhum agente ainda."),
      h(Text, { color: theme.muted }, "Aperte n para criar o primeiro: nome, função e pastas."),
    );
  } else {
    body = h(Box, { paddingTop: 1 }, h(Text, { color: theme.muted }, "Escolha um agente ou grupo na lateral."));
  }

  const input = mode === "chat" && scope ? renderInput() : null;
  const notesPanel =
    mode !== "chat"
      ? null
      : picker && picker.scope === currentKey
        ? renderPicker(picker)
        : notes && currentKey === `agent:${notes.slug}`
          ? renderNotes(notes)
          : null;

  // ---------- rodapé ----------
  let hints: string;
  const removeHint = form?.remove ? " · ctrl+d exclui" : "";
  if (mode === "form" && form?.confirmingRemove) {
    hints = "ctrl+d de novo exclui · qualquer outra tecla desiste";
  } else if (mode === "form" && choosingFolders) {
    hints = "↑↓ anda · espaço escolhe · → entra · ← sobe · esc fecha a lista · tab próximo · ctrl+s salva";
  } else if (mode === "form" && activeField?.kind === "folders") {
    hints = `→ abre a lista · tab próximo · ctrl+s salva · esc cancela${removeHint}`;
  } else if (mode === "form") hints = `tab próximo · ←→ opções · espaço marca · ctrl+s salva · esc cancela${removeHint}`;
  else if (focus === "files") {
    hints = picker?.browser.filter !== null
      ? "digite para filtrar · ↑↓ escolhe · enter abre · esc limpa o filtro"
      : "↑↓ anda · → ou enter abre/insere · ← sobe · / filtra · tab conversa · esc fecha";
  } else if (mode === "help") hints = "↑↓ ou roda do mouse rolam · esc volta";
  else if (focus === "notes") hints = "salva sozinho · tab conversa · esc fecha";
  else if (focus === "sidebar") hints = "↑↓ enter abre · e edita · n agente · g grupo · ? ajuda";
  else if (isIntegrations) hints = "r verifica de novo · j/k rolam · esc lateral";
  else if (isDashboard) hints = "j/k rolam · esc lateral";
  else if (mode === "processes") hints = confirmStop ? `${confirmStop === "all" ? "X" : "x"} de novo encerra · qualquer outra tecla desiste` : "↑↓ escolhe · x encerra · X encerra todos · enter detalhe · esc volta";
  else if (mode === "routines") hints = "↑↓ escolhe · n nova · espaço liga/desliga · x roda agora · d apaga · esc volta";
  else if (mode === "attention") hints = "esc volta para a lateral";
  else hints = `enter envia · shift+enter nova linha · ${notes ? ":notas volta às notas · " : ""}esc lateral · :ajuda`;
  const usage = state?.planUsage;
  const plan = usage
    ? ` · plano${usage.fiveHour ? ` ${Math.round(usage.fiveHour.utilization * 100)}%` : ""}${usage.sevenDay ? ` · semana ${Math.round(usage.sevenDay.utilization * 100)}%` : ""}`
    : "";
  const status = connected
    ? h(Text, { color: theme.muted }, h(Text, { color: theme.green }, "●"), " motor", plan)
    : h(Text, { color: theme.red }, "motor desligado: rode neoterm daemon ou neoterm service on");

  return h(
    Box,
    { flexDirection: "column", width: columns, height: Math.max(rows - 1, 12) },
    h(
      Box,
      { flexDirection: "row", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden" },
      h(
        Box,
        {
          width: SIDEBAR_WIDTH,
          flexShrink: 0,
          flexDirection: "column",
          borderStyle: "single",
          borderTop: false,
          borderBottom: false,
          borderLeft: false,
          borderColor: theme.border,
          overflow: "hidden",
        },
        ...sidebar,
      ),
      h(
        Box,
        { flexDirection: "column", flexGrow: 1, paddingLeft: 2, paddingRight: 1, width: mainWidth },
        h(
          Box,
          {
            justifyContent: "space-between",
            flexShrink: 0,
            marginTop: 1,
            borderStyle: "single",
            borderTop: false,
            borderLeft: false,
            borderRight: false,
            borderColor: theme.border,
          },
          h(Box, { flexShrink: 1, overflow: "hidden" }, h(Text, { wrap: "truncate-end" }, headerLeft)),
          headerRight ? h(Box, { flexShrink: 0, marginLeft: 2 }, headerRight) : null,
        ),
        h(
          Box,
          { flexDirection: "row", flexGrow: 1, flexShrink: 1, flexBasis: 0 },
          h(Box, { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0 }, body, input),
          notesPanel,
        ),
      ),
    ),
    h(
      Box,
      { justifyContent: "space-between", flexShrink: 0, paddingX: 1, borderStyle: "single", borderBottom: false, borderLeft: false, borderRight: false, borderColor: theme.border },
      h(Box, { flexShrink: 1, overflow: "hidden" }, h(Text, { color: flash ? theme.accent : theme.muted, wrap: "truncate-end" }, flash ?? hints)),
      h(Box, { flexShrink: 0, marginLeft: 2 }, status),
    ),
  );
}
