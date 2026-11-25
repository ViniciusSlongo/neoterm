import { agentKey, type Core } from "../core.ts";
import { messages } from "../db/schema.ts";
import type { TurnEvent } from "../events.ts";
import type { TurnOutcome } from "../runner/turn.ts";
import { conversationSession, ensureAgentRow, mainConversation, withNotices } from "../store/conversations.ts";
import { loadAgent } from "./identity.ts";

/**
 * A pessoa escreve para um agente. Roda mesmo com o agente pausado: pausar segura o que ele faz
 * sozinho (rotinas, retornos, chamadas de colegas), não a conversa com quem está ali.
 */
export async function chatWithAgent(
  core: Core,
  slug: string,
  text: string,
  onEvent?: (event: TurnEvent) => void,
): Promise<TurnOutcome> {
  const agent = await loadAgent(slug);
  return core.engine.queue.run([agentKey(slug)], async () => {
    const row = await ensureAgentRow(core.db, slug);
    const conversation = await mainConversation(core.db, row.id);
    const prompt = await withNotices(core.db, conversation.id, row.id, text);
    await core.db.insert(messages).values({ conversationId: conversation.id, author: "person", text });
    core.bus.changed("messages", { kind: "agent", slug });
    return core.engine.execute({
      agent: await loadAgent(slug),
      agentRow: row,
      conversationId: conversation.id,
      scope: { kind: "agent", slug },
      trigger: "chat",
      mode: "interactive",
      prompt,
      cwd: agent.workspace,
      session: conversationSession(core.db, conversation),
      ...(onEvent ? { onEvent } : {}),
    });
  });
}
