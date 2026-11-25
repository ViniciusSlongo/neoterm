import { homedir } from "node:os";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { createElement as h, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessagePart } from "../db/schema.ts";
import type { NeotermEvent } from "../events.ts";
import { describeCron, describeWhen } from "../routines/schedule.ts";
import type { NeotermState } from "../state.ts";
import type { NeotermApi, RoutineItem, RunItem, ViewMessage, ViewScope } from "./api.ts";
import { type FormState, formKey, renderForm, valuesOf } from "./form.ts";
import { newAgentForm, newGroupForm, newRoutineForm } from "./forms.ts";
import { SPINNER, theme } from "./theme.ts";

/*
 * A interface: lateral com agentes, grupos, rotinas de hoje e o que precisa de você; ao lado, a
 * conversa. Tudo vem do motor: o estado por /state, as mudanças por /events.
 */

type Item =
  | { kind: "agent"; slug: string }
  | { kind: "group"; slug: string }
  | { kind: "attention"; id: string }
  | { kind: "new-agent" }
  | { kind: "new-group" };

type Mode = "chat" | "routines" | "form" | "attention";
type Live = { agent: string; parts: MessagePart[] };
type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

const SIDEBAR_WIDTH = 30;
const scopeKey = (scope: { kind: string; slug: string }) => `${scope.kind}:${scope.slug}`;

