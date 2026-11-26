import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { displayPath, filterEntries, listDir, parentOf, referenceFor, rootEntries } from "../src/tui/files.ts";
import { makeFolder } from "./harness.ts";

describe("navegador de arquivos", () => {
  const root = makeFolder("navegar");
  mkdirSync(join(root, "src", "tui"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  for (const file of ["b.txt", "A.md", "item10.ts", "item2.ts", ".env", "src/app.ts", "Relatório Final.pdf"]) writeFileSync(join(root, file), "");

  it("lista pastas primeiro, em ordem natural, sem ocultos por padrão", async () => {
    const names = (await listDir(root, false)).map((entry) => `${entry.name}${entry.dir ? "/" : ""}`);
    assert.deepEqual(names, ["src/", "A.md", "b.txt", "item2.ts", "item10.ts", "Relatório Final.pdf"]);
    const hidden = (await listDir(root, true)).map((entry) => entry.name);
    assert.ok(hidden.includes(".git") && hidden.includes(".env"));
  });

  it("filtra pelo nome, sem ligar para maiúsculas e acentos", async () => {
    const entries = await listDir(root, false);
    assert.deepEqual(filterEntries(entries, "relatorio").map((entry) => entry.name), ["Relatório Final.pdf"]);
    assert.deepEqual(filterEntries(entries, "ITEM").map((entry) => entry.name), ["item2.ts", "item10.ts"]);
    assert.equal(filterEntries(entries, "  ").length, entries.length);
  });

  it("não sobe acima das pastas do escopo", () => {
    const other = makeFolder("outra");
    assert.equal(parentOf(join(root, "src", "tui"), [root]), join(root, "src"));
    assert.equal(parentOf(join(root, "src"), [root]), root);
    assert.equal(parentOf(root, [root]), null);
    assert.equal(parentOf(root, [root, other]), null);
    assert.deepEqual(rootEntries([root, other]).map((entry) => entry.dir), [true, true]);
  });

  it("referencia relativo à pasta onde o agente roda; fora dela, completo; com espaço, entre aspas", () => {
    const other = makeFolder("outra");
    assert.equal(referenceFor(join(root, "src", "app.ts"), root), "src/app.ts");
    assert.equal(referenceFor(join(other, "x.ts"), root), join(other, "x.ts"));
    assert.equal(referenceFor(join(root, "Relatório Final.pdf"), root), '"Relatório Final.pdf"');
  });

  it("mostra onde está a partir do nome da pasta do escopo", () => {
    assert.equal(displayPath(join(root, "src", "tui"), [root]), "navegar/src/tui");
    assert.equal(displayPath(root, [root]), "navegar");
    assert.equal(displayPath(null, [root]), "pastas do agente");
  });
});
