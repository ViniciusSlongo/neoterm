import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DOCS_DIR, findDoc, listDocs, renderForTerminal } from "../src/cli/docs.ts";
import { COMMANDS } from "../src/tui/commands.ts";

describe("docs", async () => {
  const docs = await listDocs();

  it("todo doc tem título e resumo, em ordem, sem número repetido", () => {
    assert.ok(docs.length >= 5);
    for (const doc of docs) {
      assert.ok(doc.title && doc.title !== doc.name, `${doc.name} sem # Título`);
      assert.ok(doc.summary, `${doc.name} sem > resumo`);
    }
    const numbers = docs.map((doc) => doc.number);
    assert.deepEqual(numbers, numbers.toSorted((a, b) => a - b));
    assert.equal(new Set(numbers).size, numbers.length);
  });

  it("acha pelo nome, número, começo do nome ou título, sem ligar para acentos", () => {
    assert.equal(findDoc(docs, "agentes")?.name, "agentes");
    assert.equal(findDoc(docs, "1")?.name, "comecar");
    assert.equal(findDoc(docs, "rot")?.name, "rotinas");
    assert.equal(findDoc(docs, "começar")?.name, "comecar");
    assert.equal(findDoc(docs, "nada-disso"), undefined);
  });

  it("todo comando da conversa está documentado, com os apelidos", () => {
    const text = readFileSync(`${DOCS_DIR}/03-comandos.md`, "utf8");
    for (const command of COMMANDS) {
      assert.ok(text.includes(`\`:${command.name}\``), `:${command.name} fora do docs/03-comandos.md`);
      for (const alias of command.aliases.filter((alias) => alias !== "integrações")) {
        if (alias !== "?" && alias !== "help") assert.ok(text.includes(`:${alias}`), `:${alias} fora do docs/03-comandos.md`);
      }
    }
  });

  it("desenha o markdown sem os símbolos e alinha tabelas", () => {
    const out = renderForTerminal("# Título\n\nUm **negrito** e `código`.\n\n| a | bb |\n| --- | --- |\n| ccc | d |\n\n```\nx = 1\n```\n- item");
    assert.doesNotMatch(out, /\*\*|```|\| ---/);
    assert.match(out, /TÍTULO/);
    assert.match(out, /a {5}bb/);
    assert.match(out, /ccc {3}d/);
    assert.match(out, /x = 1/);
    assert.match(out, /• item/);
  });
});
