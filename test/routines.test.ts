import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { argOf, fakeCalls, HOME, makeAgent, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { followups, messages, routines, runs, attention } = await import("../src/db/schema.ts");
const { FATIGUE_LIMIT } = await import("../src/routines/runner.ts");
const { MAX_ENABLED } = await import("../src/routines/store.ts");

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
});
after(() => t.close());

type RoutineBody = { routine: { id: string; nextRunAt: string; enabled: boolean } };

async function newRoutine(agent: string, title: string, instruction: string, extra: Record<string, unknown> = {}) {
  const response = await t.api<RoutineBody & { error?: string }>("/routines", {
    body: { agent, title, instruction, cron: "0 9 * * *", ...extra },
  });
  assert.equal(response.status, 201, response.body.error ?? "");
  return response.body.routine;
}

async function makeDue(id: string, minutesAgo: number) {
  await t.db.update(routines).set({ nextRunAt: new Date(Date.now() - minutesAgo * 60_000) }).where(eq(routines.id, id));
}

async function routineRow(id: string) {
  const [row] = await t.db.select().from(routines).where(eq(routines.id, id));
  return row!;
}

async function routineRuns(id: string) {
  return t.db.select().from(runs).where(eq(runs.routineId, id));
}

describe("regras das rotinas", () => {
  before(() => makeAgent("regras"));

  it("recusa horário a menos de 15 minutos e horário inválido", async () => {
    const tooOften = await t.api("/routines", { body: { agent: "regras", title: "x", instruction: "y", cron: "*/5 * * * *" } });
    assert.equal(tooOften.status, 422);
    assert.match(String(tooOften.body.error), /15 minutos/);
    const invalid = await t.api("/routines", { body: { agent: "regras", title: "x", instruction: "y", cron: "todo dia" } });
    assert.equal(invalid.status, 422);
  });

  it("normaliza o nome e não deixa repetir no mesmo agente", async () => {
    const routine = await newRoutine("regras", "Resumo Diário!", "resuma");
    assert.equal((await routineRow(routine.id)).title, "resumo-diario");
    const again = await t.api("/routines", { body: { agent: "regras", title: "resumo diario", instruction: "y", cron: "0 9 * * *" } });
    assert.equal(again.status, 422);
  });

  it(`no máximo ${MAX_ENABLED} ligadas; desligar libera vaga; religar zera as falhas`, async () => {
    const existing = (await t.db.select().from(routines).where(eq(routines.enabled, true))).length;
    const created: string[] = [];
    for (let index = existing; index < MAX_ENABLED; index++) {
      created.push((await newRoutine("regras", `cheia-${index}`, "faça")).id);
    }
    const over = await t.api("/routines", { body: { agent: "regras", title: "uma-a-mais", instruction: "y", cron: "0 9 * * *" } });
    assert.equal(over.status, 422);
    assert.match(String(over.body.error), /20 rotinas ligadas/);
    await t.api(`/routines/${created[0]}`, { method: "PATCH", body: { enabled: false } });
    assert.equal((await t.api("/routines", { body: { agent: "regras", title: "uma-a-mais", instruction: "y", cron: "0 9 * * *" } })).status, 201);
    const reenable = await t.api(`/routines/${created[0]}`, { method: "PATCH", body: { enabled: true } });
    assert.equal(reenable.status, 422, "sem vaga não religa");
    for (const id of created) await t.api(`/routines/${id}`, { method: "DELETE" });
    await t.db.update(routines).set({ failureStreak: 4, enabled: false }).where(eq(routines.title, "uma-a-mais"));
    const [row] = await t.db.select().from(routines).where(eq(routines.title, "uma-a-mais"));
    await t.api(`/routines/${row!.id}`, { method: "PATCH", body: { enabled: true } });
    assert.equal((await routineRow(row!.id)).failureStreak, 0);
    await t.api(`/routines/${row!.id}`, { method: "DELETE" });
  });
});

