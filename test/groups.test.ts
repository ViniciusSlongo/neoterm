import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { argOf, fakeCalls, makeAgent, ROOT, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { findMentions } = await import("../src/groups/mentions.ts");
const { MAX_HOPS } = await import("../src/groups/engine.ts");
const { routines } = await import("../src/db/schema.ts");

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
});
after(() => t.close());

type GroupMessage = { author: string; agent: string | null; text: string; meta: { mentions?: string[]; asksPerson?: boolean; notice?: string } };

async function transcript(group: string): Promise<GroupMessage[]> {
  const { body } = await t.api<{ messages: GroupMessage[] }>(`/groups/${group}/messages?limit=200`);
  return body.messages;
}

async function settle(group: string) {
  await waitFor(async () => {
    const state = await t.neoterm.state();
    return !state.groups.find((entry) => entry.slug === group)?.busy;
  }, 20_000);
}

describe("menções", () => {
  const members = [
    { slug: "dev", name: "Dev" },
    { slug: "revisor", name: "Revisora Ana" },
  ];

  it("acha @slug, @nome e @você, sem repetir", () => {
    assert.deepEqual(findMentions("@dev faz, @Revisora confere, @dev de novo", members), { agents: ["dev", "revisor"], person: false });
    assert.deepEqual(findMentions("@você decide", members), { agents: [], person: true });
    assert.deepEqual(findMentions("@voce, e @RevisoraAna", members), { agents: ["revisor"], person: true });
  });

  it("ignora código, e-mail e quem não está no grupo", () => {
    assert.deepEqual(findMentions("veja `@dev` e\n```\n@revisor\n```\nfale com joao@dev.com e @fulano", members), {
      agents: [],
      person: false,
    });
  });
});

