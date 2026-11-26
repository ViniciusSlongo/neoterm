import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMANDS, parseCommand } from "../src/tui/commands.ts";

describe("comandos da conversa", () => {
  it("aceitam : e /, e os apelidos", () => {
    assert.equal(parseCommand(":notes"), "notes");
    assert.equal(parseCommand("/notes"), "notes");
    assert.equal(parseCommand(":ps"), "processes");
    assert.equal(parseCommand("/routines"), "routines");
    assert.equal(parseCommand(":?"), "help");
    assert.equal(parseCommand("  :HELP  "), "help");
    assert.equal(parseCommand(":dash"), "dashboard");
  });

  it("o resto é mensagem", () => {
    assert.equal(parseCommand("notes"), null);
    assert.equal(parseCommand(":notes do cliente"), null);
    // Os nomes em português saíram.
    for (const old of [":notas", ":ajuda", ":editar", ":ver", ":rotinas", ":painel", ":esforço"]) assert.equal(parseCommand(old), null, old);
    assert.equal(parseCommand(":inexistente"), null);
    assert.equal(parseCommand("http://exemplo.com"), null);
  });

  it("nenhum nome ou apelido repetido", () => {
    const words = COMMANDS.flatMap((command) => [command.name, ...command.aliases]);
    assert.equal(new Set(words).size, words.length);
  });
});

describe("cor de destaque", async () => {
  const { setAccent, theme, DEFAULT_ACCENT } = await import("../src/tui/theme.ts");
  it("troca o destaque e o fundo das suas mensagens; inválida volta ao azul", () => {
    setAccent("#f5a76c");
    assert.equal(theme.accent, "#F5A76C");
    assert.match(theme.person, /^#[0-9A-F]{6}$/);
    assert.notEqual(theme.person, "#1A2430");
    setAccent("vermelho");
    assert.equal(theme.accent, DEFAULT_ACCENT);
    setAccent(undefined);
    assert.equal(theme.accent, DEFAULT_ACCENT);
  });
});

describe("menu dos comandos", async () => {
  const { matchCommands } = await import("../src/tui/commands.ts");
  const names = (query: string, agent = true) => matchCommands(query, { agent }).map((command) => command.name);
  it("afunila pelo começo do nome ou de um apelido, depois pelo que contém", () => {
    assert.equal(names("").length, COMMANDS.length);
    assert.deepEqual(names("not"), ["notes"]);
    assert.deepEqual(names("ps"), ["processes"]);
    assert.deepEqual(names("eff"), ["effort"]);
    assert.ok(names("h")[0] === "help");
    assert.deepEqual(names("xyz"), []);
    assert.deepEqual(names("e"), ["edit", "effort"]);
    assert.deepEqual(names("cess"), ["processes"]);
  });
  it("num grupo, esconde os comandos só de agente", () => {
    assert.ok(!names("", false).includes("notes"));
    assert.ok(names("", false).includes("edit"));
  });
});
