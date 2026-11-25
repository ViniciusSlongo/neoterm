import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeArgs, describeToolInput, toEvents } from "../src/runner/claude.ts";

const cwd = "/home/x/agente/workspace";

describe("stream-json do Claude Code", () => {
  it("traduz início, ferramenta, erro de ferramenta, texto e resultado", () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5" },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: `${cwd}/a.txt` } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "negado\ndetalhe" }] },
      },
      { type: "assistant", message: { content: [{ type: "thinking" }, { type: "text", text: "Pronto." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Pronto.", duration_ms: 1200 },
    ];
    const events = lines.flatMap((line) => [...toEvents(line, cwd)]);
    assert.deepEqual(events, [
      { type: "init", sessionId: "s1", model: "claude-haiku-5-5" },
      { type: "tool", id: "t1", name: "Read", detail: "a.txt" },
      { type: "tool_result", id: "t1", error: "negado" },
      { type: "text", text: "Pronto." },
      { type: "result", ok: true, text: "Pronto.", durationMs: 1200 },
    ]);
  });

  it("lê o uso do plano", () => {
    const [event] = [
      ...toEvents(
        {
          type: "rate_limit_event",
          rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1795649400 } } },
        },
        cwd,
      ),
    ];
    assert.equal(event?.type, "plan_usage");
    if (event?.type === "plan_usage") assert.equal(event.usage.fiveHour?.utilization, 0.03);
  });

  it("resume o que cada ferramenta fez numa linha", () => {
    assert.equal(describeToolInput("Bash", { command: "npm test\nmais" }, cwd), "npm test");
    assert.equal(describeToolInput("Edit", { file_path: "/fora/b.ts" }, cwd), "/fora/b.ts");
    assert.equal(describeToolInput("WebSearch", { query: "neoterm" }, cwd), "neoterm");
  });
});

describe("argumentos do claude", () => {
  const base = {
    prompt: "oi",
    cwd,
    model: "claude-opus-5-5",
    systemPrompt: "<identity>x</identity>",
    addDirs: ["/srv/dados"],
    sessionId: "11111111-1111-1111-1111-111111111111",
  };

  it("começa uma sessão nova com --session-id e continua com --resume", () => {
    const fresh = claudeArgs({ ...base, resume: false });
    assert.deepEqual(fresh.slice(-2), ["--session-id", base.sessionId]);
    const resumed = claudeArgs({ ...base, resume: true });
    assert.deepEqual(resumed.slice(-2), ["--resume", base.sessionId]);
  });

  it("roda sem pedir permissão, com as pastas do agente e sem a configuração pessoal", () => {
    const args = claudeArgs({ ...base, resume: false });
    assert.ok(args.includes("--dangerously-skip-permissions"));
    for (const flag of ["--tools", "--allowedTools", "--disallowedTools", "--permission-prompts"]) {
      assert.ok(!args.includes(flag), `sem ${flag}`);
    }
    assert.equal(args[args.indexOf("--add-dir") + 1], "/srv/dados");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(!args.includes("--bare"), "--bare desliga o login do plano");
    assert.equal(args[args.indexOf("--system-prompt-snapshot") + 1], "off", "o prompt de cada turno vale");
  });
});

describe("ferramentas do neoterm na tela", () => {
  it("mostra o que importa, não o JSON", () => {
    assert.equal(
      describeToolInput("mcp__neoterm__create_routine", { title: "revisar-emails", cron: "0 9 * * 1-5", instruction: "x" }, cwd),
      "revisar-emails · 0 9 * * 1-5",
    );
    assert.equal(describeToolInput("mcp__neoterm__remember", { fact: "prefere respostas curtas" }, cwd), "prefere respostas curtas");
    assert.equal(
      describeToolInput("mcp__neoterm__schedule_followup", { minutes: 60, reason: "conferir o build" }, cwd),
      "em 60 min · conferir o build",
    );
  });
});
