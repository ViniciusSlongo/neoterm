import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentProblem, agentTemplate, parseAgentFile, splitFrontmatter } from "../src/agents/identity.ts";
import { renderSystemPrompt } from "../src/agents/prompt.ts";
import { scopeOf } from "../src/runner/turn.ts";

describe("AGENT.md", () => {
  it("separa cabeçalho e função", () => {
    const { header, body } = splitFrontmatter("---\nname: A\n---\nFaz coisas.\n");
    assert.equal(header, "name: A");
    assert.equal(body.trim(), "Faz coisas.");
  });

  it("lê o modelo que o neoterm escreve", () => {
    const agent = parseAgentFile(
      "analista",
      agentTemplate({ slug: "analista", name: "Analista", title: "Finanças", role: "Acompanha o caixa." }),
    );
    assert.equal(agent.name, "Analista");
    assert.equal(agent.title, "Finanças");
    assert.equal(agent.role, "Acompanha o caixa.");
    assert.ok(agent.tools.includes("Bash"));
    assert.ok(!agent.unattended.includes("Bash"));
  });

  it("nunca deixa o escopo sozinho passar do escopo com você", () => {
    const agent = parseAgentFile("a", "---\nname: A\ntools: [Read]\nunattended: [Read, Bash]\n---\nx");
    assert.deepEqual(agent.unattended, ["Read"]);
  });

  it("aceita pasta como texto ou como objeto", () => {
    const agent = parseAgentFile(
      "a",
      "---\nname: A\nfolders:\n  - /srv/dados\n  - path: /srv/saida\n    write: true\n---\nx",
    );
    assert.deepEqual(agent.folders, [
      { path: "/srv/dados", write: false },
      { path: "/srv/saida", write: true },
    ]);
  });

  it("explica o que está errado", () => {
    assert.throws(() => parseAgentFile("a", "---\ntitle: sem nome\n---\nx"), AgentProblem);
    assert.throws(() => parseAgentFile("a", "---\nname: A\n---\n"), /sem a função/);
  });
});

describe("escopo e prompt", () => {
  const agent = parseAgentFile(
    "a",
    "---\nname: Ana\ntitle: Pesquisa\ntools: [Read, Bash]\nunattended: [Read]\nfolders:\n  - /srv/dados\n---\nPesquisa coisas.",
  );

  it("sozinho usa só o escopo de rotinas e trava as pastas só de leitura", () => {
    assert.deepEqual(scopeOf(agent, "interactive").tools, ["Read", "Bash"]);
    assert.deepEqual(scopeOf(agent, "unattended").tools, ["Read"]);
    assert.deepEqual(scopeOf(agent, "unattended").disallowed, ["Edit(//srv/dados/**)"]);
  });

  it("monta identidade, função e modo", () => {
    const prompt = renderSystemPrompt(
      agent,
      { mode: "unattended", now: new Date("2026-11-25T12:00:00Z"), timeZone: "America/Sao_Paulo" },
      { memory: "Prefere respostas curtas." },
    );
    assert.match(prompt, /<identity>\nVocê é Ana, Pesquisa\./);
    assert.match(prompt, /<role>\nPesquisa coisas\./);
    assert.match(prompt, /Prefere respostas curtas\./);
    assert.match(prompt, /Ninguém está acompanhando/);
    assert.match(prompt, /\/srv\/dados \(só leitura/);
  });
});
