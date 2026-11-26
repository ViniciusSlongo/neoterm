import { type Stats, unwatchFile, watchFile } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Box, type DOMElement, Text, useApp, useBoxMetrics, useInput, usePaste, useWindowSize } from "ink";
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
import { countTasks, parseTask, toggleTask } from "../agents/tasks.ts";
import { clipboardImage, expandImages, pastedImages, shortenImages } from "./images.ts";
import { type Browser, browserKey, load as loadBrowser, newBrowser, renderBrowser } from "./browser.ts";
import { displayFile, recentFiles, referenceFor } from "./files.ts";
import { highlightChunks } from "./highlight.ts";
import { expandTabs, findMatches, loadViewerFile, NEW_VIEW, renderViewerLines, type ViewerFile, viewerKey, type ViewerView } from "./viewer.ts";
import { absolutePath } from "../config.ts";
import { renderMarkdown } from "./markdown.ts";
import { type Command, EFFORT_LABEL, matchCommands, parseCommand, parseEffortCommand, parseViewCommand } from "./commands.ts";
import { renderHelp } from "./help.ts";
import { CONFIG_ROWS, CUSTOM_ROW, MODEL_OPTIONS, MODEL_ROW, renderConfig } from "./config.ts";
import { ACCENTS, DEFAULT_ACCENT, isHexColor, setAccent } from "./theme.ts";
import { type ProcessView, renderProcesses } from "./processes.ts";
import { bytes, clockOrDay } from "./format.ts";
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
  | { kind: "config" }
  | { kind: "new-agent" }
  | { kind: "new-group" };

type Mode = "chat" | "routines" | "form" | "attention" | "processes" | "help" | "viewer";
type Live = { agent: string; parts: MessagePart[] };
/**
 * A lista de arquivos à direita: a da conversa de onde abriu, com a pasta onde o agente roda.
 * `insert` (o :path) põe o caminho na mensagem; `open` (o :open) abre o arquivo no visualizador.
 */
type Picker = { scope: string; workspace: string; browser: Browser; purpose: "insert" | "open" };
/** O arquivo aberto no visualizador; `returnTo`: de onde veio (a lista de arquivos ou a conversa). */
type Viewer = { path: string; display: string; file: ViewerFile | null; error?: string; returnTo: "files" | "main" };
/** As notas abertas à direita: as de um agente, com o texto em edição e o que já está no arquivo. */
type Notes = { slug: string; draft: editor.Draft; saved: string; path: string; saving: boolean; failed: boolean };
type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

const SIDEBAR_WIDTH = 30;
/** Quantas linhas o input mostra antes de rolar junto com o cursor. */
const INPUT_MAX_LINES = 8;
/** Linhas por ↑↓ (a roda do mouse chega como ↑↓). */
const SCROLL_LINES = 2;

const scopeKey = (scope: { kind: string; slug: string }) => `${scope.kind}:${scope.slug}`;

function itemsOf(state: NeotermState | null): Item[] {
  if (!state) return [];
  return [
    ...state.agents.map((agent) => ({ kind: "agent", slug: agent.slug }) as const),
    ...state.groups.map((group) => ({ kind: "group", slug: group.slug }) as const),
    ...state.attention.map((item) => ({ kind: "attention", id: item.id }) as const),
    { kind: "dashboard" },
    { kind: "integrations" },
    { kind: "config" },
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

/**
 * O ícone girando. Tem o próprio relógio: girar redesenha só ele, não a tela inteira (com um agente
 * trabalhando, um relógio na App redesenhava tudo 10 vezes por segundo e travava a digitação).
 */
function Spinner({ color, before = "", after = "" }: { color: string; before?: string; after?: string }): ReactNode {
  const [at, setAt] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setAt((value) => (value + 1) % SPINNER.length), 100);
    return () => clearInterval(timer);
  }, []);
  return h(Text, { color }, `${before}${SPINNER[at]}${after}`);
}

