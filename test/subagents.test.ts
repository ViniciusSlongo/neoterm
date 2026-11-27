import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeAgent, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { injectIntoChat } = await import("../src/agents/chat.ts");
const { getRoutine } = await import("../src/routines/store.ts");

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
  await makeAgent("lider", {});
});
after(() => t.close());

type Task = { status: string; actions: number; last?: string; summary?: string; background?: boolean };
type Part = { type: string; name?: string; detail?: string; task?: Task };
type Message = { author: string; text: string; parts: Part[] };
const messagesOf = async () => (await t.api<{ messages: Message[] }>("/agents/lider/messages")).body.messages;
const agentParts = (message: Message) => message.parts.filter((part) => part.name === "Agent");

describe("subagentes", () => {
  it("as ações de um subagente não entram na resposta: contam nele, que termina quando devolve", async () => {
    setScript({ lider: "!subagente revisar testes | 3 | 10\npronto" });
    const outcome = await t.neoterm.chat("lider", "revisa");
    setScript({});
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, "pronto");
    const last = (await messagesOf()).at(-1)!;
    assert.deepEqual(
      last.parts.map((part) => part.name ?? part.type),
      ["Agent", "text"],
    );
    assert.deepEqual(last.parts[0]!.task, { status: "completed", actions: 3, last: "relatório de revisar testes" });
    assert.equal(last.text, "pronto");
  });

  it("em segundo plano: o processo segue vivo, eles rodam juntos, e a resposta de depois vira outra mensagem", async () => {
    setScript({ lider: "!subagente frente A | 3 | 150 | fundo\n!subagente frente B | 2 | 150 | fundo\nlancei as duas" });
    const turn = t.neoterm.chat("lider", "divide em duas frentes");
    // A primeira resposta sai logo, com os dois rodando, e o agente segue trabalhando.
    const first = await waitFor(async () => (await messagesOf()).find((message) => message.text === "lancei as duas"));
    assert.deepEqual(
      agentParts(first).map((part) => part.task?.status),
      ["running", "running"],
    );
    assert.ok(t.neoterm.core.engine.running.includes("lider"));
    const outcome = await turn;
    setScript({});
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, "subagentes terminaram: frente B, frente A");
    const list = await messagesOf();
    const updated = list.find((message) => message.text === "lancei as duas")!;
    assert.deepEqual(
      agentParts(updated).map((part) => [part.detail, part.task?.status, part.task?.actions, part.task?.summary]),
      [
        ["frente A", "completed", 3, "relatório de frente A"],
        ["frente B", "completed", 2, "relatório de frente B"],
      ],
    );
    // Nenhuma ação dos subagentes virou ferramenta da resposta.
    assert.ok(!updated.parts.some((part) => part.name === "Bash"));
    assert.equal(list.at(-1)!.text, "subagentes terminaram: frente B, frente A");
    assert.ok(!t.neoterm.core.engine.running.includes("lider"));
  });

  it("dá para conversar enquanto eles trabalham: a mensagem entra e é respondida", async () => {
    setScript({ lider: "!subagente frente C | 3 | 200 | fundo\nlancei C" });
    const turn = t.neoterm.chat("lider", "começa");
    await waitFor(async () => (await messagesOf()).some((message) => message.text === "lancei C"));
    assert.equal(await injectIntoChat(t.neoterm.core, "lider", "como vai?"), true);
    await turn;
    setScript({});
    assert.deepEqual(
      (await messagesOf()).slice(-4).map((message) => [message.author, message.text]),
      [
        ["agent", "lancei C"],
        ["agent", "subagentes terminaram: frente C"],
        ["person", "como vai?"],
        ["agent", "eco: como vai?"],
      ],
    );
  });

  it("uma resposta vazia (um aviso interno) não vira mensagem, e a resposta de verdade chega", async () => {
    setScript({ lider: "!vazio\nresposta de verdade" });
    const count = (await messagesOf()).length;
    const outcome = await t.neoterm.chat("lider", "oi");
    setScript({});
    assert.equal(outcome.text, "resposta de verdade");
    assert.deepEqual(
      (await messagesOf()).slice(count).map((message) => [message.author, message.text]),
      [
        ["person", "oi"],
        ["agent", "resposta de verdade"],
      ],
    );
  });

  it("se o processo cai com subagentes rodando, eles ficam parados, e não rodando para sempre", async () => {
    setScript({ lider: "!subagente frente D | 5 | 300 | fundo\n!cair\nlancei D" });
    const outcome = await t.neoterm.chat("lider", "vai");
    setScript({});
    assert.equal(outcome.ok, true);
    const message = (await messagesOf()).find((entry) => entry.text === "lancei D")!;
    assert.equal(agentParts(message)[0]?.task?.status, "stopped");
    assert.ok(!t.neoterm.core.engine.running.includes("lider"));
  });

  it("numa rotina também: espera os subagentes e guarda a resposta de depois", async () => {
    const created = await t.api<{ routine: { id: string } }>("/routines", {
      body: { agent: "lider", title: "frentes", instruction: "divide o trabalho", cron: "0 9 * * *", mode: "act" },
    });
    setScript({ lider: "!subagente frente E | 2 | 100 | fundo\nlancei E" });
    const outcome = await t.neoterm.routines.fire((await getRoutine(t.db, created.body.routine.id))!);
    setScript({});
    assert.equal(outcome?.ok, true);
    assert.equal(outcome?.text, "subagentes terminaram: frente E");
    const texts = (await messagesOf()).map((message) => message.text);
    assert.ok(texts.includes("lancei E"));
    assert.ok(texts.includes("subagentes terminaram: frente E"));
  });
});

describe("subagentes quando o motor para no meio", () => {
  it("ao ligar de novo, os subagentes das execuções interrompidas ficam como parados", async () => {
    const { closeInterruptedWork } = await import("../src/routines/scheduler.ts");
    const { messages, runs } = await import("../src/db/schema.ts");
    const { eq } = await import("drizzle-orm");
    const { ensureAgentRow, mainConversation } = await import("../src/store/conversations.ts");
    const row = await ensureAgentRow(t.db, "lider");
    const conversation = await mainConversation(t.db, row.id);
    const [run] = await t.db.insert(runs).values({ agentId: row.id, conversationId: conversation.id, trigger: "chat", status: "running" }).returning({ id: runs.id });
    const [message] = await t.db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        runId: run!.id,
        author: "agent",
        agentId: row.id,
        text: "lancei",
        parts: [{ type: "tool", id: "x", name: "Agent", detail: "frente Z", task: { status: "running", actions: 2, background: true } }],
      })
      .returning({ id: messages.id });
    await closeInterruptedWork(t.neoterm.core);
    const [saved] = await t.db.select().from(messages).where(eq(messages.id, message!.id));
    const part = saved!.parts[0];
    assert.equal(part?.type === "tool" && part.task?.status, "stopped");
    const [finished] = await t.db.select().from(runs).where(eq(runs.id, run!.id));
    assert.equal(finished!.status, "failed");
  });
});
