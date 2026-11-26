import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HOME, makeAgent, makeFolder, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
  for (const slug of ["ana", "bia", "caio"]) await makeAgent(slug, {});
});
after(() => t.close());

type Definition = { folder: string; objective: string; members: string[] };
const definition = async (slug: string) => (await t.api<Definition>(`/groups/${slug}/definition`)).body;

describe("editar e excluir grupos e agentes", () => {
  it("muda membros (o primeiro coordena), objetivo e pasta de um grupo", async () => {
    const folder = makeFolder("proj-a");
    await t.api("/groups", { body: { slug: "time", folder, members: ["ana", "bia"] } });
    assert.deepEqual((await definition("time")).members, ["ana", "bia"]);

    const outra = makeFolder("proj-b");
    const { status } = await t.api("/groups/time", { method: "PATCH", body: { members: ["caio", "ana"], objective: "  Fechar o mês  ", folder: outra } });
    assert.equal(status, 200);
    const after = await definition("time");
    assert.deepEqual(after.members, ["caio", "ana"]);
    assert.equal(after.objective, "Fechar o mês");
    assert.ok(after.folder.endsWith("proj-b"));
    const state = (await t.neoterm.state()).groups.find((group) => group.slug === "time");
    assert.equal(state?.coordinator, "caio");
    assert.deepEqual(state?.members.toSorted(), ["ana", "caio"]);
  });

  it("recusa grupo sem membros e pasta que não existe", async () => {
    assert.equal((await t.api("/groups/time", { method: "PATCH", body: { members: [] } })).status, 400);
    const missing = await t.api<{ error: string }>("/groups/time", { method: "PATCH", body: { folder: "/nao/existe/mesmo" } });
    assert.equal(missing.status, 422);
    assert.match(missing.body.error, /não existe/);
  });

  it("não exclui um agente no meio de um turno; depois, manda para a lixeira", async () => {
    setScript({ bia: "!dormir 1200\nok" });
    const working = t.neoterm.chat("bia", "trabalha");
    await waitFor(() => t.neoterm.core.engine.running.includes("bia"));
    const refused = await t.api<{ error: string }>("/agents/bia", { method: "DELETE", body: { confirm: true } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /trabalhando agora/);
    await working;
    setScript({});
    const removed = await t.api<{ trash: string }>("/agents/bia", { method: "DELETE", body: { confirm: true } });
    assert.equal(removed.status, 200);
    assert.ok(existsSync(removed.body.trash));
    assert.ok(!existsSync(join(HOME, "agents", "bia")));
    assert.ok(readdirSync(join(HOME, "trash")).some((name) => name.startsWith("bia-")));
  });

  it("exclui um grupo: some da lista, os agentes continuam, e o nome fica livre", async () => {
    assert.equal((await t.api("/groups/time", { method: "DELETE", body: { confirm: true } })).status, 200);
    const state = await t.neoterm.state();
    assert.ok(!state.groups.some((group) => group.slug === "time"));
    assert.ok(state.agents.some((agent) => agent.slug === "ana"));
    assert.equal((await t.api("/groups", { body: { slug: "time", folder: makeFolder("proj-c"), members: ["ana"] } })).status, 201);
  });
});
