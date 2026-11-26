/*
 * As cores das telas: fundo do terminal, um destaque e as cores de estado. Sem avatares.
 *
 * O destaque (o azul de fábrica) é escolhido em :config e guardado em ~/.neoterm/config.json. As
 * telas leem `theme.accent` na hora de desenhar, então trocar aqui vale no próximo desenho.
 */

export const DEFAULT_ACCENT = "#7CC4E8";

export const theme = {
  accent: DEFAULT_ACCENT,
  onAccent: "#0E0F11",
  muted: "#8A8F98",
  border: "#2A2D33",
  selected: "#1C2026",
  /** Fundo das mensagens de quem usa: um tom bem escuro do destaque. */
  person: "#1A2430",
  green: "#7FD18B",
  amber: "#E6B95C",
  red: "#F2877A",
};

/** As cores prontas para o destaque. */
export const ACCENTS: { name: string; hex: string }[] = [
  { name: "azul", hex: DEFAULT_ACCENT },
  { name: "ciano", hex: "#5FD7D7" },
  { name: "verde", hex: "#8BD48E" },
  { name: "lima", hex: "#C3E88D" },
  { name: "amarelo", hex: "#F0D27A" },
  { name: "laranja", hex: "#F5A76C" },
  { name: "rosa", hex: "#F38BB8" },
  { name: "lilás", hex: "#B39DF2" },
  { name: "roxo", hex: "#9D7CE8" },
  { name: "cinza", hex: "#C0C5CE" },
];

export const isHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value.trim());

function mix(hex: string, base: string, amount: number): string {
  const channel = (color: string, at: number) => Number.parseInt(color.slice(1 + at * 2, 3 + at * 2), 16);
  return `#${[0, 1, 2]
    .map((at) => Math.round(channel(base, at) + (channel(hex, at) - channel(base, at)) * amount).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

/** Troca o destaque (e o fundo das suas mensagens, que é um tom dele). Cor inválida volta ao azul. */
export function setAccent(hex: string | undefined): void {
  const accent = hex && isHexColor(hex) ? hex.toUpperCase() : DEFAULT_ACCENT;
  theme.accent = accent;
  theme.person = mix(accent, "#12151A", 0.12);
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
