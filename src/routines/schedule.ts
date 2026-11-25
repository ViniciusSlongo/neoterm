import { CronExpressionParser } from "cron-parser";

/*
 * O horário de uma rotina: uma expressão cron de cinco campos num fuso.
 * As regras vêm do OpenBot (CopilotKit, MIT): no mínimo 15 minutos entre execuções, porque um
 * modelo pode ser convencido de qualquer coisa que uma frase descreva, inclusive "a cada minuto",
 * e o piso é o que uma frase não atravessa.
 */

export const MINIMUM_INTERVAL_MS = 15 * 60_000;

export class ScheduleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleRefused";
  }
}

export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parse(cron: string, timeZone: string, from: Date) {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new ScheduleRefused("o horário precisa ter 5 campos: minuto hora dia mês dia-da-semana (ex.: 0 9 * * 1-5)");
  }
  if (!isKnownTimeZone(timeZone)) throw new ScheduleRefused(`não conheço o fuso "${timeZone}"`);
  try {
    return CronExpressionParser.parse(cron.trim(), { currentDate: from, tz: timeZone });
  } catch (error) {
    throw new ScheduleRefused(`não entendi o horário "${cron}": ${(error as Error).message}`);
  }
}

/** A próxima vez depois de `after`. */
export function nextOccurrence(cron: string, timeZone: string, after: Date): Date {
  return parse(cron, timeZone, after).next().toDate();
}

/** As vezes entre `from` e `to`, em ordem. */
export function occurrencesBetween(cron: string, timeZone: string, from: Date, to: Date): Date[] {
  const iterator = parse(cron, timeZone, new Date(from.getTime() - 1));
  const found: Date[] = [];
  for (let index = 0; index < 500; index++) {
    const next = iterator.next().toDate();
    if (next > to) break;
    found.push(next);
  }
  return found;
}

/** Recusa o horário que não é válido ou que roda mais de uma vez a cada 15 minutos. */
export function validateSchedule(cron: string, timeZone: string, now: Date = new Date()): void {
  const iterator = parse(cron, timeZone, now);
  let previous = iterator.next().toDate();
  // Uma janela de algumas centenas de execuções pega "*/5 9 * * *" e "0,5 * * * *".
  for (let index = 0; index < 300; index++) {
    const next = iterator.next().toDate();
    if (next.getTime() - previous.getTime() < MINIMUM_INTERVAL_MS) {
      throw new ScheduleRefused("uma rotina pode rodar no máximo a cada 15 minutos");
    }
    previous = next;
  }
}

const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** O horário em palavras: "seg–sex 09:00", "todo dia 18:00", "sex 17:00", "dia 1 · 08:00". */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") {
    if (/^\*\/\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
      return `a cada ${minute.slice(2)} min`;
    }
    if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour) && dayOfMonth === "*" && dayOfWeek === "*") {
      return `a cada ${hour.slice(2)} h`;
    }
    return cron;
  }
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dayOfMonth === "*" && dayOfWeek === "*") return `todo dia ${time}`;
  if (dayOfMonth === "*") {
    const days = describeWeekdays(dayOfWeek);
    return days ? `${days} ${time}` : cron;
  }
  if (dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) return `dia ${dayOfMonth} · ${time}`;
  return cron;
}

function describeWeekdays(field: string): string | undefined {
  if (field === "1-5") return "seg–sex";
  if (field === "0,6" || field === "6,0") return "sáb e dom";
  const days: string[] = [];
  for (const part of field.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      days.push(`${WEEKDAYS[Number(range[1]) % 7]}–${WEEKDAYS[Number(range[2]) % 7]}`);
    } else if (/^\d$/.test(part)) {
      days.push(WEEKDAYS[Number(part) % 7] ?? part);
    } else {
      return undefined;
    }
  }
  return days.join(", ");
}

/** Uma data no fuso, curta: "hoje 09:00", "amanhã 09:00", "sex 27/11 17:00". */
export function describeWhen(date: Date, timeZone: string, now: Date = new Date()): string {
  const day = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  const today = day(now);
  const tomorrow = day(new Date(now.getTime() + 24 * 3_600_000));
  const yesterday = day(new Date(now.getTime() - 24 * 3_600_000));
  const target = day(date);
  if (target === today) return `hoje ${time}`;
  if (target === tomorrow) return `amanhã ${time}`;
  if (target === yesterday) return `ontem ${time}`;
  const weekday = new Intl.DateTimeFormat("pt-BR", { timeZone, weekday: "short" }).format(date).replace(".", "");
  const short = new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit" }).format(date);
  return `${weekday} ${short} ${time}`;
}

/** Começo e fim do dia de `now` no fuso. */
export function dayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0) % 24;
  const elapsed = ((value("hour") * 60 + value("minute")) * 60 + value("second")) * 1000 + now.getMilliseconds();
  const start = new Date(now.getTime() - elapsed);
  return { start, end: new Date(start.getTime() + 24 * 3_600_000 - 1) };
}
