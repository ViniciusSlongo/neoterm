import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Dashboard } from "../src/dashboard.ts";
import { ago, bar, bytes, duration, sparkline } from "../src/tui/format.ts";
import { HOME, makeAgent, startNeoterm, type TestNeoterm } from "./harness.ts";

// Só depois do harness: ele aponta NEOTERM_HOME, o banco e o `claude` para a pasta de teste, e
// quem importa src/config.ts antes disso pega os caminhos reais de ~/.neoterm.
const { httpApi } = await import("../src/tui/api.ts");

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
  await makeAgent("ana", {});
  await makeAgent("bia", {});
});
after(() => t.close());

describe("painel", () => {
  it("resume o motor, a máquina, o trabalho de hoje e cada agente", async () => {
    await t.neoterm.chat("ana", "oi");
    await t.neoterm.chat("ana", "tudo bem?");
    await t.neoterm.chat("bia", "!falhar quebrou");
    writeFileSync(join(HOME, "agents", "ana", "MEMORY.md"), "- gosta de pix\n- fecha dia 30\n\n");
    await t.api("/agents/ana/notes", { method: "PUT", body: { text: "lembrar do contrato" } });

    const { status, body } = await t.api<Dashboard>("/dashboard");
    assert.equal(status, 200);
    assert.equal(body.engine.pid, process.pid);
    assert.ok(body.engine.rssBytes > 0 && body.engine.uptimeMs >= 0);
    assert.ok(body.machine.totalMemBytes > 0 && body.machine.usedMemBytes > 0);
    assert.ok(body.machine.usedMemBytes <= body.machine.totalMemBytes);

    assert.equal(body.today.turns, 3);
    assert.equal(body.today.succeeded, 2);
    assert.equal(body.today.failed, 1);
    assert.equal(body.today.byTrigger.chat, 3);
    assert.equal(body.today.fromPerson, 3);
    assert.equal(body.week.length, 7);
    assert.equal(body.week.at(-1)!.turns, 3);
    assert.equal(body.week.at(-1)!.failed, 1);

    const ana = body.agents.find((agent) => agent.slug === "ana")!;
    assert.equal(ana.turnsToday, 2);
    assert.equal(ana.failedToday, 0);
    assert.equal(ana.memoryLines, 2);
    assert.equal(ana.memoryBytes, Buffer.byteLength("- gosta de pix\n- fecha dia 30\n\n"));
    assert.equal(ana.notesBytes, "lembrar do contrato".length);
    assert.ok(ana.lastActivityAt);
    const bia = body.agents.find((agent) => agent.slug === "bia")!;
    assert.equal(bia.failedToday, 1);
    assert.equal(bia.notesBytes, 0);

    assert.ok(body.storage.databaseBytes > 0);
    assert.equal(body.storage.messages, body.today.messages);
    assert.equal(body.attention, 0);
    assert.equal(body.followups.pending, 0);
  });
});

describe("formatos do painel", () => {
  it("tamanhos, durações e há quanto tempo", () => {
    assert.equal(bytes(512), "512 B");
    assert.equal(bytes(1536), "1,5 KB");
    assert.equal(bytes(13 * 1024 ** 3), "13 GB");
    assert.equal(duration(42_000), "42 s");
    assert.equal(duration(95_000), "1 min 35 s");
    assert.equal(duration(7_380_000), "2 h 3 min");
    assert.equal(duration(90_000_000), "1 d 1 h");
    const now = new Date("2026-11-25T12:00:00Z");
    assert.equal(ago(null, now), "nunca");
    assert.equal(ago("2026-11-25T11:59:30Z", now), "agora");
    assert.equal(ago("2026-11-25T11:55:00Z", now), "há 5 min");
    assert.equal(ago("2026-11-23T12:00:00Z", now), "há 2 d");
  });

  it("barras e o gráfico de uma linha", () => {
    assert.deepEqual(bar(0.5, 10), { filled: "█████", empty: "░░░░░" });
    assert.deepEqual(bar(2, 4), { filled: "████", empty: "" });
    assert.deepEqual(bar(Number.NaN, 2), { filled: "", empty: "░░" });
    assert.equal(sparkline([0, 0, 0]), "▁▁▁");
    assert.equal(sparkline([0, 4, 8]), "▁▅█");
  });
});

describe("interface com um motor de versão anterior", () => {
  it("uma rota que o motor não conhece vira um aviso para reiniciá-lo, não um erro de JSON", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/dashboard" ? 404 : 500, { "content-type": "text/plain" });
      response.end(request.url === "/dashboard" ? "404 Not Found" : "falhou");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const api = httpApi(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      await assert.rejects(api.dashboard(), /o motor está desatualizado: rode neoterm service restart/);
      await assert.rejects(api.notes("x"), /o motor respondeu 500: falhou/);
    } finally {
      server.close();
    }
  });
});
