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
