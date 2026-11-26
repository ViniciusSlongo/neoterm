import { homedir } from "node:os";
import { Box, type DOMElement, Text } from "ink";
import { createElement as h, type ReactNode, type RefObject } from "react";
import { followCursor, editKey, renderLines } from "./textarea.ts";
import { theme } from "./theme.ts";

/*
 * Um formulário de terminal: campos de texto, escolha (←→) e marcação múltipla (←→ e espaço).
 * Tab ou ↓ vai para o próximo, ↑ volta, enter avança e no último salva, ctrl+s salva de qualquer
 * campo, esc cancela. É só estado e funções puras; a App liga as teclas.
 */

export type Option = { value: string; label: string };

export type Field =
  /** Pastas escolhidas num navegador (a App abre o navegador ao lado enquanto o campo está ativo). */
  /**
   * `single`: uma pasta só; escolher outra troca a anterior. `start`: onde a lista abre (sem isto,
   * na pasta de onde a interface foi aberta).
   */
  | {
      key: string;
      label: string;
      kind: "folders";
      value: string[];
      single?: boolean;
      start?: string;
      hint?: string;
      placeholder?: string;
      when?: (values: Values) => boolean;
    }
  /** Texto de várias linhas, com cursor: enter quebra a linha, tab sai do campo. */
  | { key: string; label: string; kind: "textarea"; value: string; cursor: number; hint?: string; placeholder?: string; when?: (values: Values) => boolean }
  | { key: string; label: string; kind: "text"; value: string; hint?: string; placeholder?: string; when?: (values: Values) => boolean }
  | { key: string; label: string; kind: "choice"; value: string; options: Option[]; hint?: string; when?: (values: Values) => boolean }
  | {
      key: string;
      label: string;
      kind: "multi";
      value: string[];
      options: Option[];
      cursor: number;
      hint?: string;
      when?: (values: Values) => boolean;
    };

export type Values = Record<string, string | string[]>;

export type FormState = {
  title: string;
  subtitle?: string;
  fields: Field[];
  index: number;
  error?: string;
  busy?: boolean;
  /** Excluir o que o formulário edita: ctrl+d, e ctrl+d de novo para confirmar. */
  remove?: { what: string; consequence: string; run: () => Promise<void> };
  /** O primeiro ctrl+d foi apertado: o próximo exclui. */
  confirmingRemove?: boolean;
  /** Uma linha calculada dos valores, como "próxima execução: …". */
  preview?: (values: Values) => string | undefined;
  submit: (values: Values) => Promise<void>;
};

export type Key = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

export function valuesOf(form: FormState): Values {
  return Object.fromEntries(form.fields.map((field) => [field.key, field.value]));
}

function visible(form: FormState): number[] {
  const values = valuesOf(form);
  return form.fields.flatMap((field, index) => (!field.when || field.when(values) ? [index] : []));
}

function move(form: FormState, step: 1 | -1): FormState {
  const order = visible(form);
  const at = Math.max(order.indexOf(form.index), 0);
  const next = order[Math.min(Math.max(at + step, 0), order.length - 1)] ?? form.index;
  return { ...form, index: next };
}

function isLast(form: FormState): boolean {
  return visible(form).at(-1) === form.index;
}

function replaceField(form: FormState, field: Field): FormState {
  const fields = form.fields.map((current, index) => (index === form.index ? field : current));
  return { ...form, fields, error: undefined };
}

/** O formulário com outro valor num campo, pela chave. */
export function setFieldValue(form: FormState, key: string, value: string | string[]): FormState {
  const fields = form.fields.map((field) => (field.key === key ? ({ ...field, value } as Field) : field));
  return { ...form, fields, error: undefined };
}

export type FormAction = { type: "state"; form: FormState } | { type: "submit" } | { type: "cancel" };

