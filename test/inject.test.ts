import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeAgent, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { injectIntoChat } = await import("../src/agents/chat.ts");
const { TurnInput } = await import("../src/runner/claude.ts");

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
  await makeAgent("ana", {});
});
after(() => t.close());

type Message = { author: string; text: string; parts: { type: string; name?: string }[] };
const messagesOf = async () => (await t.api<{ messages: Message[] }>("/agents/ana/messages")).body.messages;

describe("mensagem no meio da resposta", () => {
  it("sem resposta em andamento, não entra (vai pela fila normal)", async () => {
    assert.equal(await injectIntoChat(t.neoterm.core, "ana", "oi?"), false);
  });

  it("entra no turno em andamento: o que ele já fez fica antes, a mensagem no meio, a resposta a considera", async () => {
    setScript({ ana: "!ferramenta Read planilha.csv\n!dormir 800\nanalisei" });
    const turn = t.neoterm.chat("ana", "analisa a planilha");
    await waitFor(() => t.neoterm.core.engine.running.includes("ana"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await injectIntoChat(t.neoterm.core, "ana", "foca em novembro"), true);
    const outcome = await turn;
    setScript({});
    assert.equal(outcome.ok, true);
    assert.match(outcome.text, /analisei\nconsiderei: foca em novembro/);
    const list = (await messagesOf()).map((message) => [message.author, message.text, message.parts.map((part) => part.name ?? part.type).join(",")]);
    assert.deepEqual(list, [
      ["person", "analisa a planilha", ""],
      ["agent", "", "Read"],
      ["person", "foca em novembro", ""],
      ["agent", "analisei\nconsiderei: foca em novembro", "text"],
    ]);
  });

  it("pela API, com inject: entra se ele estiver respondendo; senão, vira um turno normal", async () => {
    setScript({ ana: "!dormir 600\nok" });
    const turn = t.neoterm.chat("ana", "espera um pouco");
    await waitFor(() => t.neoterm.core.engine.running.includes("ana"));
    const injected = await t.api<{ injected?: boolean }>("/agents/ana/messages", { body: { text: "e isso também", inject: true } });
    assert.equal(injected.status, 202);
    assert.equal(injected.body.injected, true);
    const outcome = await turn;
    assert.match(outcome.text, /considerei: e isso também/);
    setScript({});
  });

  it("não entra num turno que não é a conversa com você (uma consulta de outro agente, por exemplo)", async () => {
    await makeAgent("bia", {});
    setScript({ ana: '!mcp ask_agent {"agent":"bia","question":"pode olhar?"}', bia: "!dormir 800\nolhei" });
    const turn = t.neoterm.chat("ana", "pergunta pra bia");
    await waitFor(() => t.neoterm.core.engine.running.includes("bia"));
    assert.equal(await injectIntoChat(t.neoterm.core, "bia", "e mais isso"), false);
    await turn;
    setScript({});
  });

  it("a entrada fechada não aceita mais nada e devolve o que não foi lido", () => {
    const input = new TurnInput();
    assert.equal(input.send("a"), true);
    assert.deepEqual(input.close(), ["a"]);
    assert.equal(input.send("b"), false);
  });
});
