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
    tools: ["Read", "Bash"],
    disallowed: ["Edit(//srv/dados/**)"],
    addDirs: ["/srv/dados"],
    sessionId: "11111111-1111-1111-1111-111111111111",
  };

  it("começa uma sessão nova com --session-id e continua com --resume", () => {
    const fresh = claudeArgs({ ...base, resume: false });
    assert.deepEqual(fresh.slice(-2), ["--session-id", base.sessionId]);
    const resumed = claudeArgs({ ...base, resume: true });
    assert.deepEqual(resumed.slice(-2), ["--resume", base.sessionId]);
  });

  it("dá ao agente só as ferramentas do escopo e nada da configuração da pessoa", () => {
    const args = claudeArgs({ ...base, resume: false });
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Bash");
    assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
    assert.equal(args[args.indexOf("--setting-sources") + 1], "project");
    assert.ok(args.includes("--strict-mcp-config"));
    assert.ok(!args.includes("--bare"), "--bare desliga o login do plano");
  });
});
