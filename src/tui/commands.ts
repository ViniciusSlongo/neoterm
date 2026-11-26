/*
 * Os comandos da conversa, num lugar só: quem interpreta o que foi digitado, a tela de ajuda e os
 * docs leem daqui. Funcionam com ":" ou "/" na frente (:notes e /notes são o mesmo).
 */

export type CommandName =
  | "help"
  | "notes"
  | "path"
  | "open"
  | "processes"
  | "edit"
  | "routines"
  | "pause"
  | "resume"
  | "dashboard"
  | "mcp"
  | "config"
  | "effort";

export type Command = {
  name: CommandName;
  aliases: string[];
  /** O que faz, numa frase curta. */
  description: string;
  /** Só na conversa com um agente. */
  agentOnly?: boolean;
  /** Pede um complemento (o menu escreve o comando e espera o resto): o que vai depois. */
  argument?: string;
};

export const COMMANDS: Command[] = [
  { name: "help", aliases: ["?"], description: "esta tela: comandos e teclas" },
  { name: "notes", aliases: [], description: "suas anotações sobre o agente, à direita", agentOnly: true },
  { name: "path", aliases: [], description: "escolhe um arquivo do escopo e põe o caminho na mensagem" },
  { name: "open", aliases: ["view"], description: "abre um arquivo para ler, com as cores do código" },
  { name: "processes", aliases: ["ps"], description: "memória e serviços que o agente deixou rodando", agentOnly: true },
  { name: "edit", aliases: [], description: "muda (ou exclui) o agente ou o grupo" },
  { name: "routines", aliases: [], description: "as rotinas desta conversa" },
  { name: "pause", aliases: [], description: "pausa as rotinas e retornos do agente", agentOnly: true },
  { name: "resume", aliases: [], description: "volta a rodar o que foi pausado", agentOnly: true },
  { name: "dashboard", aliases: ["dash"], description: "resumo do neoterm: motor, plano, agentes" },
  { name: "mcp", aliases: [], description: "integrações do Claude Code (só ver)" },
  { name: "config", aliases: ["settings"], description: "cor da interface e modelo padrão dos agentes" },
  {
    name: "effort",
    aliases: [],
    description: "esforço do agente: :effort high (low, medium, high, xhigh, max, default)",
    agentOnly: true,
    argument: "low · medium · high · xhigh · max · default",
  },
];

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Os comandos para o menu do ":", afunilando pelo que já foi digitado: os que começam com o texto
 * (no nome ou num apelido) e, a partir de 3 letras, os que o contêm.
 */
export function matchCommands(query: string, options: { agent: boolean }): Command[] {
  const wanted = fold(query);
  const available = COMMANDS.filter((command) => options.agent || !command.agentOnly);
  const words = (command: Command) => [command.name, ...command.aliases].map(fold);
  const starts = available.filter((command) => words(command).some((word) => word.startsWith(wanted)));
  // No meio do nome, só a partir de 3 letras: com uma ou duas, quase tudo contém.
  const contains =
    wanted.length >= 3 ? available.filter((command) => !starts.includes(command) && words(command).some((word) => word.includes(wanted))) : [];
  return [...starts, ...contains];
}

/** O comando digitado (":notes", "/ps", ":?"), ou `null` se o texto é uma mensagem. */
export function parseCommand(text: string): CommandName | null {
  const match = /^[:/](\S+)$/.exec(text.trim());
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return COMMANDS.find((command) => command.name === word || command.aliases.includes(word))?.name ?? null;
}

/** Os níveis do `:effort`: os do Claude Code, e `default` para voltar ao padrão (""). */
export const EFFORT_LEVELS: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", default: "" };

/** O nível digitado (":effort high", "/effort max"): o valor do Claude Code, "" para o padrão, "?" se não existe, ou null sem nível. */
export function parseEffortCommand(text: string): { level: string | null } | null {
  const match = /^[:/]effort(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return null;
  if (!match[1]) return { level: null };
  const word = match[1].trim().toLowerCase();
  return { level: word in EFFORT_LEVELS ? EFFORT_LEVELS[word]! : "?" };
}

export const EFFORT_LABEL: Record<string, string> = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo" };

/** `:open` sozinho abre a lista de arquivos; `:open caminho` abre o arquivo direto. */
export function parseViewCommand(text: string): { path: string | null } | null {
  const match = /^[:/](open|view)(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return null;
  const path = match[2]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { path: path || null };
}

/** As teclas, por lugar, para a tela de ajuda e os docs. */
export const KEYS: { where: string; keys: [string, string][] }[] = [
  {
    where: "conversa",
    keys: [
      ["enter", "envia"],
      ["shift+enter", "nova linha (ou option+enter, ctrl+j)"],
      ["ctrl+n", "abre as notas; abertas, alterna com a conversa"],
      ["↑↓, pgup/pgdn", "rolam a conversa"],
      ["esc", "vai para a lateral"],
    ],
  },
  {
    where: "lateral",
    keys: [
      ["↑↓ e enter", "escolhe e abre"],
      ["e", "edita o agente ou grupo"],
      ["s", "processos do agente"],
      ["r", "rotinas"],
      ["p", "pausa ou retoma"],
      ["n · g", "novo agente · novo grupo"],
      ["d · i · c", "painel · integrações · config"],
      ["?", "esta ajuda"],
      ["q", "sai (o motor continua)"],
    ],
  },
  {
    where: "listas de arquivos e pastas",
    keys: [
      ["↑↓", "anda"],
      ["→ ou enter", "entra na pasta (no :path, num arquivo, insere)"],
      ["←", "volta para a de cima"],
      ["espaço", "escolhe a pasta"],
      ["/", "filtra pelo nome"],
      ["esc", "fecha"],
    ],
  },
  {
    where: "notas",
    keys: [
      ["ctrl+t", "marca ou desmarca a tarefa da linha"],
      ["ctrl+p", "fixa ao lado: ficam abertas em todo agente"],
      ["ctrl+n, tab", "volta à conversa"],
      ["esc", "fecha (fixadas: volta à conversa)"],
    ],
  },
  {
    where: "arquivo aberto (:open)",
    keys: [
      ["↑↓, pgup/pgdn", "rolam"],
      ["←→", "rolam de lado"],
      ["g, G", "começo, fim"],
      ["/", "busca; n próxima, N anterior"],
      ["esc", "fecha"],
    ],
  },
  {
    where: "formulários",
    keys: [
      ["tab · shift+tab", "próximo · anterior"],
      ["ctrl+s", "salva"],
      ["ctrl+d duas vezes", "exclui (na edição)"],
      ["esc", "cancela"],
    ],
  },
];