describe("o relógio", () => {
  before(() => makeAgent("relogio", { name: "Relógio" }));

  it("dispara a rotina vencida, sozinho, e a resposta entra na conversa", async () => {
    const routine = await newRoutine("relogio", "resumo", "!ferramenta Read extratos.csv\nresuma os extratos");
    await makeDue(routine.id, 1);
    const tick = await t.neoterm.scheduler.tick();
    assert.deepEqual(tick.fired, [routine.id]);
    const [run] = await waitFor(async () => {
      const list = await routineRuns(routine.id);
      return list.some((entry) => entry.status !== "running") && list;
    });
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.trigger, "routine");
    const { body } = await t.api<{ messages: { author: string; text: string; meta: Record<string, string> }[] }>(
      "/agents/relogio/messages",
    );
    assert.deepEqual(body.messages.map((message) => message.author), ["routine", "agent"]);
    assert.equal(body.messages[0]?.meta.routineTitle, "resumo");
    const call = fakeCalls().filter((entry) => entry.agent === "Relógio").at(-1)!;
    assert.equal(argOf(call, "--tools"), "Read,Glob,Grep,WebSearch,WebFetch", "sozinho usa o escopo de rotinas");
    assert.match(call.system, /Ninguém está acompanhando/);
    assert.match(call.prompt, /^\[Rotina resumo · todo dia 09:00\]/);
    const next = (await routineRow(routine.id)).nextRunAt;
    assert.ok(next.getTime() > Date.now(), "a marca andou para a próxima vez");
  });

  it("pula, sem disparar, a que atrasou mais de 10 minutos", async () => {
    const routine = await newRoutine("relogio", "atrasada", "faça");
    await makeDue(routine.id, 30);
    const tick = await t.neoterm.scheduler.tick();
    assert.deepEqual(tick.skipped, [routine.id]);
    assert.deepEqual(tick.fired, []);
    assert.equal((await routineRuns(routine.id)).length, 0);
    assert.ok((await routineRow(routine.id)).nextRunAt.getTime() > Date.now());
  });

  it("uma rotina que só avisa roda só com ferramentas de leitura", async () => {
    const { grantTool } = await import("../src/agents/identity.ts");
    await grantTool("relogio", "Bash");
    const acting = await newRoutine("relogio", "age", "faça");
    await t.neoterm.routines.fire(await routineRow(acting.id));
    let call = fakeCalls().filter((entry) => entry.agent === "Relógio").at(-1)!;
    assert.equal(argOf(call, "--tools"), "Read,Glob,Grep,WebSearch,WebFetch,Bash", "com Bash liberado para rotinas");
    const routine = await newRoutine("relogio", "aviso", "verifique", { mode: "notify" });
    await t.neoterm.routines.fire(await routineRow(routine.id));
    call = fakeCalls().filter((entry) => entry.agent === "Relógio").at(-1)!;
    assert.equal(argOf(call, "--tools"), "Read,Glob,Grep,WebSearch,WebFetch", "só avisa: sem Bash");
    assert.match(call.system, /só avisa/);
  });

  it("agente pausado: a rotina é pulada e não conta como falha", async () => {
    await makeAgent("dorme");
    const routine = await newRoutine("dorme", "x", "!falhar não deveria rodar");
    await t.api("/agents/dorme/pause", { body: {} });
    await t.neoterm.routines.fire(await routineRow(routine.id));
    const list = await routineRuns(routine.id);
    assert.deepEqual(list.map((entry) => entry.status), ["skipped"]);
    assert.equal((await routineRow(routine.id)).failureStreak, 0);
  });
});

describe("a regra do cansaço", () => {
  before(() => makeAgent("cansa"));

  it("avisa na primeira falha, desliga na décima, e um sucesso zera", async () => {
    const routine = await newRoutine("cansa", "fragil", "!falhar token expirado");
    const fire = async () => t.neoterm.routines.fire(await routineRow(routine.id));

    await fire();
    let row = await routineRow(routine.id);
    assert.equal(row.failureStreak, 1);
    const notices = async () =>
      (await t.db.select().from(messages).where(eq(messages.conversationId, row.conversationId))).filter(
        (message) => message.author === "system",
      );
    assert.equal((await notices()).length, 1);
    assert.match((await notices())[0]!.text, /A rotina fragil falhou: token expirado/);

    for (let index = 2; index < FATIGUE_LIMIT; index++) await fire();
    row = await routineRow(routine.id);
    assert.equal(row.failureStreak, FATIGUE_LIMIT - 1);
    assert.equal(row.enabled, true);
    assert.equal((await notices()).length, 1, "não avisa a cada falha");

    await fire();
    row = await routineRow(routine.id);
    assert.equal(row.enabled, false);
    assert.match((await notices()).at(-1)!.text, /falhou 10 vezes seguidas/);
    const open = await t.db.select().from(attention).where(eq(attention.routineId, routine.id));
    assert.deepEqual(open.map((item) => item.kind).sort(), ["routine_disabled", "routine_failed"]);

    await t.db.update(routines).set({ instruction: "agora funciona", enabled: true }).where(eq(routines.id, routine.id));
    await fire();
    assert.equal((await routineRow(routine.id)).failureStreak, 0);
  });
});

