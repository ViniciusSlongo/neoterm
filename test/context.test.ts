import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { argOf, fakeCalls, makeAgent, setScript, startNeoterm, type TestNeoterm } from "./harness.ts";

const { contextUsage } = await import("../src/runner/claude.ts");

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
  await makeAgent("longo", {});
});
after(() => t.close());

type Message = { author: string; text: string; meta: { context?: { used: number; window: number }; notice?: string } };
const messagesOf = async () => (await t.api<{ messages: Message[] }>("/agents/longo/messages")).body.messages;

describe("contexto da sessão", () => {
  it("lê o contexto da última chamada ao modelo e a janela", () => {
    const usage = contextUsage({
      usage: {
        input_tokens: 999,
        iterations: [
          { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 },
          { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 8 },
        ],
      },
      modelUsage: { "claude-opus-5-5": { contextWindow: 200000 } },
    });
    assert.deepEqual(usage, { used: 130, window: 200000 });
    assert.equal(contextUsage({ usage: {} }), undefined);
  });

  it("todo turno roda com --autocompact auto e guarda o contexto na resposta", async () => {
    await t.neoterm.chat("longo", "oi");
    await t.neoterm.chat("longo", "de novo");
    const call = fakeCalls().filter((entry) => entry.agent === "longo").at(-1)!;
    assert.equal(argOf(call, "--autocompact"), "auto");
    const replies = (await messagesOf()).filter((message) => message.author === "agent");
    assert.deepEqual(replies.map((message) => message.meta.context?.window), [200000, 200000]);
    assert.ok(replies[1]!.meta.context!.used > replies[0]!.meta.context!.used);
  });

  it("quando o Claude Code compacta, a conversa ganha um aviso antes da resposta", async () => {
    setScript({ longo: "!compactar\nsegui" });
    await t.neoterm.chat("longo", "continua");
    setScript({});
    const list = await messagesOf();
    const notice = list.findIndex((message) => message.meta.notice === "compacted");
    assert.ok(notice >= 0);
    assert.match(list[notice]!.text, /longo compactou o contexto/);
    assert.equal(list[notice + 1]?.text, "segui");
  });
});
