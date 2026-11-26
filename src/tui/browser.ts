import { homedir } from "node:os";
import { Box, type DOMElement, Text, type useInput } from "ink";
import { createElement as h, type ReactNode, type RefObject } from "react";
import { displayPath, type Entry, filterEntries, listDir, parentOf, rootEntries } from "./files.ts";
import { theme } from "./theme.ts";

/*
 * Um navegador de pastas no estilo do nvim, usado pelo :path (arquivos do escopo da conversa) e
 * pelo campo de pastas do formulário de agente (pastas de todo o computador). Estado e teclas são
 * puros; quem usa aplica as ações (abrir pasta, escolher, marcar, fechar).
 */

type InkKey = Parameters<Parameters<typeof useInput>[0]>[1];

export type Browser = {
  /** O limite: não sobe acima destas pastas. Com várias, o topo (`dir` null) é a lista delas. */
  roots: string[];
  dir: string | null;
  entries: Entry[];
  index: number;
  /** O / do nvim: não nulo enquanto filtra, com o que já foi digitado. */
  filter: string | null;
  hidden: boolean;
  /** Só pastas (para escolher o escopo de um agente). */
  dirsOnly: boolean;
  /** A primeira linha à vista, para a seleção continuar visível ao rolar. */
  top: number;
  /** Arquivos à mão no topo (os que o agente mexeu na conversa), antes das pastas. */
  pinned: Entry[];
  error?: string;
};

export function newBrowser(roots: string[], options: { dirsOnly?: boolean; pinned?: Entry[] } = {}): Browser {
  return { roots, dir: null, entries: [], index: 0, filter: null, hidden: false, dirsOnly: options.dirsOnly ?? false, top: 0, pinned: options.pinned ?? [] };
}

/** O navegador com `dir` aberto (ou o topo, com null) e `select` selecionado, se estiver lá. */
export async function load(browser: Browser, dir: string | null, select?: string): Promise<Browser> {
  let entries: Entry[] = [];
  let error: string | undefined;
  try {
    entries = dir === null ? [...browser.pinned, ...rootEntries(browser.roots)] : await listDir(dir, browser.hidden);
    if (browser.dirsOnly) entries = entries.filter((entry) => entry.dir);
  } catch (problem) {
    const code = (problem as NodeJS.ErrnoException).code;
    error = code === "EACCES" || code === "EPERM" ? "sem permissão para ler esta pasta" : (problem as Error).message;
  }
  const index = Math.max(select ? entries.findIndex((entry) => entry.path === select) : 0, 0);
  return { ...browser, dir, entries, index, filter: null, top: 0, error };
}

export function visibleEntries(browser: Browser): Entry[] {
  return browser.filter === null ? browser.entries : filterEntries(browser.entries, browser.filter);
}

export function selectedEntry(browser: Browser): Entry | undefined {
  const visible = visibleEntries(browser);
  return visible[Math.min(browser.index, visible.length - 1)];
}

export type BrowserAction =
  | { type: "state"; browser: Browser }
  /** Abrir outra pasta (ou o topo); `select` fica selecionado. */
  | { type: "load"; browser: Browser; dir: string | null; select?: string }
  /** Enter num arquivo. */
  | { type: "choose"; entry: Entry }
  /** Espaço: marcar ou inserir o item selecionado. */
  | { type: "mark"; entry: Entry }
  | { type: "close" }
  | { type: "none" };

function moved(browser: Browser, step: number): BrowserAction {
  const count = visibleEntries(browser).length;
  return { type: "state", browser: { ...browser, index: Math.min(Math.max(browser.index + step, 0), Math.max(count - 1, 0)) } };
}

function up(browser: Browser): BrowserAction {
  if (browser.dir === null) return { type: "none" };
  const parent = parentOf(browser.dir, browser.roots);
  if (parent !== null) return { type: "load", browser, dir: parent, select: browser.dir };
  // Na raiz: sobe para o topo, se ele tiver mais que uma pasta (várias, ou os arquivos à mão).
  return browser.roots.length > 1 || browser.pinned.length > 0 ? { type: "load", browser, dir: null, select: browser.dir } : { type: "none" };
}

