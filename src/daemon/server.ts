import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { AgentNotFound, AgentProblem, listAgents, loadAgent } from "../agents/identity.ts";
import { DAEMON_PORT } from "../config.ts";
import { applyMigrations, connect, type Database, errorMessage } from "../db/client.ts";
import type { TurnEvent } from "../runner/turn.ts";
import { Turns } from "../runner/turn.ts";
import { findAgentRow, recentMessages } from "../store/conversations.ts";

/*
 * O motor: um servidor HTTP só em 127.0.0.1, que o CLI e a interface de terminal usam. Ele é o
 * único que escreve no banco e o único que roda agentes.
 *
 * UM TURNO NÃO DEPENDE DE QUEM PEDIU. Se o terminal que mandou a mensagem fechar no meio, o agente
 * termina o que estava fazendo e a resposta fica na conversa.
 */

const NewMessage = z.object({ text: z.string().trim().min(1).max(100_000) });

export function createApp(db: Database, turns: Turns): Hono {
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AgentNotFound) return c.json({ error: error.message }, 404);
    if (error instanceof AgentProblem) return c.json({ error: error.message }, 422);
    return c.json({ error: errorMessage(error) }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, busy: turns.busy, planUsage: turns.planUsage ?? null }));

  app.get("/agents", async (c) => {
    const { agents, problems } = await listAgents();
    const busy = new Set(turns.busy);
    const rows = await Promise.all(agents.map((agent) => findAgentRow(db, agent.slug)));
    return c.json({
      agents: agents.map((agent, index) => ({
        slug: agent.slug,
        name: agent.name,
        title: agent.title,
        model: agent.model ?? null,
        state: busy.has(agent.slug) ? "running" : rows[index]?.pausedAt ? "paused" : "idle",
      })),
      problems: problems.map((problem) => ({ slug: problem.slug, error: problem.message })),
    });
  });

  app.get("/agents/:slug/messages", async (c) => {
    const agent = await loadAgent(c.req.param("slug"));
    const row = await findAgentRow(db, agent.slug);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 30) || 30, 1), 200);
    return c.json({ messages: row ? await recentMessages(db, row.id, limit) : [] });
  });

  app.post("/agents/:slug/messages", async (c) => {
    const agent = await loadAgent(c.req.param("slug"));
    const parsed = NewMessage.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "mande { text: \"...\" }" }, 400);

    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const send = (event: TurnEvent) => {
        writes = writes
          .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }))
          .catch(() => {});
      };
      try {
        await turns.run({ slug: agent.slug, text: parsed.data.text, trigger: "chat", onEvent: send });
      } catch (error) {
        send({ type: "error", message: errorMessage(error) });
      }
      await writes;
    });
  });

  return app;
}

export async function startDaemon(): Promise<void> {
  const { db, sql } = connect();
  await applyMigrations(db);
  const turns = new Turns(db);
  const app = createApp(db, turns);
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: DAEMON_PORT });
  console.log(`motor do neoterm em http://127.0.0.1:${DAEMON_PORT}  (ctrl+c para parar)`);

  const stop = async () => {
    console.log("\nparando o motor…");
    server.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