/** O que uma tecla faz no formulário. */
export function formKey(form: FormState, input: string, key: Key): FormAction {
  const field = form.fields[form.index];
  if (!field) return { type: "cancel" };
  if (key.escape) return { type: "cancel" };
  if (key.ctrl && input === "s") return { type: "submit" };
  if (field.kind === "textarea" && !key.tab) {
    const draft = { text: field.value, cursor: field.cursor };
    const next = key.return ? { text: `${[...draft.text].slice(0, draft.cursor).join("")}\n${[...draft.text].slice(draft.cursor).join("")}`, cursor: draft.cursor + 1 } : editKey(draft, input, key as never);
    return { type: "state", form: next ? replaceField(form, { ...field, value: next.text, cursor: next.cursor }) : form };
  }
  if (key.return) return isLast(form) ? { type: "submit" } : { type: "state", form: move(form, 1) };
  if (key.tab) return { type: "state", form: move(form, key.shift ? -1 : 1) };
  if (key.downArrow) return { type: "state", form: move(form, 1) };
  if (key.upArrow) return { type: "state", form: move(form, -1) };

  if (field.kind === "folders") {
    // As teclas de navegar são do navegador; aqui o backspace tira a última pasta escolhida.
    if (key.backspace || key.delete) return { type: "state", form: replaceField(form, { ...field, value: field.value.slice(0, -1) }) };
    return { type: "state", form };
  }
  if (field.kind === "text") {
    if (key.backspace || key.delete) return { type: "state", form: replaceField(form, { ...field, value: [...field.value].slice(0, -1).join("") }) };
    if (key.ctrl && input === "u") return { type: "state", form: replaceField(form, { ...field, value: "" }) };
    if (input && !key.ctrl) return { type: "state", form: replaceField(form, { ...field, value: field.value + input.replace(/[\r\n]+/g, " ") }) };
    return { type: "state", form };
  }
  if (field.kind === "choice") {
    if (key.leftArrow || key.rightArrow) {
      const at = field.options.findIndex((option) => option.value === field.value);
      const next = (at + (key.rightArrow ? 1 : -1) + field.options.length) % field.options.length;
      return { type: "state", form: replaceField(form, { ...field, value: field.options[next]?.value ?? field.value }) };
    }
    return { type: "state", form };
  }
  if (field.kind === "textarea") return { type: "state", form };
  if (key.leftArrow || key.rightArrow) {
    const cursor = (field.cursor + (key.rightArrow ? 1 : -1) + field.options.length) % field.options.length;
    return { type: "state", form: replaceField(form, { ...field, cursor }) };
  }
  if (input === " ") {
    const option = field.options[field.cursor];
    if (!option) return { type: "state", form };
    // A ordem em que se marca importa (no grupo, o primeiro marcado coordena).
    const value = field.value.includes(option.value)
      ? field.value.filter((item) => item !== option.value)
      : [...field.value, option.value];
    return { type: "state", form: replaceField(form, { ...field, value }) };
  }
  return { type: "state", form };
}

const LABEL_WIDTH = 16;
/** Quantas linhas um campo de texto mostra, no máximo. */
const TEXT_MAX_LINES = 4;
/** A partir de quantos caracteres o campo avisa o tamanho (o texto pode estar passando do que aparece). */
const TEXT_LONG = 200;

/**
 * `fit`: medido pela App. `overflowing` diz se os campos passam da altura disponível; só aí o
 * formulário rola até o campo ativo. Cabendo, fica sempre no topo.
 */