describe("um grupo trabalhando", () => {
  const folder = join(ROOT, "projeto-crm");

  before(async () => {
    mkdirSync(folder, { recursive: true });
    await makeAgent("arquiteto", { name: "arquiteto", title: "Arquitetura e planejamento" });
    await makeAgent("dev", { name: "dev", title: "Implementação" });
    await makeAgent("revisor", { name: "revisor", title: "Revisão de código" });
    const created = await t.api("/groups", {
      body: { slug: "crm", folder, members: ["arquiteto", "dev", "revisor"], coordinator: "arquiteto", objective: "Evoluir o CRM" },
    });
    assert.equal(created.status, 201);
  });

  it("o coordenador responde e os agentes se chamam com @nome", async () => {
    setScript({
      arquiteto: ["Plano: filtro por status. @dev implementa e @revisor confere depois.", "Fechado, entregue."],
      dev: ["!ferramenta Edit src/clientes.ts\nImplementei o filtro. @revisor"],
      revisor: ["Revisado e aprovado. @arquiteto"],
    });
    const posted = await t.api<{ responders: string[] }>("/groups/crm/messages", { body: { text: "precisamos de filtro por status" } });
    assert.equal(posted.status, 202);
    assert.deepEqual(posted.body.responders, ["arquiteto"]);
    await settle("crm");
    const messages = await transcript("crm");
    assert.deepEqual(
      messages.map((message) => message.author === "person" ? "você" : message.agent),
      ["você", "arquiteto", "dev", "revisor", "arquiteto"],
    );
    assert.deepEqual(messages[1]?.meta.mentions, ["dev", "revisor"]);
    assert.equal(messages.at(-1)?.text, "Fechado, entregue.");
  });

  it("cada um roda na pasta do projeto, com sessão própria, e lê o que perdeu", () => {
    const calls = fakeCalls().filter((call) => ["arquiteto", "dev", "revisor"].includes(call.agent));
    for (const call of calls) {
      assert.equal(call.cwd, realpathSync(folder));
      assert.match(call.system, /<group>\nVocê está no grupo #crm/);
      assert.match(call.system, /- @arquiteto \((você, )?coordena\): Arquitetura e planejamento/);
    }
    const sessions = new Set(calls.map((call) => argOf(call, "--session-id") ?? argOf(call, "--resume")));
    assert.equal(sessions.size, 3, "uma sessão por agente no grupo");
    const devCall = calls.find((call) => call.agent === "dev")!;
    assert.match(devCall.prompt, /\[você · \d\d:\d\d\] precisamos de filtro por status/);
    assert.match(devCall.prompt, /\[arquiteto · \d\d:\d\d\] Plano: filtro/);
    assert.match(devCall.prompt, /arquiteto chamou você \(@dev\)/);
    const lastArquiteto = calls.filter((call) => call.agent === "arquiteto").at(-1)!;
    assert.doesNotMatch(lastArquiteto.prompt, /precisamos de filtro/, "não relê o que já tinha visto");
    assert.match(lastArquiteto.prompt, /\[revisor · \d\d:\d\d\] Revisado e aprovado/);
    assert.equal(argOf(devCall, "--tools"), "Read,Glob,Grep,Write,Edit,Bash,WebSearch,WebFetch", "a pessoa começou: escopo com você");
  });

  it("@nome da pessoa chama direto quem ela quer", async () => {
    setScript({ dev: "Feito por aqui." });
    const posted = await t.api<{ responders: string[] }>("/groups/crm/messages", { body: { text: "@dev e @revisor, ajustem o teste" } });
    assert.deepEqual(posted.body.responders, ["dev", "revisor"]);
    await settle("crm");
  });

  it("@você para o grupo e aparece em 'precisa de você' até a pessoa responder", async () => {
    setScript({ arquiteto: "Os dois caminhos têm custo. @você decide: 1 ou 2?" });
    await t.api("/groups/crm/messages", { body: { text: "como fazemos a validação?" } });
    await settle("crm");
    let state = await t.neoterm.state();
    assert.ok(state.attention.some((item) => item.kind === "group_waiting" && item.group === "crm"));
    assert.equal(state.groups.find((group) => group.slug === "crm")?.waiting, true);
    assert.equal((await transcript("crm")).at(-1)?.meta.asksPerson, true);
    setScript({ arquiteto: "Combinado, opção 2." });
    await t.api("/groups/crm/messages", { body: { text: "2" } });
    await settle("crm");
    state = await t.neoterm.state();
    assert.equal(state.attention.some((item) => item.kind === "group_waiting"), false);
  });

  it(`dois agentes num vai e vem param sozinhos depois de ${MAX_HOPS} falas`, async () => {
    setScript({ dev: "vai @revisor", revisor: "volta @dev" });
    await t.api("/groups/crm/messages", { body: { text: "@dev comecem" } });
    await settle("crm");
    const messages = await transcript("crm");
    const stopped = messages.filter((message) => message.meta.notice === "group_stopped");
    assert.equal(stopped.length, 1);
    const sinceLastPerson = messages.slice(messages.findLastIndex((message) => message.author === "person") + 1);
    assert.equal(sinceLastPerson.filter((message) => message.author === "agent").length, MAX_HOPS + 1);
    assert.ok((await t.neoterm.state()).attention.some((item) => item.kind === "group_stopped"));
  });

  it("um colega pausado não é acordado por outro agente", async () => {
    setScript({ arquiteto: "@revisor dá uma olhada" });
    await t.api("/agents/revisor/pause", { body: {} });
    await t.api("/groups/crm/messages", { body: { text: "status?" } });
    await settle("crm");
    const last = (await transcript("crm")).at(-1)!;
    assert.equal(last.author, "system");
    assert.match(last.text, /revisor está pausado e não respondeu/);
    await t.api("/agents/revisor/resume", { body: {} });
  });

  it("uma rotina pode postar no grupo e puxar os colegas, sozinha", async () => {
    setScript({ arquiteto: "Semana planejada. @dev começa pelo filtro.", dev: "Começando." });
    const created = await t.api<{ routine: { id: string } }>("/routines", {
      body: { agent: "arquiteto", group: "crm", title: "planejar", instruction: "planeje a semana", cron: "0 9 * * 1" },
    });
    assert.equal(created.status, 201);
    const [routine] = await t.db.select().from(routines).where(eq(routines.id, created.body.routine.id));
    const outcome = await t.neoterm.routines.fire(routine!);
    assert.equal(outcome?.ok, true);
    await settle("crm");
    const messages = await transcript("crm");
    const tail = messages.slice(-3);
    assert.deepEqual(tail.map((message) => [message.author, message.agent]), [
      ["routine", "arquiteto"],
      ["agent", "arquiteto"],
      ["agent", "dev"],
    ]);
    const devCall = fakeCalls().filter((call) => call.agent === "dev").at(-1)!;
    assert.equal(argOf(devCall, "--tools"), "Read,Glob,Grep,WebSearch,WebFetch", "começou por rotina: escopo sozinho");
  });

  it("recusa grupo com agente que não existe e nome repetido", async () => {
    assert.equal((await t.api("/groups", { body: { slug: "x", folder, members: ["fantasma"] } })).status, 404);
    assert.equal((await t.api("/groups", { body: { slug: "crm", folder, members: ["dev"] } })).status, 422);
  });
});
