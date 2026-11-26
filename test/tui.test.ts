import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { fakeCalls, HOME, makeAgent, makeFolder, ROOT, setScript, startNeoterm, type TestNeoterm, waitFor } from "./harness.ts";

const { App } = await import("../src/tui/app.ts");
const { httpApi } = await import("../src/tui/api.ts");
const { cronFromValues } = await import("../src/tui/forms.ts");
const { formKey } = await import("../src/tui/form.ts");
const { newRoutineForm } = await import("../src/tui/forms.ts");

const KEY = {
  enter: "\r",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  space: " ",
  ctrlS: "\x13",
  ctrlR: "\x12",
};

let t: TestNeoterm;
let OPENED_IN = "";
let ui: ReturnType<typeof render>;
// O que o ctrl+v encontra no clipboard: o caminho da imagem salva, ou null.
let clipboard: string | null = null;
// O que a interface pediu ao terminal sobre o mouse, e o que copiou.
const mouseCalls: boolean[] = [];
let copied = "";
const frame = () => ui.lastFrame() ?? "";
const press = async (...keys: string[]) => {
  for (const key of keys) {
    ui.stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const type = async (text: string) => {
  ui.stdin.write(text);
  await new Promise((resolve) => setTimeout(resolve, 25));
};
/** Esvazia o input: ctrl+u (o cmd+backspace do iTerm2 e do Ghostty) apaga uma palavra por vez. */
const clearInput = async () => {
  for (let step = 0; step < 12; step++) ui.stdin.write("\x15");
  await new Promise((resolve) => setTimeout(resolve, 50));
};
/** Apaga um campo de texto do formulário, um caractere por vez. */
const clearField = async (length: number) => {
  for (let step = 0; step < length; step++) ui.stdin.write("\x7f");
  await new Promise((resolve) => setTimeout(resolve, 50));
};
const seen = (pattern: RegExp | string, timeoutMs = 8000) =>
  waitFor(() => (typeof pattern === "string" ? frame().includes(pattern) : pattern.test(frame())), timeoutMs).catch(() => {
    throw new Error(`não apareceu na tela: ${pattern}\n---\n${frame()}`);
  });

before(async () => {
  t = await startNeoterm();
  await makeAgent("analista", { title: "Acompanhamento financeiro" });
  await makeAgent("dev", { title: "Implementação" });
  // A interface aberta numa pasta: um caminho relativo no formulário parte dela.
  OPENED_IN = makeFolder("aberto-aqui");
  makeFolder("aberto-aqui/codigo");
  makeFolder("aberto-aqui/docs/contratos");
  writeFileSync(join(OPENED_IN, "solto.txt"), "");
  ui = render(h(App, { api: httpApi(t.base), cwd: OPENED_IN, readClipboardImage: async () => clipboard,
    setMouse: (on: boolean) => mouseCalls.push(on),
    copyToClipboard: async (text: string) => {
      copied = text;
    },
  }));
  await seen("AGENTES");
});
after(async () => {
  ui.unmount();
  await t.close();
});

describe("a interface", () => {
  it("mostra a lateral com os agentes e abre a conversa do primeiro", async () => {
    await seen(/○ analista/);
    await seen(/○ dev/);
    await seen("+ novo agente");
    await seen(/analista\s+· Acompanhamento financeiro/);
    await seen("mensagem para analista");
  });

  it("envia uma mensagem e mostra a resposta", async () => {
    await type("quanto entrou hoje?");
    await seen("> quanto entrou hoje?");
    await press(KEY.enter);
    await seen("┃ quanto entrou hoje?");
    await seen("eco: quanto entrou hoje?");
  });

  it("mostra um spinner ao lado do nome na lateral enquanto o agente trabalha", async () => {
    setScript({ analista: "!dormir 1200\npronto" });
    await type("demora um pouco");
    await press(KEY.enter);
    await seen(/● analista [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    await seen("● pronto", 10_000);
    await seen(/○ analista\s/);
    assert.doesNotMatch(frame(), /analista [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    setScript({});
  });

  it("separa quem escreve: você num bloco com barra, o agente com um ponto", async () => {
    assert.match(frame(), /┃ quanto entrou hoje\?/);
    assert.match(frame(), /● eco: quanto entrou hoje\?/);
  });

  it("o que você manda enquanto ele responde fica embaixo, na fila, e o streaming não sai do lugar", async () => {
    setScript({ analista: ["!ferramenta Read lento.csv\n!dormir 1500\nprimeira resposta", "segunda resposta", "terceira resposta"] });
    await type("pergunta longa");
    await press(KEY.enter);
    await seen(/⎿ Read\s+lento\.csv/);
    await type("mais uma coisa");
    await press(KEY.enter);
    await type("e outra");
    await press(KEY.enter);
    // Uma fila só, com as mensagens numeradas.
    await seen(/┃ pergunta longa[\s\S]*⎿ Read\s+lento\.csv[\s\S]*trabalhando…[\s\S]*┃ na fila\s*│?\s*\n.*┃ 1\. mais uma coisa\s*│?\s*\n.*┃ 2\. e outra/);
    assert.equal(frame().match(/na fila/g)?.length, 1);
    await seen("● terceira resposta", 15_000);
    assert.match(frame(), /● primeira resposta[\s\S]*┃ mais uma coisa[\s\S]*● segunda resposta[\s\S]*┃ e outra[\s\S]*● terceira resposta/);
    assert.doesNotMatch(frame(), /na fila/);
    setScript({});
  });

  it("mostra as ferramentas usadas, inclusive as negadas", async () => {
    await type("!ferramenta Read extratos.csv");
    await press(KEY.enter);
    await seen(/⎿ Read\s+extratos\.csv/);
  });

  it("imagem colada aparece como [imagem N] e vai com o caminho para o agente", async () => {
    const folder = makeFolder("prints");
    const first = join(folder, "tela 1.png");
    const second = join(folder, "tela2.jpg");
    writeFileSync(first, "");
    writeFileSync(second, "");
    await type("olha");
    await press(`\x1b[200~${first.replace(/ /g, "\\ ")}\x1b[201~`);
    await seen("> olha [imagem 1]");
    await press(`\x1b[200~'${second}'\x1b[201~`);
    await seen("> olha [imagem 1] [imagem 2]");
    assert.ok(!frame().includes(folder));
    // O backspace apaga o token inteiro.
    await press("\x7f", "\x7f");
    await type("e essa");
    await seen("> olha [imagem 1] e essa");
    await press(KEY.enter);
    await seen("┃ olha [imagem 1] e essa");
    await waitFor(() => fakeCalls().some((call) => call.prompt.includes(`[imagem 1: ${first}] e essa`)));
  });

  it("ctrl+v cola a imagem do clipboard; colagem vazia também", async () => {
    const saved = join(makeFolder("clip"), "print.png");
    clipboard = saved;
    await type("veja");
    await press("\x16");
    await seen("> veja [imagem 1]");
    // Terminais que mandam uma colagem vazia quando o clipboard só tem imagem.
    await press("\x1b[200~\x1b[201~");
    await seen("> veja [imagem 1] [imagem 2]");
    clipboard = null;
    await press("\x16");
    await seen("nenhuma imagem no clipboard");
    await press(KEY.enter);
    await waitFor(() => fakeCalls().some((call) => call.prompt.includes(`veja [imagem 1: ${saved}] [imagem 2: ${saved}]`)));
    await seen("┃ veja [imagem 1] [imagem 2]");
  });

  it("texto colado que não é imagem entra como texto, com as quebras de linha", async () => {
    await press("\x1b[200~linha um\r\nlinha dois\x1b[201~");
    await seen(/> linha um\s*\n.*│\s+linha dois/);
    await clearInput();
  });

  it("shift+enter, option+enter e ctrl+j quebram a linha; enter envia tudo", async () => {
    await type("um");
    await press("\x1b[13;2u");
    await type("dois");
    await press("\x1b\r");
    await type("tres");
    await press("\n");
    await type("quatro");
    await seen(/> um\s*\n.*│\s+dois\s*\n.*│\s+tres\s*\n.*│\s+quatro/);
    await press(KEY.enter);
    await waitFor(() => fakeCalls().some((call) => call.prompt.includes("um\ndois\ntres\nquatro")));
    await seen(/┃ um\s*\n.*┃ dois/);
  });

  it("cmd+backspace, option+backspace e ctrl+w apagam a palavra inteira", async () => {
    await type("um dois tres quatro cinco");
    await press("\x15"); // cmd+backspace no iTerm2 e no Ghostty
    await seen(/> um dois tres quatro *$/m);
    await press("\x1b[127;9u"); // cmd+backspace com o protocolo kitty
    await seen(/> um dois tres *$/m);
    await press("\x1b\x7f"); // option+backspace
    await seen(/> um dois *$/m);
    await press("\x17"); // ctrl+w
    await seen(/> um *$/m);
    await clearInput();
  });

  it("as setas andam pelo texto do input", async () => {
    await type("abc");
    await press(KEY.left, KEY.left);
    await type("X");
    await seen("> aXbc");
    await press("\x1b[H"); // home
    await type("[");
    await press("\x1b[F"); // end
    await type("]");
    await seen("> [aXbc]");
    // ↑ com texto anda pelas linhas, não troca de agente.
    await press("\x1b\r");
    await type("fim");
    await press(KEY.up);
    await type("!");
    await seen("> [aX!bc]");
    assert.match(frame(), /analista\s+· Acompanhamento financeiro/);
    await clearInput();
  });

  it("a roda do mouse rola a conversa, e não a lateral", async () => {
    setScript({ analista: Array.from({ length: 60 }, (_, line) => `linha ${line + 1}`).join("\n") });
    await type("manda um texto longo");
    await press(KEY.enter);
    await seen("linha 60");
    assert.doesNotMatch(frame(), /linha 40\s/);
    // Cada giro da roda sobe 3 linhas: 5 giros escondem o fim e mostram o que estava acima.
    for (let step = 0; step < 5; step++) await press("\x1b[<64;60;10M");
    await seen(/linha 40\s/);
    assert.doesNotMatch(frame(), /linha 60/);
    // Até o começo da conversa.
    for (let step = 0; step < 60; step++) await press("\x1b[<64;60;10M");
    await seen("┃ quanto entrou hoje?");
    assert.match(frame(), /○ analista/);
    assert.match(frame(), /analista\s+· Acompanhamento financeiro/);
    for (let step = 0; step < 60; step++) await press("\x1b[<65;60;10M");
    await seen("linha 60");
    setScript({});
  });

  it(":path abre o navegador de arquivos do escopo e põe o caminho escolhido no input", async () => {
    const root = (await t.neoterm.state()).agents.find((agent) => agent.slug === "analista")!.folders[0]!;
    mkdirSync(join(root, "docs", "contratos"), { recursive: true });
    writeFileSync(join(root, "docs", "contratos", "acordo.pdf"), "");
    writeFileSync(join(root, "docs", "leia-me.md"), "");
    writeFileSync(join(root, ".segredo"), "");
    await type(":path");
    await press(KEY.enter);
    await seen("ARQUIVOS");
    await seen("▸ docs/");
    assert.doesNotMatch(frame(), /\.segredo/);
    // . mostra os ocultos; de novo, esconde.
    await type(".");
    await seen(".segredo");
    await type(".");
    await waitFor(() => !frame().includes(".segredo"));
    // l entra na pasta, / filtra, enter abre.
    await type("l");
    await seen(/ARQUIVOS · .*docs/);
    await seen("leia-me.md");
    await type("/");
    await type("contr");
    await seen("/contr");
    await press(KEY.enter);
    await seen("acordo.pdf");
    // h sobe; não passa da pasta do agente.
    await type("h");
    await seen("leia-me.md");
    for (const _ of [1, 2, 3]) await type("h");
    await seen("▸ docs/");
    // De volta e escolhendo o arquivo: entra no input, relativo à pasta do agente.
    await type("l");
    await seen("leia-me.md");
    await type("j");
    await press(KEY.enter);
    await waitFor(() => !frame().includes("ARQUIVOS"));
    await seen("> docs/leia-me.md");
    await clearInput();
    // No fim de uma mensagem começada: abre sem enviar, e o arquivo entra depois do texto.
    await type("compare com :path");
    await press(KEY.enter);
    await seen("ARQUIVOS");
    await type("l");
    await seen("leia-me.md");
    await type("j");
    await press(KEY.enter);
    await seen("> compare com docs/leia-me.md");
    assert.doesNotMatch(frame(), /┃ compare com/);
    await clearInput();
  });

  it(":notes abre as notas do agente à direita, edita e salva no notas.txt", async () => {
    const file = join(HOME, "agents", "analista", "notas.txt");
    await type(":notes");
    await press(KEY.enter);
    await seen("NOTAS");
    await seen("escreva aqui");
    await seen(/conversa[\s\S]*│ NOTAS|NOTAS/);
    await type("cliente prefere pix");
    await press(KEY.enter); // nas notas o enter quebra a linha
    await type("fechar dia 30");
    await seen("cliente prefere pix");
    await waitFor(() => existsSync(file) && readFileSync(file, "utf8") === "cliente prefere pix\nfechar dia 30");
    await seen("· salvo");
    // As notas ficam à direita da conversa, na mesma linha da tela.
    assert.match(frame(), /eco: .*│ cliente prefere pix|│ cliente prefere pix/);
    // tab volta à conversa com as notas abertas; o que se digita vai para o input.
    await press(KEY.tab);
    await type("oi");
    await seen("> oi");
    await clearInput();
    await type(":notes");
    await press(KEY.enter);
    await press("\x1b[127;9u"); // cmd+backspace apaga a palavra
    await waitFor(() => readFileSync(file, "utf8") === "cliente prefere pix\nfechar dia ");
    // esc fecha as notas.
    await press(KEY.escape);
    await waitFor(() => !frame().includes("NOTAS"));
    await seen("mensagem para analista");
    // Abrindo de novo, o texto volta do arquivo.
    await type(":notes");
    await press(KEY.enter);
    await seen("fechar dia");
    await press(KEY.escape);
  });

  it("o painel abre com :dash e com d na lateral, e resume o neoterm", async () => {
    await type(":dash");
    await press(KEY.enter);
    await seen(/painel .*atualizado/);
    await seen("MOTOR");
    await seen("MÁQUINA");
    // j rola o painel até a tabela dos agentes, que fica abaixo da dobra numa tela pequena.
    assert.doesNotMatch(frame(), /analista\s+livre/);
    for (let step = 0; step < 30; step++) ui.stdin.write("j");
    await seen(/analista\s+livre/);
    // esc vai para a lateral; d abre de novo de qualquer item.
    await press(KEY.escape);
    await press(KEY.up);
    await seen("mensagem para");
    await type("d");
    await seen("MOTOR");
    // De volta à conversa: esc vai para a lateral e o topo dela é o primeiro agente.
    await press(KEY.escape);
    for (let step = 0; step < 12; step++) ui.stdin.write(KEY.up);
    await seen(/▌○ analista/);
    await press(KEY.enter);
    await seen("mensagem para analista");
  });

  it(":mcp abre a tela de integrações, só para ver, sem tokens", async () => {
    await type(":mcp");
    await press(KEY.enter);
    await seen(/integrações .*MCP, pelo Claude Code/);
    await seen("CONECTADAS (1)");
    await seen("Google Drive");
    await seen("drivemcp.googleapis.com");
    await seen("PRECISAM DE AUTENTICAÇÃO (1)");
    await seen("ainda não usam estas integrações");
    assert.doesNotMatch(frame(), /segredo/);
    // De volta à conversa.
    await press(KEY.escape);
    for (let step = 0; step < 12; step++) ui.stdin.write(KEY.up);
    await seen(/▌○ analista/);
    await press(KEY.enter);
    await seen("mensagem para analista");
  });

  it("desenha o markdown das respostas: negrito, código, títulos e listas, sem os símbolos", async () => {
    setScript({ analista: "## Resumo\nIsto **não foi feito**: veja `src/app.ts`.\n- primeiro item\n```\nconst x = 1;\n```" });
    await type("resume");
    await press(KEY.enter);
    await seen("Isto não foi feito: veja src/app.ts.");
    assert.doesNotMatch(frame(), /\*\*não/);
    assert.doesNotMatch(frame(), /## Resumo|```/);
    assert.match(frame(), /Resumo/);
    assert.match(frame(), /• primeiro item/);
    assert.match(frame(), /const x = 1;/);
    setScript({});
  });

  it(":processos mostra o que o agente deixou rodando e encerra com x confirmado", async () => {
    setScript({ analista: "!servico 60000" });
    await type("sobe um servidor");
    await press(KEY.enter);
    await seen(/● servico \d+/);
    const pid = Number(/servico (\d+)/.exec(frame())?.[1]);
    setScript({});
    // A memória e o serviço aparecem no cabeçalho.
    await seen(/◆ 1 serviço/, 10_000);
    await type(":processos");
    await press(KEY.enter);
    await seen(/processos · analista/);
    await seen("deixado rodando");
    await press(KEY.down);
    await type("x");
    await seen("Aperte x de novo");
    await type("x");
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await seen("Nada rodando por este agente agora.");
    await press(KEY.escape);
    await seen("mensagem para analista");
  });

  it(":ajuda abre a tela de ajuda; os comandos aceitam : e /", async () => {
    await type(":ajuda");
    await press(KEY.enter);
    await seen(/ajuda .*esc volta/);
    await seen(":notas");
    await seen("TECLAS · CONVERSA");
    await press(KEY.escape);
    await seen("mensagem para analista");
    // /ps é o mesmo que :processos.
    await type("/ps");
    await press(KEY.enter);
    await seen(/processos · analista/);
    await press(KEY.escape);
    await seen("mensagem para analista");
  });

  it("cancelar um formulário aberto pela lateral volta para a lateral", async () => {
    await press(KEY.escape);
    await type("n");
    await seen("novo agente ·");
    await press(KEY.escape);
    await seen("g grupo · ? ajuda");
    // A tecla seguinte é da lateral, não vai para o texto da mensagem.
    await type("?");
    await seen(/ajuda .*esc volta/);
    await press(KEY.escape);
    await seen("g grupo · ? ajuda");
    for (let step = 0; step < 12; step++) ui.stdin.write(KEY.up);
    await seen(/▌○ analista/);
    await press(KEY.enter);
    await seen("mensagem para analista");
    assert.doesNotMatch(frame(), /> [n?]\s/);
  });

  it(":config troca a cor de destaque com prévia, salva, e aceita uma cor personalizada", async () => {
    await type(":config");
    await press(KEY.enter);
    await seen(/config .*config\.json/);
    await seen("COR DE DESTAQUE");
    await seen(/azul\s+#7CC4E8\s+✓ em uso/);
    // ↓ só mostra a prévia; enter salva.
    await press(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
    await press(KEY.enter);
    await seen("cor salva: #F5A76C");
    assert.equal((await t.api<{ accent?: string }>("/settings")).body.accent, "#F5A76C");
    await seen(/laranja\s+#F5A76C\s+✓ em uso/);
    // Personalizada: digita e aplica; inválida avisa.
    for (let step = 0; step < 5; step++) await press(KEY.down);
    await press(KEY.enter);
    await type("12");
    await press(KEY.enter);
    await seen("use uma cor no formato #RRGGBB");
    await type("3456");
    await press(KEY.enter);
    await seen("cor salva: #123456");
    // Modelo padrão com ←→ (o de teste começa em haiku; ← vai para sonnet).
    await press(KEY.down);
    await press(KEY.left);
    await seen("modelo padrão: sonnet");
    assert.equal((await t.api<{ defaultModel: string }>("/settings")).body.defaultModel, "claude-sonnet-5-5");
    await t.api("/settings", { method: "PATCH", body: { accent: null, defaultModel: "claude-haiku-5-5" } });
    await press(KEY.escape);
    for (let step = 0; step < 14; step++) ui.stdin.write(KEY.up);
    await seen(/▌○ analista/);
    await press(KEY.enter);
    await seen("mensagem para analista");
  });

  it("ctrl+n abre as notas; ctrl+t faz tarefas; ctrl+p fixa ao lado; a lateral lembra", async () => {
    const file = join(HOME, "agents", "analista", "notas.txt");
    writeFileSync(file, "");
    await press("\x0e"); // ctrl+n
    await seen("NOTAS");
    await type("ligar pro cliente");
    await press("\x14"); // ctrl+t: vira tarefa
    await press(KEY.enter);
    await type("mandar o resumo");
    await press("\x14");
    await press(KEY.up);
    await press("\x14"); // marca a primeira como feita
    await waitFor(() => readFileSync(file, "utf8") === "- [x] ligar pro cliente\n- [ ] mandar o resumo");
    await seen("1/2 feitas");
    // Fora da linha do cursor, as tarefas aparecem desenhadas.
    await press("\x0e"); // volta à conversa
    await seen("☑ ligar pro cliente");
    await seen("☐ mandar o resumo");
    // Lembrete na lateral: 1 tarefa aberta.
    await seen(/analista ☐1/);
    // Fixar: trocando de agente, as notas continuam abertas (as do outro).
    await press("\x0e");
    await press("\x10"); // ctrl+p
    await seen("notas fixadas");
    await press("\x0e");
    await press(KEY.down);
    await seen(/dev\s+· Implementação/);
    await seen("NOTAS · fixadas");
    await press(KEY.up);
    await seen("☐ mandar o resumo");
    assert.equal((await t.api<{ notesPinned?: boolean }>("/settings")).body.notesPinned, true);
    // Soltar e fechar.
    await press("\x0e");
    await press("\x10");
    await seen("notas soltas");
    await press(KEY.escape);
    await waitFor(() => !frame().includes("NOTAS"));
    // Fechadas, o cabeçalho lembra das tarefas abertas.
    await seen(/☐ 1 tarefa \(ctrl\+n\)/);
    writeFileSync(file, "");
    await t.api("/agents/analista/notes", { method: "PUT", body: { text: "" } });
  });

  it("ctrl+s entra no modo seleção (desliga a captura do mouse); ↑↓ rolam sem trocar de agente; esc volta", async () => {
    mouseCalls.length = 0;
    await press("\x13");
    await seen("MODO SELEÇÃO");
    assert.deepEqual(mouseCalls, [false]);
    await press(KEY.down);
    assert.match(frame(), /analista\s+· Acompanhamento financeiro/);
    await press(KEY.escape);
    await waitFor(() => !frame().includes("MODO SELEÇÃO"));
    assert.deepEqual(mouseCalls, [false, true]);
    await seen("mensagem para analista");
    // :selecionar também.
    await type(":selecionar");
    await press(KEY.enter);
    await seen("MODO SELEÇÃO");
    await press(KEY.escape);
    await waitFor(() => !frame().includes("MODO SELEÇÃO"));
  });

  it("ctrl+y copia a última resposta do agente", async () => {
    setScript({ analista: "Resposta **para** copiar." });
    await type("me dá algo");
    await press(KEY.enter);
    await seen("Resposta para copiar.");
    setScript({});
    await press("\x19");
    await seen("última resposta copiada");
    assert.equal(copied, "Resposta **para** copiar.");
  });

  it("troca de agente com ↑↓ quando não há texto", async () => {
    await press(KEY.down);
    await seen(/dev\s+· Implementação/);
    await press(KEY.up);
    await seen(/analista\s+· Acompanhamento financeiro/);
  });

  it("cria um agente pelo formulário", async () => {
    await press(KEY.escape);
    await seen("g grupo · ? ajuda");
    await type("n");
    await seen("novo agente");
    await type("revisor");
    await press(KEY.tab);
    await type("Revisão de código");
    await press(KEY.tab);
    // Um texto longo colado na função não invade os outros campos: mostra o fim e o tamanho.
    const role = `${Array.from({ length: 40 }, (_, n) => `Regra ${n + 1}: revisar com cuidado.`).join(" ")} Revisa o código antes de cada entrega.`;
    await type(role);
    await seen("caracteres · 1 linha");
    await seen("antes de cada entrega.");
    assert.doesNotMatch(frame(), /Regra 1:/);
    await seen(/Pastas\s+nenhuma ainda/);
    await press(KEY.tab);
    // O campo de pastas abre a lista ao lado, na pasta de onde a interface foi aberta, só com pastas.
    await seen("PASTAS");
    await seen("▸ codigo/");
    await seen("▸ docs/");
    assert.doesNotMatch(frame(), /solto\.txt/);
    // Salvar sem pasta não dá.
    await press(KEY.ctrlS);
    await seen("escolha pelo menos uma pasta");
    // espaço escolhe a pasta selecionada; enter e → entram; ← sobe; dá para escolher várias.
    await type(" ");
    await seen(/Pastas\s+✓ .*codigo/);
    await press(KEY.down);
    await press(KEY.enter);
    await seen("▸ contratos/");
    await type(" ");
    await seen(/✓ contratos\//);
    await press(KEY.left);
    await seen("▸ docs/");
    // espaço de novo desmarca.
    await press(KEY.up);
    await type(" ");
    await waitFor(() => !/✓ .*codigo/.test(frame()));
    await type(" ");
    // esc fecha a lista e fica o que foi escolhido; → abre de novo.
    await press(KEY.escape);
    await waitFor(() => !frame().includes("PASTAS"));
    await seen(/Pastas\s+✓ .*contratos/);
    await seen(/Pastas[\s\S]*✓ .*codigo/);
    await seen("novo agente");
    await press(KEY.right);
    await seen("PASTAS");
    await press(KEY.ctrlS);
    await seen(/○ revisor/);
    const { status, body } = await t.api<{ agent: { folders: string[] } }>("/agents/revisor");
    assert.equal(status, 200);
    assert.deepEqual(body.agent.folders, [realpathSync(join(OPENED_IN, "docs", "contratos")), realpathSync(join(OPENED_IN, "codigo"))]);
    const created = await t.api<{ agent: { role: string } }>("/agents/revisor");
    assert.equal(created.body.agent.role, role);
  });

  it("pausa e retoma pela lateral", async () => {
    await waitFor(() => frame().includes("revisor"));
    await press(KEY.escape);
    // Volta ao primeiro agente e pausa.
    await press(KEY.up, KEY.up, KEY.up, KEY.up);
    await type("p");
    await seen(/‖ analista/);
    await type("p");
    await seen(/○ analista/);
  });

  it("cria um grupo, conversa nele e os agentes se chamam", async () => {
    const folder = join(ROOT, "proj");
    mkdirSync(folder, { recursive: true });
    setScript({ analista: "Vou checar os números. @dev prepara a planilha.", dev: "Planilha pronta." });
    await t.api("/groups", { body: { slug: "fechamento", folder, members: ["analista", "dev"] } });
    await seen("GRUPOS");
    await seen("# fechamento");
    const index = (await t.neoterm.state()).agents.length;
    await press(KEY.up, KEY.up, KEY.up, KEY.up, KEY.up);
    for (let step = 0; step < index; step++) await press(KEY.down);
    await press(KEY.enter);
    await seen("mensagem para o grupo");
    await type("fechem o mês");
    await press(KEY.enter);
    await seen("Planilha pronta.", 15_000);
    assert.match(frame(), /analista\s+\d\d:\d\d/);
    assert.match(frame(), /@dev/);
    setScript({});
  });

  it("abre as rotinas do grupo e cria uma pelo formulário", async () => {
    await press(KEY.ctrlR);
    await seen("nenhuma rotina");
    await type("n");
    await seen("nova rotina");
    // Agente (escolha) → O que fazer
    await press(KEY.tab);
    await type("conferir o caixa");
    await press(KEY.tab, KEY.right); // dias úteis → toda semana
    await seen("Dia");
    await press(KEY.ctrlS);
    await seen(/● conferir-o-caixa/);
    const { body } = await t.api<{ routines: { title: string; group: string; cron: string }[] }>("/routines");
    const created = body.routines.find((routine) => routine.title === "conferir-o-caixa");
    assert.equal(created?.group, "fechamento");
    assert.equal(created?.cron, "0 9 * * 1");
    await press(KEY.escape);
  });

  it("mostra o que precisa de você", async () => {
    const created = await t.api<{ routine: { id: string } }>("/routines", {
      body: { agent: "dev", title: "quebra", instruction: "!falhar sem acesso ao servidor", cron: "0 9 * * *" },
    });
    await t.api(`/routines/${created.body.routine.id}/run`, { body: {} });
    await seen("PRECISA DE VOCÊ");
    await seen(/! rotina quebra falhou/);
  });

  it("edita o agente com e na lateral: título, função em várias linhas e modelo", async () => {
    await press(KEY.escape);
    for (let step = 0; step < 12; step++) ui.stdin.write(KEY.up);
    await seen(/▌○ analista/);
    await type("e");
    await seen("editar analista");
    // Começa preenchido com o que está no AGENT.md.
    await seen(/Título\s+Acompanhamento financeiro/);
    await clearField(30);
    await type("Financeiro e fechamento");
    await press(KEY.tab);
    // Na função, enter quebra a linha.
    await press(KEY.enter);
    await type("Fecha o mês todo dia 30.");
    await press(KEY.tab, KEY.tab);
    await press(KEY.right); // modelo: opus
    await press(KEY.ctrlS);
    await seen("analista atualizado");
    const { body } = await t.api<{ agent: { title: string; role: string; model?: string } }>("/agents/analista");
    assert.equal(body.agent.title, "Financeiro e fechamento");
    assert.match(body.agent.role, /\nFecha o mês todo dia 30\.$/);
    assert.equal(body.agent.model, "claude-opus-5-5");
    await seen(/analista\s+· Financeiro e fechamento/);
  });

  it("no campo de pastas, o primeiro esc fecha a lista e o segundo cancela o formulário", async () => {
    await press(KEY.escape);
    await type("n");
    await seen("novo agente");
    await press(KEY.tab, KEY.tab, KEY.tab);
    await seen("PASTAS");
    await seen("espaço escolhe");
    await press(KEY.escape);
    await waitFor(() => !frame().includes("PASTAS"));
    await seen("novo agente");
    await press(KEY.escape);
    await waitFor(() => !frame().includes("novo agente ·"));
  });

  it("cria um grupo pelo formulário, escolhendo uma pasta só na lista", async () => {
    await press(KEY.escape);
    await type("g");
    await seen("novo grupo");
    await type("revisao");
    await press(KEY.tab);
    await seen("PASTAS");
    await seen("▸ codigo/");
    // Sem pasta, não salva.
    await press(KEY.ctrlS);
    await seen("escolha a pasta do projeto");
    // espaço escolhe; escolher outra troca a anterior (o grupo tem uma pasta só).
    await type(" ");
    await seen(/Pasta\s+✓ .*codigo/);
    await press(KEY.down);
    await type(" ");
    await seen(/Pasta\s+✓ .*docs/);
    assert.doesNotMatch(frame(), /✓ .*codigo/);
    // esc fecha a lista com a pasta escolhida; o segundo esc já cancelaria o formulário.
    await press(KEY.escape);
    await waitFor(() => !frame().includes("PASTAS"));
    await seen("novo grupo");
    await press(KEY.tab);
    await type(" ");
    await press(KEY.ctrlS);
    await seen("# revisao");
    const group = (await t.neoterm.state()).groups.find((entry) => entry.slug === "revisao");
    assert.equal(group?.folder, realpathSync(join(OPENED_IN, "docs")));
  });

  it("edita um grupo com :editar e exclui grupo e agente com ctrl+d confirmado", async () => {
    // Logo depois de criado, a conversa aberta é a do #revisao.
    await seen("mensagem para o grupo");
    await type(":editar");
    await press(KEY.enter);
    await seen("editar #revisao");
    await seen(/Pasta\s+✓ .*docs/);
    await press(KEY.escape); // fecha a lista de pastas
    await press(KEY.tab);
    // Membros: marca o dev também.
    await press(KEY.right);
    await type(" ");
    await press(KEY.ctrlS);
    await seen("#revisao atualizado");
    assert.deepEqual((await t.neoterm.state()).groups.find((group) => group.slug === "revisao")?.members.toSorted(), ["analista", "dev"]);

    // ctrl+d pede confirmação; outra tecla desiste.
    await type(":editar");
    await press(KEY.enter);
    await seen("editar #revisao");
    await press("\x04");
    await seen("Aperte ctrl+d de novo");
    await type("x");
    await waitFor(() => !frame().includes("Aperte ctrl+d de novo"));
    await seen("ctrl+d exclui o grupo");
    await press("\x04", "\x04");
    await seen("#revisao excluído");
    await waitFor(() => !frame().includes("# revisao"));
    assert.ok(!(await t.neoterm.state()).groups.some((group) => group.slug === "revisao"));

    // Um agente: e na lateral, ctrl+d duas vezes; vai para a lixeira.
    await press(KEY.escape);
    for (let step = 0; step < 12; step++) ui.stdin.write(KEY.up);
    await seen(/▌○ analista/);
    await press(KEY.down, KEY.down);
    await seen(/▌○ revisor/);
    await type("e");
    await seen("editar revisor");
    await press("\x04");
    await seen("Aperte ctrl+d de novo");
    await seen("ctrl+d de novo exclui");
    await press("\x04");
    await seen("revisor excluído");
    await waitFor(() => !/○ revisor/.test(frame()));
    assert.ok(!(await t.neoterm.state()).agents.some((agent) => agent.slug === "revisor"));
  });
});

describe("formulário de rotina", () => {
  it("monta o cron das escolhas", () => {
    assert.equal(cronFromValues({ frequency: "daily", time: "18:30" }), "30 18 * * *");
    assert.equal(cronFromValues({ frequency: "weekdays", time: "09:00" }), "0 9 * * 1-5");
    assert.equal(cronFromValues({ frequency: "weekly", time: "17:00", weekday: "5" }), "0 17 * * 5");
    assert.equal(cronFromValues({ frequency: "monthly", time: "08:00", day: "1" }), "0 8 1 * *");
    assert.equal(cronFromValues({ frequency: "cron", cron: "*/30 * * * *" }), "*/30 * * * *");
    assert.throws(() => cronFromValues({ frequency: "daily", time: "25:00" }), /09:00/);
  });

  it("mostra a próxima execução e recusa o que roda rápido demais", () => {
    const form = newRoutineForm(httpApi("http://127.0.0.1:1"), { kind: "agent", slug: "x" }, [], "America/Sao_Paulo", () => {});
    const values = { instruction: "x", frequency: "cron", cron: "*/5 * * * *", mode: "act", title: "" };
    assert.match(form.preview?.(values) ?? "", /15 minutos/);
    assert.match(form.preview?.({ ...values, cron: "0 9 * * 1-5" }) ?? "", /^próxima: .* · seg–sex 09:00/);
  });

  it("campos escondidos ficam fora da navegação", () => {
    let form = newRoutineForm(httpApi("http://127.0.0.1:1"), { kind: "agent", slug: "x" }, [], "America/Sao_Paulo", () => {});
    const step = (input: string, key: Record<string, boolean> = {}) => {
      const action = formKey(form, input, key);
      if (action.type === "state") form = action.form;
      return action;
    };
    step("", { tab: true }); // O que fazer → Quando
    assert.equal(form.fields[form.index]?.key, "frequency");
    step("", { tab: true }); // dias úteis: pula Dia e Dia do mês
    assert.equal(form.fields[form.index]?.key, "time");
  });
});
