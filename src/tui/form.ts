import { Box, Text } from "ink";
import { createElement as h, type ReactNode } from "react";
import { theme } from "./theme.ts";

/*
 * Um formulário de terminal: campos de texto, escolha (←→) e marcação múltipla (←→ e espaço).
 * Tab ou ↓ vai para o próximo, ↑ volta, enter avança e no último salva, ctrl+s salva de qualquer
 * campo, esc cancela. É só estado e funções puras; a App liga as teclas.
 */

export type Option = { value: string; label: string };

export type Field =
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

export type FormAction = { type: "state"; form: FormState } | { type: "submit" } | { type: "cancel" };

/** O que uma tecla faz no formulário. */
export function formKey(form: FormState, input: string, key: Key): FormAction {
  const field = form.fields[form.index];
  if (!field) return { type: "cancel" };
  if (key.escape) return { type: "cancel" };
  if (key.ctrl && input === "s") return { type: "submit" };
  if (key.return) return isLast(form) ? { type: "submit" } : { type: "state", form: move(form, 1) };
  if (key.tab) return { type: "state", form: move(form, key.shift ? -1 : 1) };
  if (key.downArrow) return { type: "state", form: move(form, 1) };
  if (key.upArrow) return { type: "state", form: move(form, -1) };

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

export function renderForm(form: FormState): ReactNode {
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
    if (field.kind === "text") {
      const empty = !field.value;
      control = h(
        Text,
        { wrap: "wrap" },
        h(Text, { color: empty ? theme.muted : undefined }, empty ? (field.placeholder ?? "") : field.value),
        active ? h(Text, { inverse: true }, " ") : null,
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
        { key: field.key, flexDirection: "column", marginBottom: 1 },
        h(Box, { flexDirection: "row" }, label, h(Box, { flexGrow: 1 }, control)),
        active && field.hint ? h(Box, { marginLeft: LABEL_WIDTH }, h(Text, { color: theme.muted }, field.hint)) : null,
      ),
    );
  });
  const preview = form.preview?.(values);
  return h(
    Box,
    { flexDirection: "column" },
    ...rows,
    preview ? h(Text, { key: "preview", color: theme.accent }, preview) : null,
    form.error ? h(Text, { key: "error", color: theme.red }, `✗ ${form.error}`) : null,
    form.busy ? h(Text, { key: "busy", color: theme.muted }, "salvando…") : null,
  );
}