export function renderForm(
  form: FormState,
  fit: { viewportRef?: RefObject<DOMElement | null>; contentRef?: RefObject<DOMElement | null>; overflowing?: boolean } = {},
): ReactNode {
  const values = valuesOf(form);
  const rows: ReactNode[] = [];
  form.fields.forEach((field, index) => {
    if (field.when && !field.when(values)) return;
    const active = index === form.index;
    const label = h(
      Box,
      { width: LABEL_WIDTH, flexShrink: 0 },
      h(Text, { color: active ? theme.accent : theme.muted, bold: active }, field.label),
    );
    let control: ReactNode;
    if (field.kind === "textarea") {
      const draft = { text: field.value, cursor: field.cursor };
      const lineCount = field.value.split("\n").length;
      const first = followCursor(draft, Number.MAX_SAFE_INTEGER, TEXT_MAX_LINES);
      const cursorLine = field.value.slice(0, field.cursor).split("\n").length - 1;
      const chars = [...field.value].length;
      control = h(
        Box,
        { flexDirection: "column", flexGrow: 1 },
        h(
          Box,
          {
            flexDirection: "column",
            maxHeight: TEXT_MAX_LINES,
            overflow: "hidden",
            // O cursor na última linha à vista: mostra o fim dela (onde se digita); senão, o começo.
            justifyContent: cursorLine >= first + TEXT_MAX_LINES - 1 || cursorLine === lineCount - 1 ? "flex-end" : "flex-start",
          },
          ...(field.value
            ? renderLines(draft, { first, count: TEXT_MAX_LINES, focused: active }).map((line, at) => h(Box, { key: at, flexShrink: 0 }, line))
            : [h(Text, { key: "empty" }, active ? h(Text, { inverse: true }, " ") : null, h(Text, { color: theme.muted }, field.placeholder ?? ""))]),
        ),
        chars > TEXT_LONG || lineCount > TEXT_MAX_LINES
          ? h(Text, { color: theme.muted }, `${new Intl.NumberFormat("pt-BR").format(chars)} caracteres · ${lineCount} ${lineCount === 1 ? "linha" : "linhas"}`)
          : null,
      );
    } else if (field.kind === "folders") {
      // Uma pasta por linha; sem espaço, o caminho perde o começo (o fim é o que identifica).
      control = field.value.length
        ? h(
            Box,
            { flexDirection: "column", flexGrow: 1, flexShrink: 1 },
            ...field.value.map((path) =>
              h(
                Box,
                { key: path },
                h(Text, { color: theme.green }, "✓ "),
                h(Box, { flexShrink: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden" }, h(Text, { wrap: "truncate-start" }, path.replace(homedir(), "~"))),
              ),
            ),
          )
        : h(Text, { color: theme.muted }, field.placeholder ?? "");
    } else if (field.kind === "text") {
      const empty = !field.value;
      const text = h(
        Text,
        { wrap: "wrap" },
        h(Text, { color: empty ? theme.muted : undefined }, empty ? (field.placeholder ?? "") : field.value),
        active ? h(Text, { inverse: true }, " ") : null,
      );
      // Um texto longo (colado, por exemplo) não empurra os outros campos: o campo mostra no máximo
      // algumas linhas, sempre o fim, que é onde se digita.
      const long = [...field.value].length > TEXT_LONG;
      control = h(
        Box,
        { flexDirection: "column", flexGrow: 1 },
        h(Box, { flexDirection: "column", maxHeight: TEXT_MAX_LINES, overflow: "hidden", justifyContent: "flex-end" }, h(Box, { flexShrink: 0 }, text)),
        long ? h(Text, { color: theme.muted }, `${new Intl.NumberFormat("pt-BR").format([...field.value].length)} caracteres · mostrando o fim`) : null,
      );
    } else if (field.kind === "choice") {
      control = h(
        Text,
        null,
        ...field.options.flatMap((option, position) => [
          position > 0 ? h(Text, { key: `s${position}` }, "  ") : null,
          option.value === field.value
            ? h(Text, { key: option.value, backgroundColor: theme.accent, color: theme.onAccent, bold: true }, ` ${option.label} `)
            : h(Text, { key: option.value, color: theme.muted }, option.label),
        ]),
      );
    } else {
      control = h(
        Text,
        { wrap: "wrap" },
        ...field.options.flatMap((option, position) => {
          const checked = field.value.includes(option.value);
          const mark = checked ? "[x]" : "[ ]";
          const focused = active && position === field.cursor;
          return [
            position > 0 ? h(Text, { key: `s${position}` }, "  ") : null,
            h(
              Text,
              { key: option.value, color: checked ? theme.accent : theme.muted, underline: focused, bold: focused },
              `${mark} ${option.label}`,
            ),
          ];
        }),
      );
    }
    rows.push(
      h(
        Box,
        // Os campos não encolhem: sem altura, o formulário corta embaixo, em vez de um campo
        // desenhar por cima do outro.
        { key: field.key, flexDirection: "column", marginBottom: 1, flexShrink: 0 },
        h(Box, { flexDirection: "row", flexShrink: 0 }, label, h(Box, { flexGrow: 1, flexShrink: 1 }, control)),
        active && field.hint ? h(Box, { marginLeft: LABEL_WIDTH }, h(Text, { color: theme.muted }, field.hint)) : null,
      ),
    );
  });
  const preview = form.preview?.(values);
  // Os campos rolam junto com o ativo; o rodapé (erro, confirmação de excluir, "salvando…") fica
  // sempre à vista embaixo.
  const activeRow = Math.max(rows.findIndex((row) => (row as { key?: string }).key === form.fields[form.index]?.key), 0);
  return h(
    Box,
    { flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0 },
    h(
      Box,
      {
        ref: fit.viewportRef,
        flexDirection: "column",
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        overflow: "hidden",
        justifyContent: fit.overflowing && activeRow > rows.length / 2 ? "flex-end" : "flex-start",
      },
      h(Box, { ref: fit.contentRef, flexDirection: "column", flexShrink: 0 }, ...rows),
    ),
    preview ? h(Text, { key: "preview", color: theme.accent }, preview) : null,
    form.error ? h(Text, { key: "error", color: theme.red }, `✗ ${form.error}`) : null,
    form.remove
      ? form.confirmingRemove
        ? h(
            Box,
            { key: "remove", marginTop: 1, flexDirection: "column" },
            h(Text, { color: theme.red, bold: true }, `Aperte ctrl+d de novo para excluir ${form.remove.what}.`),
            h(Text, { color: theme.red }, form.remove.consequence),
            h(Text, { color: theme.muted }, "Qualquer outra tecla desiste."),
          )
        : h(Box, { key: "remove", marginTop: 1 }, h(Text, { color: theme.muted }, `ctrl+d exclui ${form.remove.what}`))
      : null,
    form.busy ? h(Text, { key: "busy", color: theme.muted }, "salvando…") : null,
  );
}
