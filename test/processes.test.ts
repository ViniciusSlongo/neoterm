import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { makeAgent, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { parseEtime } = await import("../src/processes.ts");
type Proc = { pid: number; kind: string; inTurn: boolean; command: string; rssBytes: number };
type View = { processes: Proc[]; totalBytes: number };

let t: TestNeoterm;
const started: number[] = [];
before(async () => {
  t = await startNeoterm({ idleMs: 0 });
  await makeAgent("ana", {});
  await makeAgent("bia", {});
});
after(async () => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // já saiu
    }
  }
  await t.close();
});

const view = async (slug: string) => (await t.api<View>(`/agents/${slug}/processes`)).body;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const startService = async (slug: string) => {
  setScript({ [slug]: "!servico 60000" });
  const outcome = await t.neoterm.chat(slug, "sobe o servidor");
  setScript({});
  const pid = Number(/servico (\d+)/.exec(outcome.text)?.[1]);
  started.push(pid);
  return pid;
};

describe("processos de um agente", () => {
  it("lê o tempo de vida do ps", () => {
    assert.equal(parseEtime("03:04"), 184);
    assert.equal(parseEtime("02:03:04"), 7384);
    assert.equal(parseEtime("1-00:00:01"), 86_401);
  });

  it("acha o serviço que o agente deixou rodando, mesmo órfão, e só no agente certo", async () => {
    const pid = await startService("ana");
    const list = await waitFor(async () => {
      const found = (await view("ana")).processes.find((entry) => entry.pid === pid);
      return found;
    });
    assert.equal(list.kind, "service");
    assert.equal(list.inTurn, false);
    assert.ok(list.rssBytes > 0);
    assert.ok(!(await view("bia")).processes.some((entry) => entry.pid === pid));
  });

  it("avisa em 'precisa de você' quando o agente está parado com serviços, e o aviso some ao encerrar", async () => {
    await t.neoterm.idle.check();
    const item = (await t.neoterm.state()).attention.find((entry) => entry.kind === "idle_services");
    assert.ok(item);
    assert.equal(item.agent, "ana");
    assert.match(item.text, /ana está parado .* com 1 serviço rodando/);
    // Não encerra nada sozinho.
    assert.ok((await view("ana")).processes.length > 0);
  });

  it("encerra só processos do próprio agente", async () => {
    const anaPid = (await view("ana")).processes[0]!.pid;
    const biaPid = await startService("bia");
    // bia não encerra o de ana.
    const refused = await t.api<{ stopped: number[] }>("/agents/bia/processes/stop", { body: { pids: [anaPid] } });
    assert.deepEqual(refused.body.stopped, []);
    assert.ok(alive(anaPid));
    // ana encerra o dela.
    const stopped = await t.api<{ stopped: number[] }>("/agents/ana/processes/stop", { body: { pids: [anaPid] } });
    assert.deepEqual(stopped.body.stopped, [anaPid]);
    await waitFor(() => !alive(anaPid));
    // "Todos" de bia.
    const all = await t.api<{ stopped: number[] }>("/agents/bia/processes/stop", { body: { all: true } });
    assert.deepEqual(all.body.stopped, [biaPid]);
    await waitFor(() => !alive(biaPid));
    await t.neoterm.idle.check();
    assert.ok(!(await t.neoterm.state()).attention.some((entry) => entry.kind === "idle_services"));
  });
});
