import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { makeFolder } from "./harness.ts";

const { detectLanguage, highlightChunks } = await import("../src/tui/highlight.ts");
const { expandTabs, findMatches, loadViewerFile, NEW_VIEW, slicePieces, viewerKey, VIEWER_MAX_BYTES } = await import("../src/tui/viewer.ts");
const { recentFiles } = await import("../src/tui/files.ts");
const { parseViewCommand } = await import("../src/tui/commands.ts");
type ViewerView = import("../src/tui/viewer.ts").ViewerView;

const folder = makeFolder("visualizador");
const file = (name: string, content: string | Buffer) => {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
};

describe("visualizador: linguagem e cores", () => {
  it("detecta a linguagem pelo nome e pela extensão", async () => {
    const name = async (path: string) => (await detectLanguage(path))?.name ?? null;
    assert.equal(await name("src/app.ts"), "TypeScript");
    assert.equal(await name("x.mjs"), "JavaScript");
    assert.equal(await name("script.py"), "Python");
    assert.equal(await name("README.md"), "Markdown");
    assert.equal(await name("Dockerfile"), "Dockerfile");
    assert.equal(await name(".env.local"), "dotEnv");
    assert.equal(await name("tsconfig.json"), "JSON with Comments");
    assert.equal(await name("notas.txt"), null);
    assert.equal(await name("sem-extensao"), null);
  });

  it("colore com o tema Dark+, e em partes dá o mesmo que de uma vez (um comentário atravessa as partes)", async () => {
    const code = 'const a = 1;\n/* um comentário\nde várias\nlinhas */\nconst b = "x";';
    const collect = async (chunkLines: number) => {
      const lines: { text: string; color?: string }[][] = [];
      for await (const chunk of highlightChunks(code, "typescript", { chunkLines })) lines.push(...chunk.lines);
      return lines;
    };
    const whole = await collect(500);
    assert.deepEqual(await collect(2), whole);
    const constToken = whole[0]!.find((segment) => segment.text === "const");
    assert.equal(constToken?.color, "#569CD6");
    // A linha do meio do comentário é toda verde (comentário), mesmo começando noutra parte.
    assert.ok(whole[2]!.every((segment) => segment.color === "#6A9955"));
  });
});

describe("visualizador: o arquivo", () => {
  it("abre com tabs como espaços, sem a linha vazia do \\n final, e com \\r\\n normalizado", async () => {
    const opened = await loadViewerFile(file("a.ts", "if (x) {\r\n\treturn 1;\r\n}\r\n"));
    assert.deepEqual(opened.lines, ["if (x) {", "    return 1;", "}"]);
    assert.equal(opened.language?.name, "TypeScript");
    assert.equal(opened.raw, "if (x) {\n\treturn 1;\n}");
  });

  it("tabs param na próxima coluna múltipla de 4, atravessando os pedaços", () => {
    assert.deepEqual(expandTabs([{ text: "ab" }, { text: "\tc" }]).map((segment) => segment.text), ["ab", "  c"]);
  });

  it("recusa binário, pasta e o que não existe", async () => {
    await assert.rejects(loadViewerFile(file("imagem.png", Buffer.from([0x89, 0x50, 0, 1, 2]))), /binário/);
    mkdirSync(join(folder, "pasta"), { recursive: true });
    await assert.rejects(loadViewerFile(join(folder, "pasta")), /é uma pasta/);
    await assert.rejects(loadViewerFile(join(folder, "nao-existe.ts")), /não existe/);
    await assert.rejects(loadViewerFile(file("grande.log", Buffer.alloc(VIEWER_MAX_BYTES + 1, 97))), /grande demais/);
  });

  it("busca sem diferenciar maiúsculas e corta os pedaços na ocorrência", () => {
    const matches = findMatches(["Total total", "nada"], "total");
    assert.deepEqual(matches, [
      { line: 0, start: 0, end: 5 },
      { line: 0, start: 6, end: 11 },
    ]);
    const pieces = slicePieces([{ text: "Total ", color: "#1" }, { text: "total", color: "#2" }], 2, 9, [{ start: 6, end: 11, current: true }]);
    assert.deepEqual(
      pieces.map((piece) => [piece.text, piece.segment.color, piece.match]),
      [
        ["tal ", "#1", null],
        ["tot", "#2", "current"],
      ],
    );
  });

  it("as teclas: rolam no limite, buscam, n/N dão a volta, esc limpa a busca e depois fecha", async () => {
    const opened = await loadViewerFile(file("lista.txt", Array.from({ length: 50 }, (_, at) => (at % 10 === 0 ? `alvo ${at}` : `linha ${at}`)).join("\n")));
    const key = (view: ViewerView, input: string, extra: Record<string, boolean> = {}) => {
      const action = viewerKey(view, opened, findMatches(opened.lines, view.term), input, extra, 10);
      return action;
    };
    const down = key(NEW_VIEW, "", { pageDown: true });
    assert.equal(down.type === "view" && down.view.top, 9);
    const end = key(NEW_VIEW, "G");
    assert.equal(end.type === "view" && end.view.top, 40);
    const up = key(NEW_VIEW, "", { upArrow: true });
    assert.equal(up.type === "view" && up.view.top, 0);
    // / alvo enter: a primeira ocorrência.
    let view: ViewerView = { ...NEW_VIEW, input: "alvo" };
    const searched = key(view, "", { return: true });
    assert.ok(searched.type === "view");
    view = searched.view;
    assert.equal(view.term, "alvo");
    assert.equal(view.current, 0);
    const previous = key(view, "N");
    assert.equal(previous.type === "view" && previous.view.current, 4);
    const missing = key({ ...NEW_VIEW, input: "xyz" }, "", { return: true });
    assert.equal(missing.type === "view" && missing.notFound, true);
    const cleared = key(view, "", { escape: true });
    assert.equal(cleared.type === "view" && cleared.view.term, "");
    assert.deepEqual(key(NEW_VIEW, "", { escape: true }), { type: "close" });
  });
});

describe("visualizador: arquivos à mão e o comando", () => {
  it("lista os arquivos que o agente mexeu, do mais recente, sem repetir e só os que existem", () => {
    file("um.ts", "1");
    file("dois.ts", "2");
    const found = recentFiles(["dois.ts", "um.ts", "dois.ts", "sumiu.ts", "cortado/que/nao…", join(folder, "um.ts")], folder);
    assert.deepEqual(
      found.map((entry) => entry.name),
      ["dois.ts", "um.ts"],
    );
  });

  it(":ver sozinho abre a lista; com caminho, o arquivo", () => {
    assert.deepEqual(parseViewCommand(":ver"), { path: null });
    assert.deepEqual(parseViewCommand("/abrir src/app.ts"), { path: "src/app.ts" });
    assert.deepEqual(parseViewCommand(':ver "pasta com espaço/a.ts"'), { path: "pasta com espaço/a.ts" });
    assert.equal(parseViewCommand(":verificar"), null);
  });
});
