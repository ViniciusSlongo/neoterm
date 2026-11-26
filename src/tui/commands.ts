/*
 * Os comandos da conversa, num lugar só: quem interpreta o que foi digitado, a tela de ajuda e os
 * docs leem daqui. Funcionam com ":" ou "/" na frente (:notas e /notas são o mesmo).
 */

export type CommandName = "ver" | "esforço" | "config" | "ajuda" | "notas" | "path" | "processos" | "editar" | "rotinas" | "pausar" | "retomar" | "painel" | "mcp";

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
  { name: "ajuda", aliases: ["help", "?"], description: "esta tela: comandos e teclas" },
  { name: "notas", aliases: ["notes"], description: "suas anotações sobre o agente, à direita", agentOnly: true },
  { name: "path", aliases: ["arquivo"], description: "escolhe um arquivo do escopo e põe o caminho na mensagem" },
  { name: "ver", aliases: ["abrir", "view", "open"], description: "abre um arquivo para ler, com as cores do código" },
  { name: "processos", aliases: ["ps"], description: "memória e serviços que o agente deixou rodando", agentOnly: true },
  { name: "editar", aliases: ["edit"], description: "muda (ou exclui) o agente ou o grupo" },
  { name: "rotinas", aliases: ["routines"], description: "as rotinas desta conversa" },
  { name: "pausar", aliases: ["pause"], description: "pausa as rotinas e retornos do agente", agentOnly: true },
  { name: "retomar", aliases: ["resume"], description: "volta a rodar o que foi pausado", agentOnly: true },
  { name: "painel", aliases: ["dash"], description: "resumo do neoterm: motor, plano, agentes" },
  { name: "mcp", aliases: ["integracoes", "integrações"], description: "integrações do Claude Code (só ver)" },
  { name: "config", aliases: ["cor", "tema"], description: "cor da interface e modelo padrão dos agentes" },
  {
    name: "esforço",
    aliases: ["esforco", "effort"],
    description: "esforço do agente: :esforço alto (baixo, médio, alto, muito alto, máximo, padrão)",
    agentOnly: true,
    argument: "baixo · médio · alto · muito alto · máximo · padrão",
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

/** O comando digitado (":notas", "/ps", ":?"), ou `null` se o texto é uma mensagem. */
export function parseCommand(text: string): CommandName | null {
  const match = /^[:/](\S+)$/.exec(text.trim());
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return COMMANDS.find((command) => command.name === word || command.aliases.includes(word))?.name ?? null;
}

/** O nível de esforço digitado (":esforço alto", "/effort max"): o valor do Claude Code, "" para o padrão, ou null. */
export function parseEffortCommand(text: string): { level: string | null } | null {
  const match = /^[:/](esforço|esforco|effort)(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return null;
  if (!match[2]) return { level: null };
  const fold = match[2].trim().normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, "-");
  const names: Record<string, string> = {
    padrao: "",
    default: "",
    baixo: "low",
    low: "low",
    medio: "medium",
    medium: "medium",
    alto: "high",
    high: "high",
    "muito-alto": "xhigh",
    xhigh: "xhigh",
    maximo: "max",
    max: "max",
  };
  return { level: fold in names ? names[fold]! : "?" };
}

export const EFFORT_LABEL: Record<string, string> = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo" };

/** `:ver` sozinho abre a lista de arquivos; `:ver caminho` abre o arquivo direto. */
export function parseViewCommand(text: string): { path: string | null } | null {
  const match = /^[:/](ver|abrir|view|open)(?:\s+(.+))?$/i.exec(text.trim());
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
    where: "arquivo aberto (:ver)",
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
