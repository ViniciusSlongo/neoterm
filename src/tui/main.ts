import { render } from "ink";
import { createElement as h } from "react";
import { httpApi } from "./api.ts";
import { App } from "./app.ts";

// Tela alternativa: a interface ocupa o terminal e, ao sair, ele volta como estava. Sem quebra
// automática de linha: se o terminal medir um caractere mais largo do que o ink mediu (alguns
// emoji), a linha é cortada na borda em vez de descer, e a tela não sobe levando o cabeçalho.
const ALT_SCREEN_ON = "\x1b[?1049h\x1b[H\x1b[?7l";
const ALT_SCREEN_OFF = "\x1b[?7h\x1b[?1049l";
// Eventos de mouse (formato SGR): sem isso, o terminal transforma a roda em ↑↓, que trocam de
// conversa. Com isso, a roda rola só a conversa. Selecionar texto passa a pedir uma tecla
// modificadora, que depende do terminal (Option no iTerm2, Shift no Ghostty e no kitty).
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

/** Abre a interface em tela cheia e devolve o terminal como estava ao sair. */
export async function runTui(): Promise<void> {
  const mouse = process.env.NEOTERM_MOUSE !== "0";
  process.stdout.write(ALT_SCREEN_ON + (mouse ? MOUSE_ON : ""));
  const restore = () => process.stdout.write((mouse ? MOUSE_OFF : "") + ALT_SCREEN_OFF);
  process.once("exit", restore);
  // O protocolo de teclado kitty, onde o terminal tiver, separa o shift+enter do enter.
  const instance = render(h(App, { api: httpApi() }), { exitOnCtrlC: true, kittyKeyboard: { mode: "auto" } });
  try {
    await instance.waitUntilExit();
  } finally {
    process.off("exit", restore);
    restore();
  }
}
