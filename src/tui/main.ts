import { render } from "ink";
import { createElement as h } from "react";
import { httpApi } from "./api.ts";
import { App } from "./app.ts";

// Tela alternativa: a interface ocupa o terminal e, ao sair, ele volta como estava. Sem quebra
// automática de linha: se o terminal medir um caractere mais largo do que o ink mediu (alguns
// emoji), a linha é cortada na borda em vez de descer, e a tela não sobe levando o cabeçalho.
// O mouse fica com o terminal: arrastar seleciona, cmd+c e cmd+v como sempre. Na tela alternativa a
// roda chega como ↑↓ (o ?1007 pede isso a quem não faz por padrão), e ↑↓ rolam a conversa.
const ALT_SCREEN_ON = "\x1b[?1049h\x1b[H\x1b[?7l\x1b[?1007h";
const ALT_SCREEN_OFF = "\x1b[?1007l\x1b[?7h\x1b[?1049l";

/** Abre a interface em tela cheia e devolve o terminal como estava ao sair. */
export async function runTui(): Promise<void> {
  process.stdout.write(ALT_SCREEN_ON);
  const restore = () => process.stdout.write(ALT_SCREEN_OFF);
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
