/* Números para gente ler: tamanhos, durações, "há quanto tempo", barras e um gráfico de uma linha. */

const decimal = (value: number, digits: number) =>
  new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);

/** 1536 → "1,5 KB"; usa base 1024, como o Finder mostra memória. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${decimal(size, size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** 95_000 → "1 min 35 s"; 7_380_000 → "2 h 3 min". */
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** Há quanto tempo, curto: "agora", "há 5 min", "há 3 h", "há 2 d". */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return "nunca";
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return "agora";
  if (ms < 3_600_000) return `há ${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `há ${Math.floor(ms / 3_600_000)} h`;
  return `há ${Math.floor(ms / 86_400_000)} d`;
}

/** Uma barra de `width` células para uma fração de 0 a 1. */
export function bar(ratio: number, width: number): { filled: string; empty: string } {
  const clamped = Math.min(Math.max(Number.isFinite(ratio) ? ratio : 0, 0), 1);
  const cells = Math.round(clamped * width);
  return { filled: "█".repeat(cells), empty: "░".repeat(width - cells) };
}

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Um gráfico de uma linha: cada valor vira um bloco, da altura proporcional ao maior. */
export function sparkline(values: readonly number[]): string {
  const top = Math.max(...values, 0);
  return values.map((value) => (top === 0 ? BLOCKS[0] : BLOCKS[Math.round((value / top) * (BLOCKS.length - 1))])).join("");
}

/** Um horário curto: "21:30" se for hoje, "dom 05:00" se for outro dia. */
export function clockOrDay(at: Date | string, timeZone: string, now: Date): string {
  const date = new Date(at);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  const day = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);
  if (day(date) === day(now)) return time;
  const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short" }).format(date).replace(".", "");
  return `${weekday} ${time}`;
}

export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
