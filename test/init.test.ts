import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseClaudeStatus } from "../src/providers.ts";

const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

/** Roda o neoterm init numa pasta própria, com o claude falso. */
function runInit(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "neoterm-init-"));
  const result = spawnSync(process.execPath, [main, "init"], {
    env: { ...process.env, NO_COLOR: "1", NEOTERM_HOME: home, NEOTERM_DATABASE: join(home, "neoterm.db"), NEOTERM_CLAUDE_BIN: fake, FAKE_CLAUDE_STATE: join(home, "fake"), ...env },
    input: "",
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...result, home };
}

describe("neoterm init", () => {
  it("lê o status do Claude sem guardar e-mail", () => {
    assert.deepEqual(parseClaudeStatus('{"loggedIn":true,"subscriptionType":"team","email":"a@b.c"}'), { state: "logged-in", plan: "team" });
    assert.deepEqual(parseClaudeStatus('{"loggedIn":false}'), { state: "logged-out" });
    assert.deepEqual(parseClaudeStatus("não é json"), { state: "logged-out" });
  });

  it("com login, segue direto e guarda o provedor", () => {
    const run = runInit();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Claude conectado · plano pro/);
    assert.doesNotMatch(run.stdout, /x@y\.z|Abrindo o login/);
    assert.equal(JSON.parse(readFileSync(join(run.home, "config.json"), "utf8")).provider, "claude");
  });

  it("sem login, abre o login do próprio provedor e confere de novo", () => {
    const run = runInit({ FAKE_LOGGED_OUT: "1" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Claude sem login\. Abrindo o login dele/);
    assert.match(run.stdout, /Login successful/);
    assert.match(run.stdout, /Claude conectado/);
  });

  it("sem nenhum provedor instalado, para e diz qual falta", () => {
    const run = runInit({ NEOTERM_CLAUDE_BIN: "/nao/existe/claude" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /nenhum provedor instalado/);
    assert.doesNotMatch(run.stdout, /code\.claude\.com|instale/i);
  });
});