describe("ferramentas do neoterm dentro de um turno", () => {
  before(() => makeAgent("ferramentas", { name: "Ferramentas" }));

  it("o agente cria, lista, muda e apaga rotinas conversando", async () => {
    const created = await t.neoterm.chat(
      "ferramentas",
      '!mcp create_routine {"title":"Cobrança","instruction":"listar atrasados","cron":"0 17 * * 5"}',
    );
    assert.match(created.text, /\[create_routine\] Rotina criada: cobranca · sex 17:00 \(America\/Sao_Paulo\) · age · próxima/);
    const listed = await t.neoterm.chat("ferramentas", "!mcp list_routines {}");
    assert.match(listed.text, /- cobranca · sex 17:00/);
    const changed = await t.neoterm.chat("ferramentas", '!mcp update_routine {"routine":"cobranca","cron":"0 18 * * 5","mode":"notify"}');
    assert.match(changed.text, /sex 18:00 .* só avisa/);
    const refused = await t.neoterm.chat("ferramentas", '!mcp update_routine {"routine":"cobranca","cron":"* * * * *"}');
    assert.match(refused.text, /Não deu: uma rotina pode rodar no máximo a cada 15 minutos/);
    const missing = await t.neoterm.chat("ferramentas", '!mcp delete_routine {"routine":"nao-existe"}');
    assert.match(missing.text, /Não achei uma rotina sua chamada "nao-existe"/);
    const deleted = await t.neoterm.chat("ferramentas", '!mcp delete_routine {"routine":"cobranca"}');
    assert.match(deleted.text, /Rotina cobranca apagada/);
  });

  it("lembra e esquece na MEMORY.md, que entra no próximo turno", async () => {
    await t.neoterm.chat("ferramentas", '!mcp remember {"fact":"A pessoa prefere respostas curtas"}');
    const memory = readFileSync(join(HOME, "agents", "ferramentas", "MEMORY.md"), "utf8");
    assert.match(memory, /^- A pessoa prefere respostas curtas \(\d\d\/\d\d\/\d{4}\)\n$/);
    await t.neoterm.chat("ferramentas", "oi");
    assert.match(fakeCalls().at(-1)!.system, /<memory>\n- A pessoa prefere respostas curtas/);
    const forgot = await t.neoterm.chat("ferramentas", '!mcp forget {"text":"respostas curtas"}');
    assert.match(forgot.text, /Esqueci 1 linha/);
  });

  it("agenda um retorno, que o relógio dispara", async () => {
    const scheduled = await t.neoterm.chat(
      "ferramentas",
      '!mcp schedule_followup {"minutes":60,"reason":"conferir o build","instruction":"!sessao"}',
    );
    assert.match(scheduled.text, /Retorno agendado para .*: conferir o build/);
    const [pending] = await t.db.select().from(followups).where(eq(followups.status, "scheduled"));
    assert.ok(pending);
    await t.db.update(followups).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(followups.id, pending.id));
    const tick = await t.neoterm.scheduler.tick();
    assert.deepEqual(tick.followups, [pending.id]);
    await waitFor(async () => {
      const [row] = await t.db.select().from(followups).where(eq(followups.id, pending.id));
      return row?.status === "done";
    });
    const call = fakeCalls().filter((entry) => entry.agent === "Ferramentas").at(-1)!;
    assert.match(call.prompt, /\[Retorno que você agendou\]\nMotivo: conferir o build/);
    assert.equal(argOf(call, "--tools"), "Read,Glob,Grep,WebSearch,WebFetch");
  });

  it("recusa retorno fora dos limites", async () => {
    const refused = await t.neoterm.chat("ferramentas", '!mcp schedule_followup {"minutes":20000,"reason":"x"}');
    assert.match(refused.text, /argumentos inválidos/);
  });

  it("a chave de uma execução não vale depois dela", async () => {
    await t.neoterm.chat("ferramentas", "oi");
    const config = JSON.parse(argOf(fakeCalls().at(-1)!, "--mcp-config")!);
    const server = config.mcpServers.neoterm;
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...server.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 401);
  });
});

describe("hoje na barra lateral", () => {
  it("lista as vezes de hoje com o que já rodou", async () => {
    await makeAgent("hoje");
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" }).format(now));
    const later = (hour + 1) % 24;
    const routine = await newRoutine("hoje", "mais-tarde", "faça", { cron: `0 ${later} * * *` });
    const state = await t.neoterm.state();
    const today = state.today.filter((entry) => entry.routine === "mais-tarde");
    if (later > hour) {
      assert.equal(today.length, 1);
      assert.equal(today[0]?.status, "scheduled");
      assert.equal(today[0]?.time, `${String(later).padStart(2, "0")}:00`);
    }
    await t.api(`/routines/${routine.id}`, { method: "DELETE" });
  });
});
