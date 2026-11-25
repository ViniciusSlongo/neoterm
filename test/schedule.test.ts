import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dayBounds,
  describeCron,
  describeWhen,
  nextOccurrence,
  occurrencesBetween,
  ScheduleRefused,
  validateSchedule,
} from "../src/routines/schedule.ts";

const SP = "America/Sao_Paulo";

describe("horário das rotinas", () => {
  it("calcula a próxima vez no fuso", () => {
    // 25/11/2026 é quarta; 12:00 UTC = 09:00 em São Paulo.
    const next = nextOccurrence("0 9 * * 1-5", SP, new Date("2026-11-25T12:00:00Z"));
    assert.equal(next.toISOString(), "2026-11-26T12:00:00.000Z");
    const friday = nextOccurrence("0 17 * * 5", SP, new Date("2026-11-25T12:00:00Z"));
    assert.equal(friday.toISOString(), "2026-11-27T20:00:00.000Z");
  });

  it("recusa mais de uma vez a cada 15 minutos", () => {
    assert.throws(() => validateSchedule("* * * * *", SP), ScheduleRefused);
    assert.throws(() => validateSchedule("*/5 9 * * *", SP), /15 minutos/);
    assert.throws(() => validateSchedule("0,10 * * * *", SP), /15 minutos/);
    assert.doesNotThrow(() => validateSchedule("*/15 * * * *", SP));
    assert.doesNotThrow(() => validateSchedule("0 9 * * 1-5", SP));
  });

  it("recusa horário inválido e fuso desconhecido", () => {
    assert.throws(() => validateSchedule("0 9 * *", SP), /5 campos/);
    assert.throws(() => validateSchedule("0 25 * * *", SP), ScheduleRefused);
    assert.throws(() => validateSchedule("0 9 * * *", "Marte/Olympus"), /fuso/);
  });

  it("descreve em palavras", () => {
    assert.equal(describeCron("0 9 * * 1-5"), "seg–sex 09:00");
    assert.equal(describeCron("0 18 * * *"), "todo dia 18:00");
    assert.equal(describeCron("0 17 * * 5"), "sex 17:00");
    assert.equal(describeCron("0 8 1 * *"), "dia 1 · 08:00");
    assert.equal(describeCron("*/30 * * * *"), "a cada 30 min");
    assert.equal(describeCron("0 */2 * * *"), "a cada 2 h");
  });

  it("diz quando de um jeito curto", () => {
    const now = new Date("2026-11-25T14:00:00Z");
    assert.equal(describeWhen(new Date("2026-11-25T12:00:00Z"), SP, now), "hoje 09:00");
    assert.equal(describeWhen(new Date("2026-11-26T12:00:00Z"), SP, now), "amanhã 09:00");
    assert.match(describeWhen(new Date("2026-11-27T20:00:00Z"), SP, now), /^sex 27\/11 17:00$/);
  });

  it("lista as vezes de hoje", () => {
    const now = new Date("2026-11-25T14:00:00Z");
    const { start, end } = dayBounds(now, SP);
    assert.equal(start.toISOString(), "2026-11-25T03:00:00.000Z");
    const today = occurrencesBetween("0 9,14,18 * * *", SP, start, end);
    assert.deepEqual(
      today.map((date) => date.toISOString()),
      ["2026-11-25T12:00:00.000Z", "2026-11-25T17:00:00.000Z", "2026-11-25T21:00:00.000Z"],
    );
  });
});
