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

describe("esforço do agente", async () => {
  const { claudeArgs } = await import("../src/runner/claude.ts");
  const { parseEffortCommand } = await import("../src/tui/commands.ts");
  const base = { prompt: "", cwd: "/x", model: "claude-opus-5-5", systemPrompt: "", addDirs: [], sessionId: "s", resume: false };

  it("vai para o claude como --effort, e sem ele quando não escolhido", () => {
    const args = claudeArgs({ ...base, effort: "high" });
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert.ok(!claudeArgs(base).includes("--effort"));
  });

  it("fica no AGENT.md, muda e volta ao padrão; valor inválido é recusado", async () => {
    await makeAgent("pensador", {});
    assert.equal((await loadAgent("pensador")).effort, undefined);
    await updateAgent("pensador", { effort: "xhigh" });
    assert.equal((await loadAgent("pensador")).effort, "xhigh");
    assert.equal((await readAgentFields("pensador")).effort, "xhigh");
    await updateAgent("pensador", { effort: null });
    assert.equal((await loadAgent("pensador")).effort, undefined);
    const file = join(HOME, "agents", "pensador", "AGENT.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("folders:", "effort: enorme\nfolders:"));
    await assert.rejects(loadAgent("pensador"), /effort precisa ser um destes/);
  });

  it(":effort entende os níveis do Claude Code e default", () => {
    assert.deepEqual(parseEffortCommand(":effort"), { level: null });
    assert.deepEqual(parseEffortCommand(":effort high"), { level: "high" });
    assert.deepEqual(parseEffortCommand("/effort XHIGH"), { level: "xhigh" });
    assert.deepEqual(parseEffortCommand(":effort max"), { level: "max" });
    assert.deepEqual(parseEffortCommand(":effort default"), { level: "" });
    assert.deepEqual(parseEffortCommand(":effort alto"), { level: "?" });
    assert.equal(parseEffortCommand("effort high"), null);
    assert.equal(parseEffortCommand(":esforço alto"), null);
  });
});
