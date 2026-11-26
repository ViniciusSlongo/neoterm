/*
 * Os comandos da conversa, num lugar só: quem interpreta o que foi digitado, a tela de ajuda e os
 * docs leem daqui. Funcionam com ":" ou "/" na frente (:notas e /notas são o mesmo).
 */

export type CommandName = "ajuda" | "notas" | "path" | "processos" | "editar" | "rotinas" | "pausar" | "retomar" | "painel" | "mcp";

export type Command = {
  name: CommandName;
  aliases: string[];
  /** O que faz, numa frase curta. */
  description: string;
  /** Só na conversa com um agente. */
  agentOnly?: boolean;
};

export const COMMANDS: Command[] = [
  { name: "ajuda", aliases: ["help", "?"], description: "esta tela: comandos e teclas" },
  { name: "notas", aliases: ["notes"], description: "suas anotações sobre o agente, à direita", agentOnly: true },
  { name: "path", aliases: ["arquivo"], description: "escolhe um arquivo do escopo e põe o caminho na mensagem" },
  { name: "processos", aliases: ["ps"], description: "memória e serviços que o agente deixou rodando", agentOnly: true },
  { name: "editar", aliases: ["edit"], description: "muda (ou exclui) o agente ou o grupo" },
  { name: "rotinas", aliases: ["routines"], description: "as rotinas desta conversa" },
  { name: "pausar", aliases: ["pause"], description: "pausa as rotinas e retornos do agente", agentOnly: true },
  { name: "retomar", aliases: ["resume"], description: "volta a rodar o que foi pausado", agentOnly: true },
  { name: "painel", aliases: ["dash"], description: "resumo do neoterm: motor, plano, agentes" },
  { name: "mcp", aliases: ["integracoes", "integrações"], description: "integrações do Claude Code (só ver)" },
];

/** O comando digitado (":notas", "/ps", ":?"), ou `null` se o texto é uma mensagem. */
export function parseCommand(text: string): CommandName | null {
  const match = /^[:/](\S+)$/.exec(text.trim());
  if (!match) return null;
  const word = match[1]!.toLowerCase();
  return COMMANDS.find((command) => command.name === word || command.aliases.includes(word))?.name ?? null;
}

/** As teclas, por lugar, para a tela de ajuda e os docs. */
export const KEYS: { where: string; keys: [string, string][] }[] = [
  {
    where: "conversa",
    keys: [
      ["enter", "envia"],
      ["shift+enter", "nova linha (ou option+enter, ctrl+j)"],
      ["ctrl+v", "cola uma imagem do clipboard"],
      ["cmd+backspace", "apaga a palavra"],
      ["roda do mouse, pgup/pgdn", "rolam a conversa"],
      ["↑↓ sem texto", "troca de conversa"],
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
      ["d · i", "painel · integrações"],
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
    where: "formulários",
    keys: [
      ["tab · shift+tab", "próximo · anterior"],
      ["ctrl+s", "salva"],
      ["ctrl+d duas vezes", "exclui (na edição)"],
      ["esc", "cancela"],
    ],
  },
];
