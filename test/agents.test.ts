import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { argOf, FAKE_STATE, fakeCalls, HOME, makeAgent, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

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

  it("roda com a identidade, o escopo com você e as ferramentas do neoterm", () => {
    const call = lastCall("Ana");
    assert.match(call.system, /<identity>\nVocê é Ana, Pesquisa\./);
    assert.match(call.system, /A pessoa está acompanhando/);
    assert.equal(argOf(call, "--tools"), "Read,Glob,Grep,Write,Edit,Bash,WebSearch,WebFetch");
    assert.ok(call.args.includes("mcp__neoterm"), "ferramentas do neoterm liberadas");
    assert.match(argOf(call, "--mcp-config") ?? "", /"Authorization":"Bearer [0-9a-f]{48}"/);
    assert.equal(argOf(call, "--resume") !== undefined, true);
    assert.ok(call.cwd.endsWith(join("agents", "ana", "workspace")));
  });

  it("guarda o que o agente fez no caminho, inclusive o que foi negado", async () => {
    const outcome = await t.neoterm.chat("ana", "!ferramenta Read dados.csv\n!negado Edit /srv/x.txt\nfeito");
    assert.equal(outcome.ok, true);
    const { body } = await t.api<{ messages: { parts: unknown[] }[] }>("/agents/ana/messages?limit=1");
    assert.deepEqual(body.messages[0]?.parts, [
      { type: "tool", name: "Read", detail: "dados.csv" },
      {
        type: "tool",
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
  it("um AGENT.md quebrado aparece como problema, sem derrubar a lista", async () => {
    await makeAgent("quebrado");
    writeFileSync(join(HOME, "agents", "quebrado", "AGENT.md"), "---\nname: [\n---\nx");
    const state = await t.neoterm.state();
    assert.ok(state.problems.some((problem) => problem.slug === "quebrado"));
    rmSync(join(HOME, "agents", "quebrado"), { recursive: true });
  });

  it("liberar um pedido de acesso edita o AGENT.md sem perder os comentários", async () => {
    await makeAgent("pede");
    await t.neoterm.chat("pede", '!mcp request_access {"tool":"Bash","reason":"rodar o script de vencimentos"}');
    const state = await t.neoterm.state();
    const item = state.attention.find((entry) => entry.kind === "access" && entry.agent === "pede");
    assert.ok(item);
    assert.match(item.text, /pede quer usar Bash: rodar o script/);
    const allowed = await t.api(`/attention/${item.id}/allow`, { body: {} });
    assert.equal(allowed.status, 200);
    const file = readFileSync(join(HOME, "agents", "pede", "AGENT.md"), "utf8");
    assert.match(file, /unattended: \[ Read, Glob, Grep, WebSearch, WebFetch, Bash \]/);
    assert.match(file, /# Escopo sozinho, em rotinas/);
    assert.equal((await t.neoterm.state()).attention.some((entry) => entry.id === item.id), false);
    // O agente fica sabendo na conversa, no próximo turno, e só uma vez.
    await t.neoterm.chat("pede", "pode rodar agora?");
    assert.match(fakeCalls().at(-1)!.prompt, /^\[Avisos do neoterm desde a sua última resposta\]\n- A pessoa liberou Bash para pede, também quando roda sozinho\.\n\npode rodar agora\?$/);
    assert.match(argOf(fakeCalls().at(-1)!, "--append-system-prompt") ?? "", /ferramentas de trabalho: .*Bash/);
    await t.neoterm.chat("pede", "e agora?");
    assert.equal(fakeCalls().at(-1)!.prompt, "e agora?");
  });
});

await waitFor(() => true);
