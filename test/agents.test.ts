import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { argOf, FAKE_STATE, fakeCalls, HOME, makeAgent, makeFolder, ROOT, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
});
after(() => t.close());

const lastCall = (agent: string) => fakeCalls().filter((call) => call.agent === agent).at(-1)!;

describe("conversa com um agente", () => {
  it("responde, guarda a conversa e continua a mesma sessão", async () => {
    await makeAgent("ana", { name: "Ana", title: "Pesquisa" });
    const first = await t.neoterm.chat("ana", "oi, tudo bem?");
    assert.equal(first.ok, true);
    assert.equal(first.text, "eco: oi, tudo bem?");
    const second = await t.neoterm.chat("ana", "!sessao");
    assert.equal(second.text, "sessão com 2 mensagens");

    const { body } = await t.api<{ messages: { author: string; text: string }[] }>("/agents/ana/messages");
    assert.deepEqual(
      body.messages.map((message) => [message.author, message.text]),
      [
        ["person", "oi, tudo bem?"],
        ["agent", "eco: oi, tudo bem?"],
        ["person", "!sessao"],
        ["agent", "sessão com 2 mensagens"],
      ],
    );
  });

  it("roda com a identidade, sem pedir permissão e com as ferramentas do neoterm", () => {
    const call = lastCall("Ana");
    assert.match(call.system, /<identity>\nVocê é Ana, Pesquisa\./);
    assert.match(call.system, /A pessoa está acompanhando/);
    assert.ok(call.args.includes("--dangerously-skip-permissions"));
    assert.ok(!call.args.includes("--tools"), "todas as ferramentas");
    assert.match(argOf(call, "--mcp-config") ?? "", /"Authorization":"Bearer [0-9a-f]{48}"/);
    assert.equal(argOf(call, "--resume") !== undefined, true);
    assert.equal(call.cwd, realpathSync(join(ROOT, "repos", "ana")), "roda na pasta dele");
  });

  it("guarda o que o agente fez no caminho, inclusive o que foi negado", async () => {
    const outcome = await t.neoterm.chat("ana", "!ferramenta Read dados.csv\n!negado Edit /srv/x.txt\nfeito");
    assert.equal(outcome.ok, true);
    const { body } = await t.api<{ messages: { parts: unknown[] }[] }>("/agents/ana/messages?limit=1");
    assert.deepEqual(body.messages[0]?.parts, [
      { type: "tool", id: "toolu_1", name: "Read", detail: "dados.csv" },
      {
        type: "tool",
        id: "toolu_2",
        name: "Edit",
        detail: "/srv/x.txt",
        error: "File is in a directory that is denied by your permission settings.",
      },
      { type: "text", text: "eco: feito" },
    ]);
  });

  it("começa outra sessão quando a guardada sumiu do Claude Code", async () => {
    rmSync(join(FAKE_STATE, "sessions"), { recursive: true, force: true });
    const outcome = await t.neoterm.chat("ana", "!sessao");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, "sessão com 1 mensagens");
  });

  it("registra a falha do claude como execução que falhou", async () => {
    const outcome = await t.neoterm.chat("ana", "!falhar o claude caiu");
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /o claude caiu/);
    const { body } = await t.api<{ runs: { status: string; error: string }[] }>("/agents/ana/runs?limit=1");
    assert.equal(body.runs[0]?.status, "failed");
  });

  it("transmite o turno por SSE e avisa pelo /events", async () => {
    const seen: string[] = [];
    const controller = new AbortController();
    const events = fetch(`${t.base}/events`, { signal: controller.signal }).then(async (response) => {
      const decoder = new TextDecoder();
      for await (const chunk of response.body!) {
        const text = decoder.decode(chunk);
        for (const match of text.matchAll(/event: (\w+)/g)) seen.push(match[1]!);
        if (seen.includes("turn") && seen.includes("changed")) break;
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const response = await fetch(`${t.base}/agents/ana/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "pelo http" }),
    });
    const stream = await response.text();
    assert.match(stream, /event: start/);
    assert.match(stream, /event: text\ndata: \{"type":"text","text":"eco: pelo http"\}/);
    assert.match(stream, /event: done/);
    await events;
    controller.abort();
    assert.ok(seen.includes("turn"));
  });

  it("recusa agente que não existe com 404", async () => {
    const { status, body } = await t.api("/agents/ninguem/messages", { body: { text: "oi" } });
    assert.equal(status, 404);
    assert.match(String(body.error), /não existe agente/);
  });

  it("um agente faz um turno por vez", async () => {
    await makeAgent("lento");
    const started = Date.now();
    const [a, b] = await Promise.all([t.neoterm.chat("lento", "!dormir 300\num"), t.neoterm.chat("lento", "!dormir 300\ndois")]);
    assert.ok(a.ok && b.ok);
    assert.ok(Date.now() - started >= 600, "o segundo esperou o primeiro");
  });
});

describe("pastas do escopo", () => {
  it("criar exige pelo menos uma pasta, e ela tem que existir", async () => {
    const missing = await t.api("/agents", { body: { slug: "sempasta", role: "x" } });
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /escolha pelo menos uma pasta/);
    const empty = await t.api("/agents", { body: { slug: "vazio", role: "x", folders: [] } });
    assert.equal(empty.status, 422);
    assert.match(String(empty.body.error), /escolha pelo menos uma pasta/);
    const ghost = await t.api("/agents", { body: { slug: "fantasma", role: "x", folders: [join(ROOT, "nao-existe")] } });
    assert.equal(ghost.status, 422);
    assert.match(String(ghost.body.error), /não existe/);
    const relative = await t.api("/agents", { body: { slug: "relativo", role: "x", folders: ["pastas/x"] } });
    assert.equal(relative.status, 422);
    assert.match(String(relative.body.error), /caminho completo/);
    assert.ok(!existsSync(join(HOME, "agents", "fantasma")), "recusado não deixa pasta para trás");
  });

  it("cria com as pastas, grava no AGENT.md e roda na primeira", async () => {
    const crm = makeFolder("crm");
    const docs = makeFolder("docs");
    const created = await t.api<{ agent: { workspace: string } }>("/agents", {
      body: { slug: "dev", role: "Programa o CRM.", folders: [crm, docs] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.agent.workspace, realpathSync(crm));
    const file = readFileSync(join(HOME, "agents", "dev", "AGENT.md"), "utf8");
    assert.match(file, new RegExp(`folders:\\n  - "${realpathSync(crm)}"\\n  - "${realpathSync(docs)}"\\n---`));
    assert.ok(!existsSync(join(HOME, "agents", "dev", "workspace")), "sem workspace/ quando tem pastas");
    await t.neoterm.chat("dev", "oi");
    const call = lastCall("dev");
    assert.equal(call.cwd, realpathSync(crm));
    assert.equal(argOf(call, "--add-dir"), realpathSync(docs));
    const state = await t.neoterm.state();
    assert.deepEqual(state.agents.find((agent) => agent.slug === "dev")?.folders, [realpathSync(crm), realpathSync(docs)]);
  });

  it("se uma pasta sumir, o agente vira um problema, sem derrubar os outros", async () => {
    const folder = makeFolder("temporaria");
    await makeAgent("efemero", { folders: [folder] });
    rmSync(folder, { recursive: true });
    const state = await t.neoterm.state();
    assert.match(state.problems.find((problem) => problem.slug === "efemero")?.error ?? "", /não existe mais/);
    assert.ok(state.agents.some((agent) => agent.slug === "ana"));
    mkdirSync(folder);
  });

  it("num grupo, roda na pasta do projeto e leva as pastas dele junto", async () => {
    await makeAgent("front", { folders: [makeFolder("web")] });
    const folder = makeFolder("projeto-grupo");
    const created = await t.api("/groups", { body: { slug: "lancamento", folder, members: ["front"] } });
    assert.equal(created.status, 201);
    await t.api("/groups/lancamento/messages", { body: { text: "começa" } });
    await waitFor(() => fakeCalls().some((call) => call.agent === "front"));
    const call = lastCall("front");
    assert.equal(call.cwd, realpathSync(folder));
    assert.equal(argOf(call, "--add-dir"), realpathSync(join(ROOT, "repos", "web")));
  });

  it("excluir o agente não mexe nas pastas dele", async () => {
    const folder = makeFolder("intocavel");
    writeFileSync(join(folder, "codigo.ts"), "export {}");
    await makeAgent("passageiro", { folders: [folder] });
    await t.api("/agents/passageiro", { method: "DELETE", body: { confirm: true } });
    assert.ok(existsSync(join(folder, "codigo.ts")));
  });

  it("um grupo não aceita pasta relativa: o motor não sabe de onde ela é", async () => {
    const response = await t.api("/groups", { body: { slug: "relativo", folder: "algum/lugar", members: ["ana"] } });
    assert.equal(response.status, 422);
    assert.match(String(response.body.error), /caminho completo/);
  });
});

describe("ciclo de vida", () => {
  it("pausa e retoma", async () => {
    await makeAgent("pausavel");
    await t.api("/agents/pausavel/pause", { body: {} });
    let state = await t.neoterm.state();
    assert.equal(state.agents.find((agent) => agent.slug === "pausavel")?.state, "paused");
    // A conversa com a pessoa continua mesmo pausado.
    assert.equal((await t.neoterm.chat("pausavel", "oi")).ok, true);
    await t.api("/agents/pausavel/resume", { body: {} });
    state = await t.neoterm.state();
    assert.equal(state.agents.find((agent) => agent.slug === "pausavel")?.state, "idle");
  });

  it("recomeçar mostra o plano e só apaga com confirmação", async () => {
    await makeAgent("zerar");
    await t.neoterm.chat("zerar", "primeira");
    await t.neoterm.chat("zerar", '!mcp remember {"fact":"gosta de café"}');
    await t.api("/routines", { body: { agent: "zerar", title: "diaria", instruction: "faça", cron: "0 9 * * *" } });
    const plan = await t.api<{ plan: Record<string, unknown> }>("/agents/zerar/reset");
    assert.deepEqual(plan.body.plan, { conversations: 1, messages: 4, routines: 1, followups: 0, groupSessions: 0, memory: true });
    assert.equal((await t.api("/agents/zerar/reset", { body: {} })).status, 400);
    const done = await t.api("/agents/zerar/reset", { body: { confirm: true } });
    assert.equal(done.status, 200);
    const again = await t.api<{ plan: Record<string, unknown> }>("/agents/zerar/reset");
    assert.deepEqual(again.body.plan, { conversations: 0, messages: 0, routines: 0, followups: 0, groupSessions: 0, memory: false });
    assert.ok(existsSync(join(HOME, "agents", "zerar", "AGENT.md")), "a identidade fica");
  });

  it("excluir manda para a lixeira e libera o nome", async () => {
    await makeAgent("sair");
    await t.neoterm.chat("sair", "oi");
    const removed = await t.api<{ trash: string }>("/agents/sair", { method: "DELETE", body: { confirm: true } });
    assert.equal(removed.status, 200);
    assert.ok(existsSync(join(removed.body.trash, "AGENT.md")));
    assert.ok(!existsSync(join(HOME, "agents", "sair")));
    assert.ok(readdirSync(join(HOME, "trash")).some((name) => name.startsWith("sair-")));
    await makeAgent("sair");
    const { body } = await t.api<{ messages: unknown[] }>("/agents/sair/messages");
    assert.equal(body.messages.length, 0, "o novo agente começa do zero");
  });
});

describe("AGENT.md", () => {
  it("lê o AGENT.md do jeito antigo, com ferramentas e pastas em objeto", async () => {
    await makeAgent("antigo");
    const folder = makeFolder("antigo-dados");
    writeFileSync(
      join(HOME, "agents", "antigo", "AGENT.md"),
      `---\nname: Antigo\ntools: [Read]\nunattended: [Read]\nfolders:\n  - path: ${folder}\n    write: false\n---\nFaz coisas.`,
    );
    const { body } = await t.api<{ agent: { folders: string[] } }>("/agents/antigo");
    assert.deepEqual(body.agent.folders, [realpathSync(folder)]);
  });

  it("um AGENT.md quebrado aparece como problema, sem derrubar a lista", async () => {
    await makeAgent("quebrado");
    writeFileSync(join(HOME, "agents", "quebrado", "AGENT.md"), "---\nname: [\n---\nx");
    const state = await t.neoterm.state();
    assert.ok(state.problems.some((problem) => problem.slug === "quebrado"));
    rmSync(join(HOME, "agents", "quebrado"), { recursive: true });
  });
});

await waitFor(() => true);
