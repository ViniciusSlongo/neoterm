import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HOME, makeAgent, makeFolder } from "./harness.ts";

const { loadAgent, readAgentFields, updateAgent } = await import("../src/agents/identity.ts");

describe("editar um agente", () => {
  const file = () => join(HOME, "agents", "editavel", "AGENT.md");

  it("muda só o que foi pedido e preserva o que a pessoa escreveu à mão no cabeçalho", async () => {
    await makeAgent("editavel", { title: "Antes", role: "Função antiga." });
    writeFileSync(file(), readFileSync(file(), "utf8").replace("folders:", "# minha anotação\ncor: azul\nfolders:"));
    const nova = makeFolder("editavel-nova");
    const agent = await updateAgent("editavel", { title: "Depois", role: "Linha 1\n\nLinha 2", model: "claude-sonnet-5-5", folders: [nova] });
    assert.equal(agent.title, "Depois");
    assert.equal(agent.role, "Linha 1\n\nLinha 2");
    assert.equal(agent.model, "claude-sonnet-5-5");
    assert.ok(agent.folders[0]?.endsWith("editavel-nova"));
    assert.match(readFileSync(file(), "utf8"), /# minha anotação\ncor: azul/);
    // model null volta ao padrão: some do cabeçalho; o resto fica.
    await updateAgent("editavel", { model: null });
    const after = await loadAgent("editavel");
    assert.equal(after.model, undefined);
    assert.equal(after.title, "Depois");
  });

  it("recusa pasta que não existe e função vazia, sem estragar o arquivo", async () => {
    const before = readFileSync(file(), "utf8");
    await assert.rejects(updateAgent("editavel", { folders: ["/nao/existe/mesmo"] }), /não existe/);
    await assert.rejects(updateAgent("editavel", { role: "   " }), /não pode ficar vazia/);
    assert.equal(readFileSync(file(), "utf8"), before);
  });

  it("lê os campos para editar mesmo com uma pasta que sumiu, e a edição conserta", async () => {
    const some = makeFolder("vai-sumir");
    await makeAgent("quebrado", { folders: [some] });
    rmSync(some, { recursive: true });
    await assert.rejects(loadAgent("quebrado"), /não existe mais/);
    const fields = await readAgentFields("quebrado");
    assert.ok(fields.folders.some((folder) => folder.endsWith("vai-sumir")));
    assert.match(fields.role, /agente quebrado de teste/);
    await updateAgent("quebrado", { folders: [makeFolder("conserto")] });
    assert.ok((await loadAgent("quebrado")).folders[0]?.endsWith("conserto"));
  });
});