/** Quantas mensagens a conversa desenha; as anteriores entram ao rolar até o topo. */
const HISTORY_PAGE = 30;

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
 * `readClipboardImage`: lê a imagem do clipboard numa colagem vazia (trocável nos testes).
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
  const [settingsVersion, setSettingsVersion] = useState(0);
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
  // Onde a vista está: null acompanha o fim (as mensagens novas); um número é a linha do topo,
  // contada de cima, quando você rolou para ler. Contar de cima faz o que chega embaixo (uma
  // resposta, a troca da mensagem pendente pela gravada) não mexer no que você está lendo.
  const [scrollTop, setScrollTop] = useState<number | null>(null);
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const maxScroll = Math.max(content.height - viewport.height, 0);
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
          // Ele leu uma mensagem nova: o que já fez foi para a conversa; o ao vivo recomeça.
          else if (turn.type === "flush") next[key] = { agent: event.agent, parts: [] };
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
        // Outra janela do neoterm mudou a cor ou o modelo: lê de novo.
        if (event.what === "settings") setSettingsVersion((value) => value + 1);
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
    setScrollTop(null);
    setHistoryCount(HISTORY_PAGE);
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

  /** Rola `lines` para cima (negativo desce); chegando ao fim, volta a acompanhar as novas. */
  // A conversa desenha só as últimas mensagens; chegando ao topo, entram mais (e a vista fica onde
  // estava, descontando o que entrou acima).
  const [historyCount, setHistoryCount] = useState(HISTORY_PAGE);
  const growFrom = useRef<number | null>(null);
  useEffect(() => {
    if (growFrom.current === null || content.height === growFrom.current) return;
    const added = content.height - growFrom.current;
    growFrom.current = null;
    // Quem já voltou ao fim (null) continua no fim; quem está lendo fica na mesma mensagem.
    setScrollTop((value) => (value === null ? null : value + added));
  }, [content.height]);
  const scrollBy = (lines: number) =>
    setScrollTop((value) => {
      const top = Math.min(Math.max((value ?? maxScroll) - lines, 0), maxScroll);
      if (top === 0 && lines > 0 && messages.length > historyCount && growFrom.current === null) {
        growFrom.current = content.height;
        setHistoryCount((count) => count + HISTORY_PAGE);
      }
      return top >= maxScroll ? null : top;
    });

  // ---------- páginas: painel e integrações ----------
  const isDashboard = item?.kind === "dashboard";
  const isIntegrations = item?.kind === "integrations";
  const isConfig = item?.kind === "config";
  const isPage = isDashboard || isIntegrations || isConfig;
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

  // ---------- configuração: cor e modelo padrão ----------
  const [savedAccent, setSavedAccent] = useState(DEFAULT_ACCENT);
  // As notas fixadas ficam abertas ao lado da conversa e acompanham o agente aberto.
  const [notesPinned, setNotesPinned] = useState(false);
  const [defaultModel, setDefaultModel] = useState("claude-opus-5-5");
  const [configIndex, setConfigIndex] = useState(0);
  const [customHex, setCustomHex] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  // A cor desenhada: na tela de config, a que está sob o cursor (prévia); fora dela, a salva.
  const hovered =
    isConfig && configIndex < ACCENTS.length
      ? ACCENTS[configIndex]!.hex
      : isConfig && configIndex === CUSTOM_ROW && customHex && isHexColor(customHex)
        ? customHex
        : savedAccent;
  setAccent(hovered);
  const loadSettings = useCallback(() => {
    api.settings().then(
      (settings) => {
        setSavedAccent(settings.accent ?? DEFAULT_ACCENT);
        setDefaultModel(settings.defaultModel);
        setNotesPinned(Boolean(settings.notesPinned));
      },
      () => {},
    );
  }, [api]);
  useEffect(() => loadSettings(), [loadSettings, settingsVersion]);
  useEffect(() => {
    if (!isConfig) return;
    setCustomHex(null);
    setConfigError(null);
    const at = ACCENTS.findIndex((accent) => accent.hex.toUpperCase() === savedAccent.toUpperCase());
    setConfigIndex(at >= 0 ? at : CUSTOM_ROW);
  }, [isConfig]);
  const saveConfig = (patch: { accent?: string; defaultModel?: string }) =>
    api.saveSettings(patch).then(
      (settings) => {
        setSavedAccent(settings.accent ?? DEFAULT_ACCENT);
        setDefaultModel(settings.defaultModel);
        setConfigError(null);
        say(patch.accent ? `cor salva: ${patch.accent}` : `modelo padrão: ${settings.defaultModel.replace(/^claude-|-\d.*$/g, "")}`);
      },
      (error: Error) => setConfigError(error.message),
    );

  const handleConfig = (input: string, key: InkKey) => {
    if (customHex !== null) {
      if (key.escape) return setCustomHex(null);
      if (key.return) {
        const hex = customHex.startsWith("#") ? customHex : `#${customHex}`;
        if (!isHexColor(hex)) return setConfigError("use uma cor no formato #RRGGBB, como #F5A76C");
        setCustomHex(null);
        return void saveConfig({ accent: hex.toUpperCase() });
      }
      if (key.backspace || key.delete) return setCustomHex((value) => (value ? value.slice(0, -1) : value));
      if (/^[#0-9a-fA-F]+$/.test(input)) return setCustomHex((value) => `${value ?? ""}${input}`.slice(0, 7));
      return;
    }
    if (key.escape || key.tab) return setFocus("sidebar");
    if (key.upArrow || input === "k") return setConfigIndex((value) => Math.max(value - 1, 0));
    if (key.downArrow || input === "j") return setConfigIndex((value) => Math.min(value + 1, CONFIG_ROWS - 1));
    if (configIndex === MODEL_ROW && (key.leftArrow || key.rightArrow)) {
      const at = Math.max(MODEL_OPTIONS.findIndex((option) => option.value === defaultModel), 0);
      const next = MODEL_OPTIONS[(at + (key.rightArrow ? 1 : -1) + MODEL_OPTIONS.length) % MODEL_OPTIONS.length]!;
      return void saveConfig({ defaultModel: next.value });
    }
    if (key.return || input === " ") {
      if (configIndex < ACCENTS.length) return void saveConfig({ accent: ACCENTS[configIndex]!.hex });
      if (configIndex === CUSTOM_ROW) return setCustomHex("#");
    }
  };


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

  /** Cmd+v com uma imagem no clipboard chega como colagem vazia: a interface vai buscar a imagem. */
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

  /** Envia o rascunho, ou `override` (o comando escolhido no menu do ":"). */
  const send = (override?: string) => {
    // :path no fim de uma mensagem começada abre o navegador sem enviar: o arquivo entra ali.
    const typed = (override ?? draft.text).trimEnd();
    if (scope && /(^|\s):path$/.test(typed)) {
      const kept = typed.slice(0, -":path".length);
      setDraft({ text: kept, cursor: [...kept].length });
      return openPicker();
    }
    const text = override ?? expandImages(draft.text, images.current).trim();
    if (!text || !scope) return;
    clearDraft();
    // :open abre a lista de arquivos; :open caminho abre o arquivo direto.
    const viewCommand = parseViewCommand(text);
    if (viewCommand) {
      if (!viewCommand.path) return openPicker("open");
      const workspace = scopeRoots()[0];
      if (!workspace) return say("esta conversa não tem pastas");
      return openViewer(absolutePath(viewCommand.path, workspace), workspace, "main");
    }
    // :effort [nível]: sem nível, diz o atual; com nível, muda o do agente.
    const effortCommand = parseEffortCommand(text);
    if (effortCommand) {
      if (scope.kind !== "agent") return say("o esforço é de cada agente: abra a conversa com um");
      const current = agentState?.effort;
      if (effortCommand.level === null) {
        return say(`esforço de ${scope.slug}: ${current ? EFFORT_LABEL[current] : "padrão"} · mude com :effort low | medium | high | xhigh | max | default`);
      }
      if (effortCommand.level === "?") return say("esforço: low, medium, high, xhigh, max ou default");
      const level = effortCommand.level;
      return run(
        api.updateAgent(scope.slug, { effort: level || null }),
        `esforço de ${scope.slug}: ${level ? EFFORT_LABEL[level] : "padrão"} · vale a partir da próxima resposta`,
      );
    }
    // Comandos: com : ou / na frente (:notes, /notes).
    switch (parseCommand(text)) {
      case "help":
        return openHelp();
      case "routines":
        return openRoutines();
      case "processes":
        return openProcesses();
      case "dashboard":
        return openDashboard();
      case "mcp":
        return openIntegrations();
      case "config":
        return openConfig();
      case "edit":
        return openEditForm(scope);
      case "path":
        return openPicker();
      case "open":
        return openPicker("open");
      case "notes":
        if (scope.kind !== "agent") return say("as notas são de cada agente: abra a conversa com um");
        return openNotes(scope.slug);
      case "pause":
      case "resume": {
        if (scope.kind !== "agent") return say("só agentes pausam");
        const pause = parseCommand(text) === "pause";
        return run(api.setPaused(scope.slug, pause), pause ? `${scope.slug} pausado` : `${scope.slug} retomado`);
      }
      case null:
        break;
    }
    const key = scopeKey(scope);
    setPending((current) => ({ ...current, [key]: [...(current[key] ?? []), text] }));
    setScrollTop(null);
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

  const openPage = (kind: "dashboard" | "integrations" | "config") => {
    const at = items.findIndex((candidate) => candidate.kind === kind);
    if (at < 0) return;
    setSelected(at);
    setMode("chat");
    setFocus("main");
  };
  const openDashboard = () => openPage("dashboard");
  const openConfig = () => openPage("config");
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
    if (input === "c") return openConfig();
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

  // ---------- menu dos comandos (":") ----------
  // Digitar ":" no começo abre a lista dos comandos, afunilando conforme se escreve. Esc fecha e
  // deixa o ":" como texto; o menu volta quando o rascunho deixa de começar com ":".
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuClosed, setCommandMenuClosed] = useState(false);
  const commandQuery = /^:(\S*)$/.exec(draft.text)?.[1];
  const commandMatches = useMemo(
    () => (commandQuery === undefined ? [] : matchCommands(commandQuery, { agent: scope?.kind === "agent" })),
    [commandQuery, scope?.kind],
  );
  const commandMenuOpen = mode === "chat" && focus === "main" && !commandMenuClosed && commandMatches.length > 0;
  useEffect(() => setCommandIndex(0), [commandQuery]);
  useEffect(() => {
    if (!draft.text.startsWith(":")) setCommandMenuClosed(false);
  }, [draft.text]);
  const chooseCommand = (command: Command | undefined) => {
    if (!command) return;
    // Com complemento (o nível do esforço): completa o nome e espera o resto. Com o nome já inteiro
    // (":effort"), roda sem o complemento, que mostra o valor atual.
    if (command.argument && draft.text !== `:${command.name}`) {
      return setDraft({ text: `:${command.name} `, cursor: [...`:${command.name} `].length });
    }
    send(`:${command.name}`);
  };
  const handleCommandMenu = (input: string, key: InkKey): boolean => {
    if (!commandMenuOpen) return false;
    const chosen = commandMatches[Math.min(commandIndex, commandMatches.length - 1)];
    if (key.escape) return setCommandMenuClosed(true), true;
    if (key.upArrow) return setCommandIndex((value) => Math.max(value - 1, 0)), true;
    if (key.downArrow) return setCommandIndex((value) => Math.min(value + 1, commandMatches.length - 1)), true;
    if (key.tab && chosen) {
      const text = `:${chosen.name}${chosen.argument ? " " : ""}`;
      return setDraft({ text, cursor: [...text].length }), true;
    }
    if (key.return && !isNewlineKey(input, key)) return chooseCommand(chosen), true;
    return false;
  };

  /** O menu dos comandos, logo acima da caixa de texto: nome e, ao lado, o que faz. */
  function renderCommandMenu(): ReactNode {
    const visible = 8;
    const index = Math.min(commandIndex, commandMatches.length - 1);
    const first = Math.min(Math.max(index - visible + 1, 0), Math.max(commandMatches.length - visible, 0));
    const nameWidth = Math.max(...commandMatches.map((command) => command.name.length)) + 3;
    return h(
      Box,
      { flexDirection: "column", flexShrink: 0, borderStyle: "round", borderColor: theme.border, paddingX: 1 },
      ...commandMatches.slice(first, first + visible).map((command, at) => {
        const active = first + at === index;
        const bg = active ? { backgroundColor: theme.selected } : {};
        return h(
          Text,
          { key: command.name, wrap: "truncate-end", ...bg },
          h(Text, { color: active ? theme.accent : undefined, bold: active, ...bg }, `:${command.name}`.padEnd(nameWidth)),
          h(Text, { color: theme.muted, ...bg }, command.description),
        );
      }),
      h(
        Text,
        { color: theme.muted, wrap: "truncate-end" },
        `${commandMatches.length > visible ? `${index + 1}/${commandMatches.length} · ` : ""}↑↓ escolhe · enter roda · tab completa · esc fecha`,
      ),
    );
  }

  const handleChat = (input: string, key: InkKey) => {
    if (handleCommandMenu(input, key)) return;
    if (key.escape || key.tab) return setFocus("sidebar");
    if (isNewlineKey(input, key)) return edit((current) => editor.insert(current, "\n"));
    if (key.return) return send();
    // ↑↓ sem texto trocam de conversa; com texto, andam pelas linhas.
    // ↑↓ rolam a conversa (a roda do mouse chega como ↑↓); num texto de várias linhas, andam nele.
    if ((key.upArrow || key.downArrow) && !draft.text.includes("\n")) return scrollBy(key.upArrow ? SCROLL_LINES : -SCROLL_LINES);
    if (key.pageUp) return scrollBy(Math.max(viewport.height - 2, 1));
    if (key.pageDown) return scrollBy(-Math.max(viewport.height - 2, 1));
    if (key.ctrl && input === "r") return openRoutines();
    if (key.ctrl && input === "n") return toggleNotes();
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

  /** Abre as notas de um agente; `focus` false só mostra ao lado (as fixadas, ao trocar de conversa). */
  const openNotes = (slug: string, options: { focus?: boolean } = {}) => {
    const focusIt = options.focus ?? true;
    if (notesRef.current?.slug === slug) return focusIt ? setFocus("notes") : undefined;
    void saveNotes(notesRef.current);
    api.notes(slug).then(
      ({ text, path }) => {
        if (currentRef.current !== `agent:${slug}`) return;
        notesTop.current = 0;
        setNotes({ slug, draft: { text, cursor: [...text].length }, saved: text, path, saving: false, failed: false });
        if (focusIt) setFocus("notes");
      },
      (error: Error) => say(`não abri as notas: ${error.message}`),
    );
  };
  /** Fecha o painel; fixado, o esc só devolve o cursor à conversa. */
  const closeNotes = (force = false) => {
    void saveNotes(notesRef.current);
    if (notesPinned && !force) return setFocus("main");
    setNotes(null);
    setFocus("main");
  };
  /** ctrl+n: abre as notas; abertas, alterna entre elas e a conversa. */
  const toggleNotes = () => {
    if (!scope || scope.kind !== "agent") return say("as notas são de cada agente: abra a conversa com um");
    if (!notesRef.current || notesRef.current.slug !== scope.slug) return openNotes(scope.slug);
    setFocus((value) => (value === "notes" ? "main" : "notes"));
  };
  const togglePin = () => {
    const next = !notesPinned;
    setNotesPinned(next);
    void api.saveSettings({ notesPinned: next }).catch(() => {});
    say(next ? "notas fixadas: ficam abertas ao lado de cada agente" : "notas soltas: esc fecha");
  };
  // Trocou de conversa: fixadas, mostram as do agente novo; soltas, fecham (salvas).
  useEffect(() => {
    const open = notesRef.current;
    const agentSlug = currentKey.startsWith("agent:") ? currentKey.slice("agent:".length) : null;
    if (open && currentKey !== `agent:${open.slug}`) {
      void saveNotes(open);
      setNotes(null);
      setFocus((value) => (value === "notes" ? "main" : value));
    }
    if (notesPinned && agentSlug && open?.slug !== agentSlug) openNotes(agentSlug, { focus: false });
  }, [currentKey, saveNotes, notesPinned]);

  const editNotes = (change: (draft: editor.Draft) => editor.Draft) =>
    setNotes((entry) => (entry ? { ...entry, draft: change(entry.draft) } : entry));

  const handleNotes = (input: string, key: InkKey) => {
    if (key.escape) return closeNotes();
    if (key.tab || (key.ctrl && input === "n")) return setFocus("main");
    if (key.ctrl && input === "p") return togglePin();
    // ctrl+t marca ou desmarca a tarefa da linha (e transforma uma linha em tarefa).
    if (key.ctrl && input === "t") {
      return editNotes((draft) => {
        const chars = [...draft.text];
        const before = chars.slice(0, draft.cursor).join("");
        const start = before.lastIndexOf("\n") + 1;
        const endAt = draft.text.indexOf("\n", before.length);
        const end = endAt === -1 ? draft.text.length : endAt;
        const line = draft.text.slice(start, end);
        const next = toggleTask(line);
        const text = draft.text.slice(0, start) + next + draft.text.slice(end);
        const column = [...before.slice(start)].length;
        const shift = [...next].length - [...line].length;
        return { text, cursor: [...draft.text.slice(0, start)].length + Math.max(column + shift, 0) };
      });
    }
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

  /** As pastas da conversa aberta: as do agente, ou a do grupo. A primeira é onde ele roda. */
  const scopeRoots = (): string[] =>
    !scope
      ? []
      : scope.kind === "agent"
        ? (state?.agents.find((agent) => agent.slug === scope.slug)?.folders ?? [])
        : [state?.groups.find((group) => group.slug === scope.slug)?.folder].filter((folder): folder is string => Boolean(folder));

  const openPicker = (purpose: "insert" | "open" = "insert") => {
    if (!scope) return;
    // Já aberta nesta conversa, para o mesmo fim (você voltou para o input com tab): só volta para ela.
    if (pickerRef.current?.scope === currentKey && pickerRef.current.purpose === purpose) return setFocus("files");
    const roots = scopeRoots();
    if (roots.length === 0) return say("esta conversa não tem pastas");
    // No :open, os arquivos que o agente leu ou mexeu nesta conversa ficam à mão, no topo.
    const pinned = purpose === "open" ? recentFiles(fileToolDetails(), roots[0]!) : [];
    const browser = newBrowser(roots, { pinned });
    setPicker({ scope: currentKey, workspace: roots[0]!, browser, purpose });
    setFocus("files");
    void pickerLoad(browser, roots.length === 1 && pinned.length === 0 ? roots[0]! : null);
  };

  /** O caminho nas ferramentas de arquivo do agente nesta conversa, do mais recente ao mais antigo. */
  const fileToolDetails = (): string[] => {
    const tools = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
    const parts = [...messages.flatMap((message) => message.parts), ...(live[currentKey]?.parts ?? [])];
    return parts
      .filter((part): part is Extract<MessagePart, { type: "tool" }> => part.type === "tool" && tools.has(part.name))
      .map((part) => part.detail)
      .reverse();
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
    if (action.type === "choose" || action.type === "mark") {
      if (picker.purpose === "insert") return insertReference(action.entry.path);
      if (action.entry.dir) return void pickerLoad(picker.browser, action.entry.path);
      return openViewer(action.entry.path, picker.workspace, "files");
    }
    if (action.type === "close") return closePicker();
  };

  // ---------- visualizador de arquivos (:open) ----------
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [viewerView, setViewerView] = useState<ViewerView>(NEW_VIEW);
  // As cores chegam em partes e preenchem o arquivo aberto; isto só pede o redesenho.
  const [, setViewerColors] = useState(0);
  const viewerAreaRef = useRef<DOMElement>(null);
  const viewerArea = useBoxMetrics(viewerAreaRef);
  // Cada abertura (ou recarga) é uma geração: a anterior para de colorir.
  const viewerGeneration = useRef(0);

  const loadViewer = useCallback((path: string, options: { reload?: boolean } = {}) => {
    const generation = ++viewerGeneration.current;
    loadViewerFile(path).then(
      async (file) => {
        if (generation !== viewerGeneration.current) return;
        setViewer((current) => (current && current.path === path ? { ...current, file, error: undefined } : current));
        if (options.reload) say("arquivo atualizado");
        if (!file.language || file.note) return;
        try {
          for await (const chunk of highlightChunks(file.raw, file.language.id)) {
            if (generation !== viewerGeneration.current) return;
            chunk.lines.forEach((segments, at) => {
              file.styled[chunk.from + at] = expandTabs(segments);
            });
            setViewerColors((value) => value + 1);
          }
        } catch {
          // Sem cores, mas aberto.
        }
      },
      (error: Error) => {
        if (generation === viewerGeneration.current) setViewer((current) => (current && current.path === path ? { ...current, error: error.message } : current));
      },
    );
  }, [say]);

  const openViewer = (path: string, workspace: string, returnTo: "files" | "main") => {
    setViewer({ path, display: displayFile(path, workspace), file: null, returnTo });
    setViewerView(NEW_VIEW);
    setMode("viewer");
    loadViewer(path);
  };
  const closeViewer = () => {
    viewerGeneration.current++;
    const back = viewer?.returnTo === "files" && pickerRef.current ? "files" : "main";
    setViewer(null);
    setMode("chat");
    setFocus(back);
  };
  // O agente mudou o arquivo aberto: abre de novo, no mesmo lugar.
  useEffect(() => {
    if (mode !== "viewer" || !viewer) return;
    const path = viewer.path;
    const changed = (current: Stats, previous: Stats) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) loadViewer(path, { reload: true });
    };
    watchFile(path, { interval: 1000, persistent: false }, changed);
    return () => unwatchFile(path, changed);
  }, [mode, viewer?.path, loadViewer]);

  const viewerMatches = useMemo(
    () => (viewer?.file && viewerView.term ? findMatches(viewer.file.lines, viewerView.term) : []),
    [viewer?.file, viewerView.term],
  );
  const handleViewer = (input: string, key: InkKey) => {
    if (!viewer?.file) {
      if (key.escape || input === "q") closeViewer();
      return;
    }
    const action = viewerKey(viewerView, viewer.file, viewerMatches, input, key, Math.max(viewerArea.height, 1));
    if (action.type === "close") return closeViewer();
    if (action.type === "view") {
      setViewerView(action.view);
      if (action.notFound) say(`nada com "${action.view.term}"`);
    }
  };

  /** O visualizador em tela cheia: o cabeçalho do arquivo e as linhas à vista. */
  function renderViewerScreen(): ReactNode {
    if (!viewer) return null;
    const file = viewer.file;
    const height = viewerArea.height;
    const total = file?.lines.length ?? 0;
    const top = Math.min(viewerView.top, Math.max(total - Math.max(height, 1), 0));
    const count = (value: number) => value.toLocaleString("pt-BR");
    const about = file
      ? ` · ${viewer.display} · ${file.language?.name ?? "texto"} · ${count(total)} ${total === 1 ? "linha" : "linhas"}${file.note ? ` · ${file.note}` : ""}`
      : ` · ${viewer.display}`;
    const right =
      viewerView.input !== null
        ? h(Text, null, h(Text, { color: theme.accent }, `/${viewerView.input}`), h(Text, { inverse: true }, " "))
        : h(
            Text,
            { color: theme.muted },
            viewerView.term ? (viewerMatches.length ? `"${viewerView.term}" ${viewerView.current + 1}/${viewerMatches.length} · ` : `"${viewerView.term}" nada · `) : "",
            file && height > 0 ? `${count(top + 1)}–${count(Math.min(top + height, total))} de ${count(total)}` : "",
          );
    const content = viewer.error
      ? [h(Text, { key: "error", color: theme.red, wrap: "wrap" }, `não abri ${viewer.display}: ${viewer.error}`)]
      : !file
        ? [h(Text, { key: "loading", color: theme.muted }, "abrindo…")]
        : renderViewerLines(file, { top, left: viewerView.left, width: viewerArea.width, height, matches: viewerMatches, current: viewerView.current });
    return h(
      Box,
      { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingX: 1 },
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
        h(
          Box,
          { flexShrink: 1, overflow: "hidden" },
          h(
            Text,
            { wrap: "truncate-end" },
            h(Text, { bold: true, color: theme.onAccent, backgroundColor: theme.accent }, ` ${file?.name ?? basename(viewer.path)} `),
            h(Text, { color: theme.muted }, about),
          ),
        ),
        h(Box, { flexShrink: 0, marginLeft: 2 }, right),
      ),
      h(Box, { ref: viewerAreaRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden" }, ...content),
    );
  }

  usePaste(paste, { isActive: mode === "chat" && focus === "main" && scope !== null });
  usePaste((text) => editNotes((draft) => editor.insert(draft, text.replace(/\r\n?/g, "\n"))), {
    isActive: mode === "chat" && focus === "notes" && notes !== null,
  });

  useInput((input, key) => {
    if (mode === "viewer") return handleViewer(input, key);
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
    if (isConfig) return handleConfig(input, key);
    if (isPage) {
      if (key.upArrow || key.downArrow) return scrollPage(key.downArrow ? SCROLL_LINES : -SCROLL_LINES);
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
      const hint = scope?.kind === "group" ? "mensagem para o grupo · @nome chama um agente" : `mensagem para ${scope?.slug} · :help`;
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
      title: open.purpose === "open" ? "ABRIR" : "ARQUIVOS",
      width: Math.max(Math.floor(mainWidth * 0.4), 28),
      height: pickerArea.height,
      focused: focus === "files",
      areaRef: pickerAreaRef,
      footer: open.purpose === "open" ? "enter abre · ← sobe · / filtra · esc fecha" : "enter abre · h sobe · / filtra · esc fecha",
    });
  }

  /** O painel das notas, à direita da conversa. */
  function renderNotes(open: Notes): ReactNode {
    const focused = focus === "notes";
    const height = Math.max(notesArea.height, 1);
    notesTop.current = followCursor(open.draft, notesTop.current, height);
    const status = open.failed ? "não salvo" : open.saving ? "salvando…" : open.draft.text === open.saved ? "salvo" : "editando";
    const tasks = countTasks(open.draft.text);
    // A linha do cursor aparece como está escrita (para editar); as outras, com as tarefas desenhadas.
    const cursorLine = editor.position(open.draft).line;
    const raw = renderLines(open.draft, { first: notesTop.current, count: height, focused });
    const area = open.draft.text
      ? open.draft.text
          .split("\n")
          .slice(notesTop.current, notesTop.current + height)
          .map((line, at) => {
            const index = notesTop.current + at;
            const task = parseTask(line);
            if ((focused && index === cursorLine) || !task) return raw[at];
            return h(
              Text,
              { key: index, wrap: "wrap" },
              task.indent,
              h(Text, { color: task.done ? theme.green : theme.accent }, task.done ? "☑ " : "☐ "),
              h(Text, { color: task.done ? theme.muted : undefined, strikethrough: task.done }, task.text || " "),
            );
          })
      : [
          h(
            Text,
            { key: "empty", wrap: "wrap" },
            focused ? h(Text, { inverse: true }, " ") : null,
            h(Text, { color: theme.muted }, focused ? " escreva aqui · ctrl+t cria uma tarefa" : "sem notas"),
          ),
        ];
    return h(
      Box,
      {
        // Estreita: dá para deixar fixada sem apertar a conversa.
        width: Math.min(Math.max(Math.floor(mainWidth * 0.28), 30), 44),
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
        notesPinned ? h(Text, { color: theme.accent }, " · fixadas") : null,
        tasks.open + tasks.done ? h(Text, { color: theme.muted }, ` · ${tasks.done}/${tasks.open + tasks.done} feitas`) : null,
        h(Text, { color: open.failed ? theme.red : theme.muted }, ` · ${status}`),
      ),
      h(Box, { ref: notesAreaRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden", marginTop: 1 }, ...area),
      h(
        Text,
        { color: theme.muted, wrap: "truncate-end" },
        focused ? `ctrl+t tarefa · ctrl+p ${notesPinned ? "solta" : "fixa"} · ctrl+n conversa` : "ctrl+n edita",
      ),
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
      const spinner = busy ? " ⠋" : "";
      const dot = unread.has(`agent:${agent.slug}`) ? " •" : "";
      // Lembrete de que há notas sobre ele.
      const noteMark = agent.notes?.has ? " ✎" : "";
      sidebar.push(
        row(
          `a-${agent.slug}`,
          active,
          [
            glyph,
            h(Text, { bold: active }, ` ${agent.slug}`),
            busy ? h(Spinner, { key: "spin", color: theme.green, before: " " }) : null,
            h(Text, { color: theme.accent }, dot),
            h(Text, { color: theme.muted }, noteMark),
          ],
          `○ ${agent.slug}${spinner}${dot}${noteMark}`,
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
      const spinner = group.busy && !group.waiting ? " ⠋" : "";
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
    const configAt = items.findIndex((candidate) => candidate.kind === "config");
    sidebar.push(row("config", configAt === index, [h(Text, { color: theme.accent }, "◆"), " config"], "◆ config", "c", theme.accent));
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
  } else if (isConfig) {
    headerLeft = h(Text, null, title("config"), h(Text, { color: theme.muted }, " · salvo em ~/.neoterm/config.json"));
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
    // Quanto do contexto a sessão ocupa (da última resposta); âmbar perto de compactar.
    const lastContext = messages.findLast((message) => message.author === "agent" && message.meta.context)?.meta.context;
    const contextRatio = lastContext ? lastContext.used / lastContext.window : 0;
    // Só a partir da metade da janela, que é quando importa; perto do limite ele compacta sozinho.
    const contextMark =
      lastContext && contextRatio >= 0.5
        ? h(Text, { color: contextRatio >= 0.8 ? theme.amber : theme.muted }, ` · contexto ${Math.round(contextRatio * 100)}%`)
        : null;
    const services = leftOver ? h(Text, { color: theme.amber }, ` · ◆ ${leftOver} ${leftOver === 1 ? "serviço" : "serviços"}`) : null;
    headerRight =
      agentState.state === "running"
        ? h(Text, null, h(Text, { color: theme.green }, "● "), h(Text, { color: theme.muted }, `rodando${memory}`), contextMark, services)
        : agentState.state === "paused"
          ? h(Text, null, h(Text, { color: theme.amber }, "‖ pausado"), h(Text, { color: theme.muted }, memory), contextMark, services)
          : h(
              Text,
              null,
              h(
                Text,
                { color: theme.muted },
                `○ livre${memory || `${agentState.model ? ` · ${agentState.model}` : ""}${agentState.effort ? ` · esforço ${EFFORT_LABEL[agentState.effort]}` : ""}`}`,
              ),
              contextMark,
              services,
            );
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

  // O histórico desenhado só muda quando as mensagens mudam: digitar não redesenha a conversa.
  const historyInGroup = scope?.kind === "group";
  const hiddenHistory = Math.max(messages.length - historyCount, 0);
  const historyElements = useMemo(
    () => messages.slice(hiddenHistory).map((message) => renderMessage(message, historyInGroup, timeZone)),
    [messages, hiddenHistory, historyInGroup, timeZone, theme.accent],
  );

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
    const content = isConfig
      ? renderConfig({ index: configIndex, saved: savedAccent, typing: customHex, model: defaultModel, focused: focus === "main", error: configError })
      : isIntegrations
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
          h(Text, { key: "spin" }, h(Spinner, { color: theme.accent, before: "  ", after: " " }), h(Text, { color: theme.muted }, "trabalhando…")),
        )
      : null;
    const empty =
      shown.length === 0 && waiting.length === 0 && !current
        ? h(Text, { key: "empty", color: theme.muted }, inGroup ? "Conversa vazia. Escreva para o grupo; @nome chama um agente." : `Conversa vazia. Escreva para ${scope.slug}.`)
        : null;
    // A conversa inteira numa caixa da altura dela; a vista mostra a janela pedida por scrollTop.
    // Enquanto cabe, fica encostada embaixo; quando passa, rola por linhas com contentOffsetY.
    const overflowing = content.hasMeasured && viewport.hasMeasured && content.height > viewport.height;
    const offset = overflowing ? Math.min(scrollTop ?? maxScroll, maxScroll) : 0;
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
        hiddenHistory ? h(Text, { key: "older", color: theme.muted }, `↑ ${hiddenHistory} ${hiddenHistory === 1 ? "mensagem anterior" : "mensagens anteriores"} · role para ver`) : null,
        ...historyElements,
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

  const input =
    mode === "chat" && scope
      ? commandMenuOpen
        ? h(Box, { flexDirection: "column", flexShrink: 0 }, renderCommandMenu(), renderInput())
        : renderInput()
      : null;
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
  if (mode === "viewer") {
    hints = viewerView.input !== null ? "digite a busca · enter procura · esc desiste" : "↑↓ ←→ rolam · / busca · n próxima · esc fecha";
  } else if (mode === "form" && form?.confirmingRemove) {
    hints = "ctrl+d de novo exclui · qualquer outra tecla desiste";
  } else if (mode === "form" && choosingFolders) {
    hints = "↑↓ anda · espaço escolhe · → entra · ← sobe · esc fecha a lista · tab próximo · ctrl+s salva";
  } else if (mode === "form" && activeField?.kind === "folders") {
    hints = `→ abre a lista · tab próximo · ctrl+s salva · esc cancela${removeHint}`;
  } else if (mode === "form") hints = `tab próximo · ←→ opções · espaço marca · ctrl+s salva · esc cancela${removeHint}`;
  else if (focus === "files") {
    hints = picker?.browser.filter !== null
      ? "digite para filtrar · ↑↓ escolhe · enter abre · esc limpa o filtro"
      : picker?.purpose === "open"
        ? "↑↓ anda · enter abre o arquivo · ← sobe · / filtra · esc fecha"
        : "↑↓ anda · → ou enter abre/insere · ← sobe · / filtra · tab conversa · esc fecha";
  } else if (mode === "help") hints = "↑↓ ou roda do mouse rolam · esc volta";
  else if (focus === "notes") hints = `ctrl+t tarefa · ctrl+p ${notesPinned ? "solta" : "fixa ao lado"} · ctrl+n conversa · esc ${notesPinned ? "volta" : "fecha"}`;
  else if (focus === "sidebar") hints = "↑↓ enter abre · e edita · n agente · g grupo · ? ajuda";
  else if (isConfig) hints = customHex !== null ? "digite #RRGGBB · enter aplica · esc desiste" : "↑↓ prévia da cor · enter salva · ←→ modelo · esc lateral";
  else if (isIntegrations) hints = "r verifica de novo · j/k rolam · esc lateral";
  else if (isDashboard) hints = "j/k rolam · esc lateral";
  else if (mode === "processes") hints = confirmStop ? `${confirmStop === "all" ? "X" : "x"} de novo encerra · qualquer outra tecla desiste` : "↑↓ escolhe · x encerra · X encerra todos · enter detalhe · esc volta";
  else if (mode === "routines") hints = "↑↓ escolhe · n nova · espaço liga/desliga · x roda agora · d apaga · esc volta";
  else if (mode === "attention") hints = "esc volta para a lateral";
  else hints = `enter envia · ctrl+n notas · esc lateral · :help`;
  // O uso do plano, da última resposta do Claude Code. A partir da metade, quando a janela renova;
  // depois que renovou, o número antigo não vale mais (o novo chega com a próxima resposta).
  const usage = state?.planUsage;
  const planNow = new Date();
  const planWindow = (name: string, renewed: string, entry: { utilization: number; resetsAt: string | Date } | undefined): ReactNode[] => {
    if (!entry) return [];
    const resetsAt = new Date(entry.resetsAt);
    if (resetsAt <= planNow) return [` · ${renewed}`];
    const ratio = entry.utilization;
    const color = ratio >= 0.95 ? theme.red : ratio >= 0.8 ? theme.amber : undefined;
    return [
      ` · ${name} `,
      h(Text, { key: name, ...(color ? { color } : {}) }, `${Math.round(ratio * 100)}%`),
      ratio >= 0.5 ? ` (renova ${clockOrDay(resetsAt, timeZone, planNow)})` : "",
    ];
  };
  const plan = usage ? [...planWindow("plano", "plano renovado", usage.fiveHour), ...planWindow("semana", "semana renovada", usage.sevenDay)] : [];
  const status = connected
    ? h(Text, { color: theme.muted }, h(Text, { color: theme.green }, "●"), " motor", ...plan)
    : h(Text, { color: theme.red }, "motor desligado: rode neoterm daemon ou neoterm service on");

  return h(
    Box,
    { flexDirection: "column", width: columns, height: Math.max(rows - 1, 12) },
    // Um arquivo aberto ocupa a tela toda, sem a lateral: mais largura para o código.
    mode === "viewer" ? renderViewerScreen() : h(
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
      h(
        Box,
        { flexShrink: 1, overflow: "hidden" },
        h(Text, { color: flash ? theme.accent : theme.muted, wrap: "truncate-end" }, flash ?? hints),
      ),
      h(Box, { flexShrink: 0, marginLeft: 2 }, status),
    ),
  );
}
