import { render } from "ink";
import { createElement as h } from "react";
import { httpApi } from "./api.ts";
import { App } from "./app.ts";

/** Abre a interface em tela cheia (tela alternativa do terminal) e devolve o terminal como estava ao sair. */
export async function runTui(): Promise<void> {
  process.stdout.write("\x1b[?1049h\x1b[H");
  const instance = render(h(App, { api: httpApi() }), { exitOnCtrlC: true });
  try {
    await instance.waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?1049l");
  }
}
