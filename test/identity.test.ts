import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentProblem, agentTemplate, parseAgentFile, splitFrontmatter } from "../src/agents/identity.ts";
import { renderSystemPrompt } from "../src/agents/prompt.ts";
import { extraDirs } from "../src/runner/turn.ts";

describe("AGENT.md", () => {
  it("separa cabeçalho e função", () => {
    const { header, body } = splitFrontmatter("---\nname: A\n---\nFaz coisas.\n");
    assert.equal(header, "name: A");
    assert.equal(body.trim(), "Faz coisas.");
  });

  it("lê o modelo que o neoterm escreve", () => {
    const file = agentTemplate({
      slug: "analista",
      name: "Analista",
      title: "Finanças",
      role: "Acompanha o caixa.",
      folders: ["/srv/financeiro", "/srv/extratos"],
    });
    assert.doesNotMatch(file, /tools|unattended|write/, "sem permissões no arquivo");
    const agent = parseAgentFile("analista", file);
    assert.equal(agent.name, "Analista");
    assert.equal(agent.title, "Finanças");
    assert.equal(agent.role, "Acompanha o caixa.");
    assert.deepEqual(agent.folders, ["/srv/financeiro", "/srv/extratos"]);
    assert.equal(agent.workspace, "/srv/financeiro", "roda na primeira pasta");
  });

  it("aceita pasta como texto, com ~, ou no formato antigo de objeto", () => {
    const agent = parseAgentFile(
      "a",
      "---\nname: A\ntools: [Read]\nfolders:\n  - ~/Projects/crm\n  - path: /srv/saida\n    write: false\n---\nx",
    );
    assert.deepEqual(agent.folders, [join(homedir(), "Projects", "crm"), "/srv/saida"]);
  });

  it("sem pastas, usa workspace/", () => {
    const agent = parseAgentFile("a", "---\nname: A\n---\nx");
    assert.deepEqual(agent.folders, []);
    assert.ok(agent.workspace.endsWith(join("agents", "a", "workspace")));
  });

  it("explica o que está errado", () => {
    assert.throws(() => parseAgentFile("a", "---\ntitle: sem nome\n---\nx"), AgentProblem);
    assert.throws(() => parseAgentFile("a", "---\nname: A\n---\n"), /sem a função/);
  });
});

describe("pastas e prompt", () => {
  const agent = parseAgentFile("dev", "---\nname: Dev\ntitle: CRM\nfolders:\n  - /srv/crm\n  - /srv/docs\n---\nProgramador do CRM.");

  it("roda na primeira pasta; as outras entram com --add-dir, e num grupo vão todas", () => {
    assert.deepEqual(extraDirs(agent), ["/srv/docs"]);
    assert.deepEqual(extraDirs(agent, "/srv/projeto"), ["/srv/crm", "/srv/docs"]);
  });

  it("monta identidade, função, pastas e modo", () => {
    const prompt = renderSystemPrompt(
      agent,
      { mode: "unattended", now: new Date("2026-11-25T12:00:00Z"), timeZone: "America/Sao_Paulo" },
      { memory: "Prefere respostas curtas." },
    );
    assert.match(prompt, /<identity>\nVocê é Dev, CRM\./);
    assert.match(prompt, /<role>\nProgramador do CRM\./);
    assert.match(prompt, /Prefere respostas curtas\./);
    assert.match(prompt, /<workspace>\nSeu escopo são estas pastas do computador\. Trabalhe só dentro delas:\n- \/srv\/crm\n- \/srv\/docs/);
    assert.match(prompt, /Ninguém está acompanhando/);
    assert.doesNotMatch(prompt, /request_access|ferramentas de trabalho:/);
  });
});
