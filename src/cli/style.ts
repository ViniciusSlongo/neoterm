/* As poucas cores do neoterm no terminal. Sem cor quando a saída não é um terminal ou com NO_COLOR. */

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paint = (open: string, close: string) => (text: string) =>
  enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const bold = paint("1", "22");
export const muted = paint("90", "39");
export const accent = paint("36", "39");
export const green = paint("32", "39");
export const red = paint("31", "39");
export const yellow = paint("33", "39");

export const ok = (text: string) => `${green("✓")} ${text}`;
export const fail = (text: string) => `${red("✗")} ${text}`;

export function indent(text: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
}
