import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expandImages, pastedImages, shortenImages } from "../src/tui/images.ts";
import { makeFolder } from "./harness.ts";

describe("imagens coladas", () => {
  const folder = makeFolder("imagens");
  const plain = join(folder, "a.png");
  const spaced = join(folder, "com espaço.JPEG");
  const notImage = join(folder, "notas.txt");
  for (const file of [plain, spaced, notImage]) writeFileSync(file, "");

  it("reconhece caminhos de imagem colados, com aspas ou espaços escapados", () => {
    assert.deepEqual(pastedImages(plain), [plain]);
    assert.deepEqual(pastedImages(` ${plain}\n`), [plain]);
    assert.deepEqual(pastedImages(`'${spaced}'`), [spaced]);
    assert.deepEqual(pastedImages(`"${spaced}"`), [spaced]);
    assert.deepEqual(pastedImages(spaced.replace(/ /g, "\\ ")), [spaced]);
    assert.deepEqual(pastedImages(`${plain} '${spaced}'`), [plain, spaced]);
  });

  it("o resto é texto", () => {
    assert.equal(pastedImages(""), null);
    assert.equal(pastedImages("olá mundo"), null);
    assert.equal(pastedImages(notImage), null);
    assert.equal(pastedImages(join(folder, "nao-existe.png")), null);
    assert.equal(pastedImages(`veja ${plain}`), null);
    assert.equal(pastedImages("a.png"), null);
  });

  it("expande no envio e encurta para mostrar", () => {
    const images = new Map([[1, plain], [2, spaced]]);
    const sent = expandImages("olha [imagem 1] e [imagem 2] e [imagem 3]", images);
    assert.equal(sent, `olha [imagem 1: ${plain}] e [imagem 2: ${spaced}] e [imagem 3]`);
    assert.equal(shortenImages(sent), "olha [imagem 1] e [imagem 2] e [imagem 3]");
  });
});
