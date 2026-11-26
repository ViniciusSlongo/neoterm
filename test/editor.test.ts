import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as editor from "../src/tui/editor.ts";

const at = (text: string): editor.Draft => ({ text: text.replace("|", ""), cursor: [...text].indexOf("|") });
const show = (draft: editor.Draft) => {
  const chars = [...draft.text];
  return [...chars.slice(0, draft.cursor), "|", ...chars.slice(draft.cursor)].join("");
};

describe("editor do input", () => {
  it("insere e apaga onde está o cursor", () => {
    assert.equal(show(editor.insert(at("ab|cd"), "X")), "abX|cd");
    assert.equal(show(editor.backspace(at("ab|cd"))), "a|cd");
    assert.equal(show(editor.backspace(at("|cd"))), "|cd");
    assert.equal(show(editor.deleteForward(at("ab|cd"))), "ab|d");
    assert.equal(show(editor.deleteForward(at("abcd|"))), "abcd|");
  });

  it("conta emoji como um caractere", () => {
    assert.equal(show(editor.backspace(at("ok🙂|"))), "ok|");
    assert.equal(show(editor.left(at("ok🙂|"))), "ok|🙂");
  });

  it("[imagem N] é um bloco só para setas e apagar", () => {
    assert.equal(show(editor.backspace(at("ver [imagem 12]|!"))), "ver |!");
    assert.equal(show(editor.deleteForward(at("ver |[imagem 2] !"))), "ver | !");
    assert.equal(show(editor.left(at("ver [imagem 2]|"))), "ver |[imagem 2]");
    assert.equal(show(editor.right(at("ver |[imagem 2]"))), "ver [imagem 2]|");
  });

  it("apaga a palavra antes do cursor", () => {
    assert.equal(show(editor.deleteWordBack(at("um dois|"))), "um |");
    assert.equal(show(editor.deleteWordBack(at("um dois  |"))), "um |");
    assert.equal(show(editor.deleteWordBack(at("um |dois"))), "|dois");
    assert.equal(show(editor.deleteWordBack(at("ver [imagem 2]|"))), "ver |");
    assert.equal(show(editor.deleteWordBack(at("a\n|b"))), "a|b");
    assert.equal(show(editor.deleteWordBack(at("|x"))), "|x");
  });

  it("anda por palavras e pelas pontas da linha", () => {
    assert.equal(show(editor.wordLeft(at("um dois  |"))), "um |dois  ");
    assert.equal(show(editor.wordRight(at("|um dois"))), "um| dois");
    assert.equal(show(editor.lineStart(at("a\nbc|d"))), "a\n|bcd");
    assert.equal(show(editor.lineEnd(at("a|b\ncd"))), "ab|\ncd");
  });

  it("↑↓ mudam de linha na mesma coluna, e dizem quando não há para onde ir", () => {
    assert.equal(show(editor.up(at("abcdef\nxy|z"))!), "ab|cdef\nxyz");
    assert.equal(show(editor.up(at("ab\nxyz|"))!), "ab|\nxyz");
    assert.equal(show(editor.down(at("a|bc\nx"))!), "abc\nx|");
    assert.equal(editor.up(at("ab|c")), null);
    assert.equal(editor.down(at("a\nb|c")), null);
    assert.deepEqual(editor.position(at("a\nbc|")), { line: 1, column: 2 });
  });
});