/** O que uma tecla faz no navegador. `page`: quantas linhas cabem, para pgup/pgdn. */
export function browserKey(browser: Browser, input: string, key: InkKey, page: number): BrowserAction {
  const selected = selectedEntry(browser);
  const open = (): BrowserAction =>
    !selected ? { type: "none" } : selected.dir ? { type: "load", browser, dir: selected.path } : { type: "choose", entry: selected };
  if (key.upArrow) return moved(browser, -1);
  if (key.downArrow) return moved(browser, 1);
  if (key.pageUp) return moved(browser, -page);
  if (key.pageDown) return moved(browser, page);
  if (key.return) return open();
  if (browser.filter !== null) {
    if (key.escape) return { type: "state", browser: { ...browser, filter: null, index: 0 } };
    if (key.backspace || key.delete) {
      const filter = browser.filter ? [...browser.filter].slice(0, -1).join("") : null;
      return { type: "state", browser: { ...browser, filter, index: 0 } };
    }
    if (input && !key.ctrl && !key.meta && !key.tab) return { type: "state", browser: { ...browser, filter: browser.filter + input, index: 0 } };
    return { type: "none" };
  }
  if (key.escape || input === "q") return { type: "close" };
  if (input === "j") return moved(browser, 1);
  if (input === "k") return moved(browser, -1);
  if (input === "g") return moved(browser, -Number.MAX_SAFE_INTEGER);
  if (input === "G") return moved(browser, Number.MAX_SAFE_INTEGER);
  if (input === "l" || key.rightArrow) return open();
  if (input === "h" || input === "-" || key.leftArrow || key.backspace || key.delete) return up(browser);
  if (input === "~" && browser.roots.includes("/")) return { type: "load", browser, dir: homedir() };
  if (input === "/") return { type: "state", browser: { ...browser, filter: "", index: 0 } };
  if (input === " " && selected) return { type: "mark", entry: selected };
  if (input === ".") return { type: "load", browser: { ...browser, hidden: !browser.hidden }, dir: browser.dir, select: selected?.path };
  return { type: "none" };
}

/** Onde o navegador está, para o título: no computador todo, o caminho com ~; num escopo, a partir dele. */
function where(browser: Browser): string {
  if (browser.dir !== null && browser.roots.includes("/")) return browser.dir.replace(homedir(), "~") || "/";
  return displayPath(browser.dir, browser.roots);
}

/** O painel do navegador, à direita. `marked`: caminhos já escolhidos, com um ✓. */
export function renderBrowser(
  browser: Browser,
  options: { title: string; width: number; height: number; focused: boolean; areaRef: RefObject<DOMElement | null>; footer: string; marked?: ReadonlySet<string> },
): ReactNode {
  const visible = visibleEntries(browser);
  const height = Math.max(options.height, 1);
  const index = Math.min(browser.index, Math.max(visible.length - 1, 0));
  let top = Math.min(browser.top, Math.max(visible.length - height, 0));
  if (index < top) top = index;
  if (index >= top + height) top = index - height + 1;
  browser.top = top;
  const inner = options.width - 2;
  const lines: ReactNode[] = browser.error
    ? [h(Text, { key: "error", color: theme.red, wrap: "wrap" }, browser.error)]
    : visible.length === 0
      ? [h(Text, { key: "empty", color: theme.muted }, browser.filter ? "nada com esse nome" : browser.dirsOnly ? "sem pastas aqui" : "pasta vazia")]
      : visible.slice(top, top + height).map((entry, at) => {
          const active = top + at === index;
          const bg = active ? { backgroundColor: theme.selected } : {};
          // No topo, as pastas aparecem com o caminho; os arquivos à mão, com o nome que vieram.
          const name = browser.dir === null && entry.dir ? entry.path.replace(homedir(), "~") : entry.name;
          const mark = options.marked?.has(entry.path) ? "✓" : entry.dir ? "▸" : " ";
          const label = `${mark} ${name}${entry.dir ? "/" : ""}`;
          return h(
            Text,
            { key: entry.path, wrap: "truncate-end", ...bg },
            h(Text, { ...bg }, active && options.focused ? "▌" : " "),
            h(
              Text,
              { color: options.marked?.has(entry.path) ? theme.green : entry.dir ? theme.accent : undefined, bold: active, ...bg },
              label.padEnd(Math.max(inner - 1, 1)),
            ),
          );
        });
  return h(
    Box,
    {
      width: options.width,
      flexShrink: 0,
      flexDirection: "column",
      marginLeft: 1,
      paddingLeft: 1,
      borderStyle: "single",
      borderTop: false,
      borderBottom: false,
      borderRight: false,
      borderColor: options.focused ? theme.accent : theme.border,
    },
    // O título fica; o caminho, se não couber, perde o começo (o fim é o que interessa).
    h(
      Box,
      { flexShrink: 0 },
      h(Text, { bold: true, color: options.focused ? theme.accent : undefined }, `${options.title} · `),
      h(Box, { flexShrink: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden" }, h(Text, { color: theme.muted, wrap: "truncate-start" }, `${where(browser)}${browser.hidden ? " · com ocultos" : ""}`)),
    ),
    browser.filter !== null
      ? h(Text, { wrap: "truncate-start" }, h(Text, { color: theme.accent }, "/"), browser.filter, options.focused ? h(Text, { inverse: true }, " ") : null)
      : null,
    h(Box, { ref: options.areaRef, flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, overflow: "hidden", marginTop: 1 }, ...lines),
    h(Text, { color: theme.muted, wrap: "truncate-end" }, options.footer),
  );
}
