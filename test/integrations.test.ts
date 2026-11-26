import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeAgent, makeFolder, startNeoterm, type TestNeoterm } from "./harness.ts";

const { parseMcpList, safeTarget } = await import("../src/integrations.ts");
type Integrations = Awaited<ReturnType<typeof import("../src/integrations.ts").listIntegrations>>;

let t: TestNeoterm;
before(async () => {
  t = await startNeoterm();
});
after(() => t.close());

describe("integrações (MCP)", () => {
  it("lê o claude mcp list: conta claude.ai, Claude Code e o status de cada uma", () => {
    const servers = parseMcpList(
      [
        "Checking MCP server health…",
        "",
        "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected",
        "claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication",
        "github: npx -y @modelcontextprotocol/server-github - ✗ Failed to connect",
        "local-db: node /Users/x/mcp/server.js - ⏸ Pending approval",
        "linha qualquer sem formato",
      ].join("\n"),
    );
    assert.deepEqual(
      servers.map((server) => [server.name, server.source, server.target, server.status]),
      [
        ["Google Drive", "conta", "drivemcp.googleapis.com", "connected"],
        ["Slack", "conta", "mcp.slack.com", "needs_auth"],
        ["github", "claude-code", "npx @modelcontextprotocol/server-github", "failed"],
        ["local-db", "claude-code", "node /Users/x/mcp/server.js", "pending"],
      ],
    );
  });

  it("nunca mostra tokens: da URL fica só o host; do comando, o programa", () => {
    assert.equal(safeTarget("https://api.exemplo.com/mcp?token=segredo123&key=abc"), "api.exemplo.com");
    assert.equal(safeTarget("https://user:senha@api.exemplo.com/x"), "api.exemplo.com");
    assert.equal(safeTarget("/usr/local/bin/meu-mcp --api-key segredo"), "meu-mcp");
    assert.equal(safeTarget("uvx mcp-server-sqlite --db-path /tmp/x.db"), "uvx mcp-server-sqlite");
  });

  it("a rota junta o Claude Code com os .mcp.json das pastas dos agentes, sem segredos", async () => {
    const folder = makeFolder("com-mcp");
    writeFileSync(
      join(folder, ".mcp.json"),
      JSON.stringify({ mcpServers: { banco: { command: "npx", args: ["-y", "@empresa/mcp-banco"], env: { DB_PASSWORD: "segredo" } } } }),
    );
    await makeAgent("integrado", { folders: [folder] });
    const { status, body } = await t.api<Integrations>("/integrations?refresh=1");
    assert.equal(status, 200);
    assert.equal(body.agentsUseThem, false);
    assert.deepEqual(
      body.servers.map((server) => [server.name, server.source, server.status]),
      [
        ["Google Drive", "conta", "connected"],
        ["Slack", "conta", "needs_auth"],
        ["github", "claude-code", "failed"],
        ["banco", "projeto", "unchecked"],
      ],
    );
    assert.ok(body.servers.find((server) => server.name === "banco")?.folder?.endsWith("com-mcp"));
    assert.doesNotMatch(JSON.stringify(body), /segredo/);
  });
});
