import { agentKey, type Core } from "../core.ts";
import { messages } from "../db/schema.ts";
import type { ToolCaller } from "../mcp/hub.ts";
import { conversationSession, ensureAgentRow, mainConversation } from "../store/conversations.ts";
import { AgentNotFound, AgentProblem, listAgents, loadAgent } from "./identity.ts";

/*
 * Um agente consulta outro fora de um grupo (a ferramenta ask_agent). O consultado responde num
 * turno dele, na conversa dele com a pessoa, e a resposta volta para quem perguntou.
 *
 * AS PROTEÇÕES, e por quê:
 * - Ninguém consulta a si mesmo.
 * - Quem está ocupado (num turno ou com algo na fila) ou pausado recusa na hora. Quem pergunta
 *   segura a própria fila enquanto espera; se o outro estivesse esperando por ele, os dois
 *   travariam. Recusar em vez de esperar corta isso.
 * - Sem cadeia: quem responde uma consulta não consulta mais ninguém (profundidade 1).
 * - Um tempo máximo: passado dele, quem perguntou segue, e a resposta fica na conversa do outro.
 */

export const ASK_TIMEOUT_MS = 10 * 60_000;

export class AskRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskRefused";
  }
}

export type AskResult = { answered: true; text: string } | { answered: false; reason: string };

async function others(slug: string): Promise<string> {
  const names = (await listAgents()).agents.map((agent) => agent.slug).filter((name) => name !== slug);
  return names.length ? names.join(", ") : "nenhum";
}

export async function askAgent(
  core: Core,
  caller: ToolCaller,
  to: string,
  question: string,
  options: { timeoutMs?: number } = {},
): Promise<AskResult> {
  const target = to.trim().replace(/^@/, "");
  if (target === caller.slug) throw new AskRefused("você não pode consultar a si mesmo");
  if ((caller.depth ?? 0) >= 1) {
    throw new AskRefused("você está respondendo a uma consulta de outro agente e não pode consultar mais ninguém agora; responda com o que sabe");
  }
  let agent;
  try {
    agent = await loadAgent(target);
  } catch (error) {
    if (error instanceof AgentNotFound) throw new AskRefused(`não existe agente "${target}". Os que existem: ${await others(caller.slug)}`);
    if (error instanceof AgentProblem) throw new AskRefused(`${target} está com um problema e não pode responder: ${error.message}`);
    throw error;
  }
  const row = await ensureAgentRow(core.db, agent.slug);
  if (row.pausedAt) throw new AskRefused(`${agent.slug} está pausado`);
  if (core.engine.queue.depth(agentKey(agent.slug)) > 0) {
    throw new AskRefused(`${agent.slug} está ocupado agora; tente de novo daqui a pouco (ou agende um retorno com schedule_followup)`);
  }

  const turn = core.engine.queue.run([agentKey(agent.slug)], async () => {
    const conversation = await mainConversation(core.db, row.id);
    // A pergunta fica na conversa do consultado, assinada por quem perguntou.
    await core.db.insert(messages).values({
      conversationId: conversation.id,
      author: "agent",
      agentId: caller.agentId,
      text: question,
      meta: { fromAgent: caller.slug },
    });
    core.bus.changed("messages", { kind: "agent", slug: agent.slug });
    return core.engine.execute({
      agent,
      agentRow: row,
      conversationId: conversation.id,
      scope: { kind: "agent", slug: agent.slug },
      trigger: "agent",
      mode: "unattended",
      depth: 1,
      prompt: [
        `${caller.slug}, outro agente do neoterm, te consulta pela ferramenta ask_agent:`,
        "",
        question,
        "",
        `Sua resposta volta direto para ${caller.slug}. Responda objetivamente o que ele perguntou.`,
      ].join("\n"),
      cwd: agent.workspace,
      session: conversationSession(core.db, conversation),
    });
  });

  const timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([turn, timeout]);
    if (outcome === "timeout") {
      // O turno do outro continua; a resposta vai ficar na conversa dele.
      void turn.catch(() => {});
      return { answered: false, reason: `${agent.slug} ainda está trabalhando na resposta; ela vai ficar na conversa dele com a pessoa` };
    }
    if (!outcome.ok) return { answered: false, reason: `${agent.slug} não conseguiu responder: ${outcome.error ?? "erro desconhecido"}` };
    return { answered: true, text: outcome.text };
  } finally {
    clearTimeout(timer);
  }
}
