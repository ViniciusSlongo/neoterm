import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMANDS, parseCommand } from "../src/tui/commands.ts";

describe("comandos da conversa", () => {
  it("aceitam : e /, e os apelidos", () => {
    assert.equal(parseCommand(":notas"), "notas");
    assert.equal(parseCommand("/notes"), "notas");
    assert.equal(parseCommand(":ps"), "processos");
    assert.equal(parseCommand("/rotinas"), "rotinas");
    assert.equal(parseCommand(":?"), "ajuda");
    assert.equal(parseCommand("  :AJUDA  "), "ajuda");
  });

  it("o resto é mensagem", () => {
    assert.equal(parseCommand("notas"), null);
    assert.equal(parseCommand(":notas do cliente"), null);
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
    assert.deepEqual(names("not"), ["notas"]);
    assert.deepEqual(names("ps"), ["processos"]);
    assert.deepEqual(names("esfor"), ["esforço"]);
    assert.ok(names("a")[0] === "ajuda");
    assert.deepEqual(names("xyz"), []);
    assert.deepEqual(names("e"), ["editar", "esforço"]);
    assert.deepEqual(names("cesso"), ["processos"]);
  });
  it("num grupo, esconde os comandos só de agente", () => {
    assert.ok(!names("", false).includes("notas"));
    assert.ok(names("", false).includes("editar"));
  });
});
