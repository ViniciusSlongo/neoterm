/*
 * A roda do mouse. Com o modo de mouse ligado (ver main.ts), o terminal manda cada evento como
 * `ESC [ < botão ; coluna ; linha M`. O ink descarta essas sequências antes do useInput, então elas
 * são tiradas aqui, na leitura do stdin, antes de chegar a ele. Cliques são ignorados.
 */

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

type Readable = { read(size?: number): unknown };

/** Passa cada giro da roda para `onWheel` (+1 para cima, -1 para baixo); devolve como desfazer. */
export function captureMouse(stdin: Readable, onWheel: (direction: 1 | -1) => void): () => void {
  const own = Object.hasOwn(stdin, "read");
  const original = stdin.read;
  stdin.read = function read(this: Readable, size?: number) {
    const chunk = original.call(this, size);
    if (chunk === null || chunk === undefined) return chunk;
    const text = typeof chunk === "string" ? chunk : String(chunk);
    if (!text.includes("\x1b[<")) return chunk;
    return text.replace(SGR_MOUSE, (_, button: string) => {
      const code = Number(button);
      if ((code & 64) !== 0) onWheel((code & 1) === 0 ? 1 : -1);
      return "";
    });
  };
  return () => {
    if (own) stdin.read = original;
    else delete (stdin as Partial<Readable>).read;
  };
}
