import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fakeCalls, makeAgent, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm({ askTimeoutMs: 2500 });
  for (const slug of ["ana", "bia", "caio", "duda"]) await makeAgent(slug, { title: `Função de ${slug}` });
});
after(() => t.close());

const ask = (agent: string, question: string) => `!mcp ask_agent ${JSON.stringify({ agent, question })}`;
type Message = { author: string; text: string; meta: { fromAgent?: string } };
const messagesOf = async (slug: string) => (await t.api<{ messages: Message[] }>(`/agents/${slug}/messages`)).body.messages;
const lastCall = (agent: string) => fakeCalls().filter((call) => call.agent === agent).at(-1)!;

describe("um agente consulta outro (ask_agent)", () => {
  it("a resposta volta para quem perguntou, e a troca fica na conversa do consultado", async () => {
    setScript({ bia: "O saldo de novembro é R$ 42.000." });
    const outcome = await t.neoterm.chat("ana", ask("bia", "Qual o saldo de novembro?"));
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /\[ask_agent\] bia respondeu:\n\nO saldo de novembro é R\$ 42\.000\./);

    const bia = await messagesOf("bia");
    assert.deepEqual(
      bia.map((message) => [message.author, message.text, message.meta.fromAgent ?? null]),
      [
        ["agent", "Qual o saldo de novembro?", "ana"],
        ["agent", "O saldo de novembro é R$ 42.000.", null],
      ],
    );
    // bia respondeu sabendo quem perguntou, sem poder consultar outros (o ask_agent não aparece para ela).
    const biaCall = lastCall("bia");
    assert.match(biaCall.prompt, /ana, outro agente do neoterm, te consulta/);
    assert.doesNotMatch(biaCall.system, /ask_agent/);
    // ana sabe quem pode consultar.
    assert.match(lastCall("ana").system, /ask_agent: .*bia \(Função de bia\)/);
    assert.doesNotMatch(lastCall("ana").system, /ask_agent: .*ana \(/);
    // O turno de bia ficou registrado como consulta.
    const { body } = await t.api<{ runs: { trigger: string; status: string }[] }>("/agents/bia/runs");
    assert.equal(body.runs[0]?.trigger, "agent");
    assert.equal(body.runs[0]?.status, "succeeded");
    setScript({});
  });

  it("não consulta a si mesmo nem quem não existe", async () => {
    const self = await t.neoterm.chat("ana", ask("ana", "oi?"));
    assert.match(self.text, /Não deu: você não pode consultar a si mesmo/);
    const nobody = await t.neoterm.chat("ana", ask("zeca", "oi?"));
    assert.match(nobody.text, /não existe agente "zeca"\. Os que existem: bia, caio, duda/);
  });

  it("quem responde uma consulta não consulta mais ninguém (sem cadeia)", async () => {
    const before = fakeCalls().filter((call) => call.agent === "caio").length;
    setScript({ bia: ask("caio", "e você, sabe?") });
    const outcome = await t.neoterm.chat("ana", ask("bia", "Pergunta pro caio pra mim?"));
    assert.match(outcome.text, /bia respondeu:[\s\S]*não pode consultar mais ninguém/);
    assert.equal(fakeCalls().filter((call) => call.agent === "caio").length, before);
    setScript({});
  });

  it("recusa na hora quem está pausado ou ocupado, sem travar esperando", async () => {
    await t.api("/agents/caio/pause", { body: {} });
    const paused = await t.neoterm.chat("ana", ask("caio", "tudo certo?"));
    assert.match(paused.text, /caio está pausado/);
    await t.api("/agents/caio/resume", { body: {} });

    setScript({ duda: "!dormir 1500\nterminei" });
    const busy = t.neoterm.chat("duda", "trabalha um pouco");
    await waitFor(() => t.neoterm.core.engine.running.includes("duda"));
    const started = Date.now();
    const refused = await t.neoterm.chat("ana", ask("duda", "pode ver uma coisa?"));
    assert.match(refused.text, /duda está ocupado agora/);
    assert.ok(Date.now() - started < 1500, "recusou sem esperar o turno do outro");
    await busy;
    setScript({});
  });

  it("passado o tempo máximo, quem perguntou segue e a resposta fica na conversa do outro", async () => {
    setScript({ caio: "!dormir 4000\nresposta demorada" });
    const outcome = await t.neoterm.chat("ana", ask("caio", "isso demora?"));
    assert.match(outcome.text, /Sem resposta: caio ainda está trabalhando na resposta/);
    await waitFor(async () => (await messagesOf("caio")).some((message) => message.text === "resposta demorada"), 10_000);
    setScript({});
  });
});
