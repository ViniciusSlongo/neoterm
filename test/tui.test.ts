import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { makeAgent, makeFolder, ROOT, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { App } = await import("../src/tui/app.ts");
const { httpApi } = await import("../src/tui/api.ts");
const { cronFromValues } = await import("../src/tui/forms.ts");
const { formKey } = await import("../src/tui/form.ts");
const { newRoutineForm } = await import("../src/tui/forms.ts");

const KEY = {
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  tab: "\t",
  space: " ",
  ctrlS: "\x13",
  ctrlR: "\x12",
};

let t: TestNeoterm;
let OPENED_IN = "";
let ui: ReturnType<typeof render>;
const frame = () => ui.lastFrame() ?? "";
const press = async (...keys: string[]) => {
  for (const key of keys) {
    ui.stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const type = async (text: string) => {
  ui.stdin.write(text);
  await new Promise((resolve) => setTimeout(resolve, 25));
};
const seen = (pattern: RegExp | string, timeoutMs = 8000) =>
  waitFor(() => (typeof pattern === "string" ? frame().includes(pattern) : pattern.test(frame())), timeoutMs).catch(() => {
    throw new Error(`não apareceu na tela: ${pattern}\n---\n${frame()}`);
  });

before(async () => {
  t = await startNeoterm();
  await makeAgent("analista", { title: "Acompanhamento financeiro" });
  await makeAgent("dev", { title: "Implementação" });
  // A interface aberta numa pasta: um caminho relativo no formulário parte dela.
  OPENED_IN = makeFolder("aberto-aqui");
  makeFolder("aberto-aqui/codigo");
  ui = render(h(App, { api: httpApi(t.base), cwd: OPENED_IN }));
  await seen("AGENTES");
});
after(async () => {
  ui.unmount();
  await t.close();
});

describe("a interface", () => {
  it("mostra a lateral com os agentes e abre a conversa do primeiro", async () => {
    await seen(/○ analista/);
    await seen(/○ dev/);
    await seen("+ novo agente");
    await seen(/analista · Acompanhamento financeiro/);
    await seen("mensagem para analista");
  });

  it("envia uma mensagem e mostra a resposta", async () => {
    await type("quanto entrou hoje?");
    await seen("> quanto entrou hoje?");
    await press(KEY.enter);
    await seen("› quanto entrou hoje?");
    await seen("eco: quanto entrou hoje?");
  });

  it("mostra as ferramentas usadas, inclusive as negadas", async () => {
    await type("!ferramenta Read extratos.csv");
    await press(KEY.enter);
    await seen(/⎿ Read\s+extratos\.csv/);
  });

  it("troca de agente com ↑↓ quando não há texto", async () => {
    await press(KEY.down);
    await seen(/dev · Implementação/);
    await press(KEY.up);
    await seen(/analista · Acompanhamento financeiro/);
  });

  it("cria um agente pelo formulário", async () => {
    await press(KEY.escape);
    await seen("n novo agente");
    await type("n");
    await seen("novo agente");
    await type("revisor");
    await press(KEY.tab);
    await type("Revisão de código");
    await press(KEY.tab);
    await type("Revisa o código antes de cada entrega.");
    await press(KEY.tab);
    await type("codigo, ~");
    await press(KEY.ctrlS);
    await seen(/○ revisor/);
    const { status, body } = await t.api<{ agent: { folders: string[] } }>("/agents/revisor");
    assert.equal(status, 200);
    assert.deepEqual(body.agent.folders, [realpathSync(join(OPENED_IN, "codigo")), realpathSync(homedir())]);
  });

  it("pausa e retoma pela lateral", async () => {
    await waitFor(() => frame().includes("revisor"));
    await press(KEY.escape);
    // Volta ao primeiro agente e pausa.
    await press(KEY.up, KEY.up, KEY.up, KEY.up);
    await type("p");
    await seen(/‖ analista/);
    await type("p");
    await seen(/○ analista/);
  });

  it("cria um grupo, conversa nele e os agentes se chamam", async () => {
    const folder = join(ROOT, "proj");
    mkdirSync(folder, { recursive: true });
    setScript({ analista: "Vou checar os números. @dev prepara a planilha.", dev: "Planilha pronta." });
    await t.api("/groups", { body: { slug: "fechamento", folder, members: ["analista", "dev"] } });
    await seen("GRUPOS");
    await seen("# fechamento");
    const index = (await t.neoterm.state()).agents.length;
    await press(KEY.up, KEY.up, KEY.up, KEY.up, KEY.up);
    for (let step = 0; step < index; step++) await press(KEY.down);
    await press(KEY.enter);
    await seen("mensagem para o grupo");
    await type("fechem o mês");
    await press(KEY.enter);
    await seen("Planilha pronta.", 15_000);
    assert.match(frame(), /analista\s+\d\d:\d\d/);
    assert.match(frame(), /@dev/);
    setScript({});
  });

  it("abre as rotinas do grupo e cria uma pelo formulário", async () => {
    await press(KEY.ctrlR);
    await seen("nenhuma rotina");
    await type("n");
    await seen("nova rotina");
    // Agente (escolha) → O que fazer
    await press(KEY.tab);
    await type("conferir o caixa");
    await press(KEY.tab, KEY.right); // dias úteis → toda semana
    await seen("Dia");
    await press(KEY.ctrlS);
    await seen(/● conferir-o-caixa/);
    const { body } = await t.api<{ routines: { title: string; group: string; cron: string }[] }>("/routines");
    const created = body.routines.find((routine) => routine.title === "conferir-o-caixa");
    assert.equal(created?.group, "fechamento");
    assert.equal(created?.cron, "0 9 * * 1");
    await press(KEY.escape);
  });

  it("mostra o que precisa de você", async () => {
    const created = await t.api<{ routine: { id: string } }>("/routines", {
      body: { agent: "dev", title: "quebra", instruction: "!falhar sem acesso ao servidor", cron: "0 9 * * *" },
    });
    await t.api(`/routines/${created.body.routine.id}/run`, { body: {} });
    await seen("PRECISA DE VOCÊ");
    await seen(/! rotina quebra falhou/);
  });
});

describe("formulário de rotina", () => {
  it("monta o cron das escolhas", () => {
    assert.equal(cronFromValues({ frequency: "daily", time: "18:30" }), "30 18 * * *");
    assert.equal(cronFromValues({ frequency: "weekdays", time: "09:00" }), "0 9 * * 1-5");
    assert.equal(cronFromValues({ frequency: "weekly", time: "17:00", weekday: "5" }), "0 17 * * 5");
    assert.equal(cronFromValues({ frequency: "monthly", time: "08:00", day: "1" }), "0 8 1 * *");
    assert.equal(cronFromValues({ frequency: "cron", cron: "*/30 * * * *" }), "*/30 * * * *");
    assert.throws(() => cronFromValues({ frequency: "daily", time: "25:00" }), /09:00/);
  });

  it("mostra a próxima execução e recusa o que roda rápido demais", () => {
    const form = newRoutineForm(httpApi("http://127.0.0.1:1"), { kind: "agent", slug: "x" }, [], "America/Sao_Paulo", () => {});
    const values = { instruction: "x", frequency: "cron", cron: "*/5 * * * *", mode: "act", title: "" };
    assert.match(form.preview?.(values) ?? "", /15 minutos/);
    assert.match(form.preview?.({ ...values, cron: "0 9 * * 1-5" }) ?? "", /^próxima: .* · seg–sex 09:00/);
  });

  it("campos escondidos ficam fora da navegação", () => {
    let form = newRoutineForm(httpApi("http://127.0.0.1:1"), { kind: "agent", slug: "x" }, [], "America/Sao_Paulo", () => {});
    const step = (input: string, key: Record<string, boolean> = {}) => {
      const action = formKey(form, input, key);
      if (action.type === "state") form = action.form;
      return action;
    };
    step("", { tab: true }); // O que fazer → Quando
    assert.equal(form.fields[form.index]?.key, "frequency");
    step("", { tab: true }); // dias úteis: pula Dia e Dia do mês
    assert.equal(form.fields[form.index]?.key, "time");
  });
});
