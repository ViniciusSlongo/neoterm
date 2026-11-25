import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { USER_FILE, isMissingFile } from "../config.ts";
import { type AgentDefinition, MEMORY_FILE } from "./identity.ts";

/*
 * O que vai junto do prompt de sistema do Claude Code em cada turno (`--append-system-prompt`).
 * Cada parte numa tag própria, no espírito do OpenBot: identidade, função, onde trabalha, o que
 * sabe de você, a própria memória, se tem alguém olhando e que dia é hoje.
 */

export type RunMode = "interactive" | "unattended";

export type PromptContext = {
  mode: RunMode;
  now: Date;
  timeZone: string;
  /** Uma rotina que só avisa: verifica e informa, sem mudar nada. */
  readOnly?: boolean;
  /** Tem as ferramentas do neoterm (rotinas, retornos, memória). */
  neotermTools?: boolean;
  /** Contexto a mais, como o do grupo em que está. */
  extra?: string;
};

export async function buildSystemPrompt(
  agent: AgentDefinition,
  context: PromptContext,
): Promise<string> {
  const [aboutPerson, memory] = await Promise.all([
    readOptional(USER_FILE),
    readOptional(join(agent.dir, MEMORY_FILE)),
  ]);
  return renderSystemPrompt(agent, context, { aboutPerson, memory });
}

export function renderSystemPrompt(
  agent: AgentDefinition,
  context: PromptContext,
  files: { aboutPerson?: string; memory?: string },
): string {
  const named = agent.title ? `${agent.name}, ${agent.title}` : agent.name;
  const sections = [
    tag(
      "identity",
      `Você é ${named}. Quem fala com você te chama de "${agent.name}". Um pedido para ${agent.name} é um pedido para você: responda você mesmo.`,
    ),
    tag(
      "role",
      `${agent.role}\n\nSua função vale em toda conversa, e cada mensagem diz a tarefa dentro dela. O que a pessoa diz na conversa vem antes do que estiver na sua memória. Responda no idioma da pessoa.`,
    ),
    tag("workspace", workspaceText(agent)),
    context.extra ? context.extra.trim() : "",
    files.aboutPerson ? tag("about_the_person", files.aboutPerson) : "",
    files.memory ? tag("memory", files.memory) : "",
    context.neotermTools ? tag("neoterm_tools", toolsText()) : "",
    tag("run_mode", runModeText(context.mode, context.readOnly)),
    tag("today", `Hoje é ${formatDate(context.now, context.timeZone)} (fuso ${context.timeZone}).`),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function workspaceText(agent: AgentDefinition): string {
  if (agent.folders.length === 0) return `Sua pasta de trabalho é ${agent.workspace}.`;
  const lines = ["Seu escopo são estas pastas do computador. Trabalhe só dentro delas:"];
  for (const folder of agent.folders) {
    lines.push(`- ${folder}`);
  }
  return lines.join("\n");
}

function runModeText(mode: RunMode, readOnly = false): string {
  const base =
    mode === "interactive"
      ? "A pessoa está acompanhando esta conversa agora."
      : "Ninguém está acompanhando agora: você está trabalhando sozinho. Se faltar algo que só a pessoa resolve, diga o que faltou e siga com o que der.";
  return `${base}${readOnly ? "\nEsta execução só avisa: leia, verifique e informe, sem mudar nada." : ""}`;
}

function toolsText(): string {
  const lines = [
    "Além das ferramentas de trabalho, você tem as do neoterm (mcp__neoterm__*):",
    "- create_routine, list_routines, update_routine, delete_routine: quando a pessoa pedir algo recorrente (\"todo dia\", \"toda sexta às 17h\"), crie uma rotina em vez de só prometer. Diga em palavras quando ela vai rodar.",
    "- schedule_followup: para voltar a esta conversa sozinho daqui a um tempo.",
    "- remember e forget: para fatos duráveis sobre a pessoa ou o trabalho, não para o que só vale agora.",
  ];
  return lines.join("\n");
}

function formatDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone }).format(now);
}

function tag(name: string, content: string): string {
  return `<${name}>\n${content.trim()}\n</${name}>`;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text || undefined;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}