function itemsOf(state: NeotermState | null): Item[] {
  if (!state) return [];
  return [
    ...state.agents.map((agent) => ({ kind: "agent", slug: agent.slug }) as const),
    ...state.groups.map((group) => ({ kind: "group", slug: group.slug }) as const),
    ...state.attention.map((item) => ({ kind: "attention", id: item.id }) as const),
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
      return [h(Box, { key: `${keyPrefix}t${index}`, paddingLeft: 2, marginTop: index > 0 ? 1 : 0, flexShrink: 0 }, withMentions(part.text, "x"))];
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

function renderMessage(message: ViewMessage, inGroup: boolean, timeZone: string): ReactNode {
  const time = h(Text, { color: theme.muted }, `  ${clock(message.createdAt, timeZone)}`);
  switch (message.author) {
    case "person":
      return inGroup
        ? h(
            Box,
            { key: message.id, flexDirection: "column", marginBottom: 1, flexShrink: 0 },
            h(Text, null, h(Text, { color: theme.accent, bold: true }, "você"), time),
            h(Box, { paddingLeft: 2 }, withMentions(message.text, "p")),
          )
        : h(
            Box,
            { key: message.id, marginBottom: 1, flexShrink: 0 },
            h(Text, { wrap: "wrap" }, h(Text, { color: theme.accent }, "› "), h(Text, { bold: true }, message.text)),
          );
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

/** `cwd`: de onde a interface foi aberta; um caminho relativo digitado num formulário parte dela. */
export function App({ api, cwd = process.cwd() }: { api: NeotermApi; cwd?: string }): ReactNode {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = size.columns || 100;
  const rows = size.rows || 30;
  const [state, setState] = useState<NeotermState | null>(null);
  const [connected, setConnected] = useState(true);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<"sidebar" | "main">("main");
  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const [live, setLive] = useState<Record<string, Live>>({});
  const [draft, setDraft] = useState("");
  const [scrollBack, setScrollBack] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);
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
    setScrollBack(0);
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

  const anyLive = Object.keys(live).length > 0;
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [anyLive]);

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

  const openForm = (next: FormState) => {
    formReturn.current = mode === "routines" ? "routines" : "chat";
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

  const send = () => {
    const text = draft.trim();
    if (!text || !scope) return;
    setDraft("");
    if (text === "/rotinas") return openRoutines();
    if (text === "/pausar" || text === "/retomar") {
      if (scope.kind !== "agent") return say("só agentes pausam");
      return run(api.setPaused(scope.slug, text === "/pausar"), text === "/pausar" ? `${scope.slug} pausado` : `${scope.slug} retomado`);
    }
    if (text === "/ajuda") return say("/rotinas · /pausar · /retomar · esc volta para a lateral · ctrl+c sai");
    const key = scopeKey(scope);
    setPending((current) => ({ ...current, [key]: [...(current[key] ?? []), text] }));
    setScrollBack(0);
    void api.send(scope, text).catch((error: Error) => {
      say(error.message);
      setPending((current) => ({ ...current, [key]: (current[key] ?? []).filter((entry) => entry !== text) }));
    });
  };

  const handleForm = (input: string, key: InkKey) => {
    if (!form || form.busy) return;
    const action = formKey(form, input, key);
    if (action.type === "cancel") return closeForm();
    if (action.type === "state") return setForm(action.form);
    const submitting = { ...form, busy: true, error: undefined };
    setForm(submitting);
    form.submit(valuesOf(form)).then(
      () => {
        closeForm();
        void refreshState();
      },
      (error: Error) => setForm({ ...submitting, busy: false, error: error.message }),
    );
  };

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
        setMode(attentionItem.routineId ? "routines" : "chat");
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
    if (key.return) return send();
    if (key.backspace || key.delete) return setDraft((value) => [...value].slice(0, -1).join(""));
    if (key.upArrow && !draft) return move(-1);
    if (key.downArrow && !draft) return move(1);
    if (key.pageUp) return setScrollBack((value) => Math.min(value + 3, Math.max(messages.length - 1, 0)));
    if (key.pageDown) return setScrollBack((value) => Math.max(value - 3, 0));
    if (key.ctrl && input === "u") return setDraft("");
    if (key.ctrl && input === "r") return openRoutines();
    if (input && !key.ctrl && !key.meta) setDraft((value) => value + input.replace(/[\r\n]+/g, " "));
  };

  useInput((input, key) => {
    if (mode === "form") return handleForm(input, key);
    if (focus === "sidebar") return handleSidebar(input, key);
    if (mode === "routines") return handleRoutines(input, key);
    if (mode === "attention") return handleAttention(input, key);
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

  // ---------- lateral ----------
  const inner = SIDEBAR_WIDTH - 3;
  const row = (key: string, active: boolean, left: ReactNode[], leftText: string, right = "", rightColor: string = theme.muted) => {
    const space = Math.max(inner - [...leftText].length - [...right].length, 1);
    const bg = active ? { backgroundColor: theme.selected } : {};
    return keep(key, h(
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
      const glyph =
        agent.state === "running" ? h(Text, { color: theme.green }, "●") : agent.state === "paused" ? h(Text, { color: theme.amber }, "‖") : h(Text, { color: theme.muted }, "○");
      const dot = unread.has(`agent:${agent.slug}`) ? " •" : "";
      sidebar.push(
        row(`a-${agent.slug}`, active, [glyph, h(Text, { bold: active }, ` ${agent.slug}`), h(Text, { color: theme.accent }, dot)], `○ ${agent.slug}${dot}`, agent.state === "paused" ? "pausado" : ""),
      );
    });
    for (const problem of state.problems) sidebar.push(h(Text, { key: `pr-${problem.slug}`, color: theme.red, wrap: "truncate-end" }, `  ✗ ${problem.slug}`));
    if (state.groups.length > 0) sidebar.push(label("GRUPOS"));
    state.groups.forEach((group) => {
      const at = items.findIndex((candidate) => candidate.kind === "group" && candidate.slug === group.slug);
      const active = at === index;
      const dot = unread.has(`group:${group.slug}`) ? " •" : "";
      const right = group.waiting ? "!" : group.busy ? "●" : "";
      sidebar.push(
        row(
          `g-${group.slug}`,
          active,
          [h(Text, { color: theme.muted }, "#"), h(Text, { bold: active }, ` ${group.slug}`), h(Text, { color: theme.accent }, dot)],
          `# ${group.slug}${dot}`,
          right,
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
    const newAgentAt = items.findIndex((candidate) => candidate.kind === "new-agent");
    const newGroupAt = items.findIndex((candidate) => candidate.kind === "new-group");
    sidebar.push(row("new-agent", newAgentAt === index, [h(Text, { color: theme.accent }, "+"), " novo agente"], "+ novo agente", "n", theme.accent));
    sidebar.push(row("new-group", newGroupAt === index, [h(Text, { color: theme.accent }, "+"), " novo grupo"], "+ novo grupo", "g", theme.accent));
  }

  // ---------- cabeçalho ----------
  const agentState = scope?.kind === "agent" ? state?.agents.find((agent) => agent.slug === scope.slug) : undefined;
  const groupState = scope?.kind === "group" ? state?.groups.find((group) => group.slug === scope.slug) : undefined;
  let headerLeft: ReactNode = h(Text, { bold: true }, "neoterm");
  let headerRight: ReactNode = null;
  if (mode === "form" && form) {
    headerLeft = h(Text, null, h(Text, { bold: true }, form.title), form.subtitle ? h(Text, { color: theme.muted }, ` · ${form.subtitle}`) : null);
  } else if (mode === "attention") {
    headerLeft = h(Text, { bold: true, color: theme.amber }, "precisa de você");
  } else if (agentState) {
    headerLeft = h(
      Text,
      null,
      h(Text, { bold: true }, mode === "routines" ? `rotinas · ${agentState.slug}` : agentState.slug),
      agentState.title ? h(Text, { color: theme.muted }, ` · ${agentState.title}`) : null,
      agentState.folders[0]
        ? h(
            Text,
            { color: theme.muted },
            ` · ${agentState.folders[0].replace(homedir(), "~")}${agentState.folders.length > 1 ? ` +${agentState.folders.length - 1}` : ""}`,
          )
        : null,
    );
    headerRight =
      agentState.state === "running"
        ? h(Text, null, h(Text, { color: theme.green }, "● "), h(Text, { color: theme.muted }, "rodando"))
        : agentState.state === "paused"
          ? h(Text, { color: theme.amber }, "‖ pausado")
          : h(Text, { color: theme.muted }, `○ livre${agentState.model ? ` · ${agentState.model}` : ""}`);
  } else if (groupState) {
    headerLeft = h(
      Text,
      null,
      h(Text, { bold: true }, mode === "routines" ? `rotinas · #${groupState.slug}` : `# ${groupState.slug}`),
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
    body = h(Box, { flexDirection: "column", paddingTop: 1 }, renderForm(form));
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
    const shown = scrollBack > 0 ? messages.slice(0, -scrollBack) : messages;
    const waiting = (pending[currentKey] ?? []).map((text, position) =>
      renderMessage({ id: `pending-${position}`, author: "person", text, parts: [], meta: {}, createdAt: new Date().toISOString() }, inGroup, timeZone),
    );
    const current = live[currentKey];
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
    body = h(
      Box,
      { flexDirection: "column", justifyContent: "flex-end", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden", paddingTop: 1 },
      ...shown.map((message) => renderMessage(message, inGroup, timeZone)),
      ...waiting,
      liveBlock,
      empty,
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
      ? h(
          Box,
          { borderStyle: "round", borderColor: focus === "main" ? theme.accent : theme.border, paddingX: 1, flexShrink: 0 },
          h(
            Text,
            { wrap: "truncate-start" },
            h(Text, { color: theme.accent, bold: true }, "> "),
            draft
              ? h(Text, null, draft)
              : h(Text, { color: theme.muted }, scope.kind === "group" ? "mensagem para o grupo · @nome chama um agente" : `mensagem para ${scope.slug} · /ajuda`),
            focus === "main" ? h(Text, { inverse: true }, " ") : null,
          ),
        )
      : null;

  // ---------- rodapé ----------
  let hints: string;
  if (mode === "form") hints = "tab próximo · ←→ opções · espaço marca · enter avança · ctrl+s salva · esc cancela";
  else if (focus === "sidebar") hints = "↑↓ escolhe · enter abre · n novo agente · g novo grupo · r rotinas · p pausa · q sai";
  else if (mode === "routines") hints = "↑↓ escolhe · n nova · espaço liga/desliga · x roda agora · d apaga · esc volta";
  else if (mode === "attention") hints = "esc volta para a lateral";
  else hints = "enter envia · esc lateral · ↑↓ troca (sem texto) · pgup/pgdn rola · ctrl+r rotinas";
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
            borderStyle: "single",
            borderTop: false,
            borderLeft: false,
            borderRight: false,
            borderColor: theme.border,
          },
          h(Box, { flexShrink: 1, overflow: "hidden" }, h(Text, { wrap: "truncate-end" }, headerLeft)),
          headerRight ? h(Box, { flexShrink: 0, marginLeft: 2 }, headerRight) : null,
        ),
        body,
        input,
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
