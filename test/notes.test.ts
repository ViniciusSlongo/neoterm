import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HOME, makeAgent, startNeoterm, type TestNeoterm } from "./harness.ts";

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
  await makeAgent("anotado", {});
});
after(() => t.close());

describe("notas de um agente", () => {
  const file = () => join(HOME, "agents", "anotado", "notas.txt");

  it("começam vazias, num notas.txt na pasta do agente", async () => {
    const { status, body } = await t.api<{ text: string; path: string }>("/agents/anotado/notes");
    assert.equal(status, 200);
    assert.equal(body.text, "");
    assert.equal(body.path, file());
  });

  it("gravam o texto como está, com quebras de linha e vazio", async () => {
    const text = "  primeira linha\nsegunda 🙂\n\n";
    assert.equal((await t.api("/agents/anotado/notes", { method: "PUT", body: { text } })).status, 200);
    assert.equal(readFileSync(file(), "utf8"), text);
    assert.equal((await t.api<{ text: string }>("/agents/anotado/notes")).body.text, text);
    await t.api("/agents/anotado/notes", { method: "PUT", body: { text: "" } });
    assert.equal(readFileSync(file(), "utf8"), "");
  });

  it("não existem para um agente que não existe", async () => {
    assert.equal((await t.api("/agents/ninguem/notes")).status, 404);
    assert.equal((await t.api("/agents/ninguem/notes", { method: "PUT", body: { text: "x" } })).status, 404);
    assert.equal((await t.api("/agents/..%2Fetc/notes", { method: "PUT", body: { text: "x" } })).status, 404);
  });

  it("recusam o que não é texto", async () => {
    assert.equal((await t.api("/agents/anotado/notes", { method: "PUT", body: { text: 3 } })).status, 400);
  });
});
