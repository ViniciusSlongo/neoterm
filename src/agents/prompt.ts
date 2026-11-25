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
    files.aboutPerson ? tag("about_the_person", files.aboutPerson) : "",
    files.memory ? tag("memory", files.memory) : "",
    tag("run_mode", runModeText(context.mode)),
    tag("today", `Hoje é ${formatDate(context.now, context.timeZone)} (fuso ${context.timeZone}).`),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function workspaceText(agent: AgentDefinition): string {
  const lines = [`Sua pasta de trabalho é ${agent.workspace}.`];
  if (agent.folders.length > 0) {
    lines.push("Você também tem acesso a:");
    for (const folder of agent.folders) {
      lines.push(`- ${folder.path} (${folder.write ? "leitura e escrita" : "só leitura: não altere nada aqui"})`);
    }
  }
  return lines.join("\n");
}

function runModeText(mode: RunMode): string {
  return mode === "interactive"
    ? "A pessoa está acompanhando esta conversa agora."
    : "Ninguém está acompanhando agora: você está trabalhando sozinho. Use só as ferramentas liberadas; se precisar de algo fora delas, diga o que faltou e por quê, em vez de tentar contornar.";
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
