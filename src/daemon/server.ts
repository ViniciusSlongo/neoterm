import { type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { chatWithAgent } from "../agents/chat.ts";
import {
  AgentNotFound,
  AgentProblem,
  createAgent,
  DEFAULT_TOOLS,
  DEFAULT_UNATTENDED_TOOLS,
  grantTool,
  loadAgent,
} from "../agents/identity.ts";
import { planReset, removeAgent, reset, setPaused } from "../agents/lifecycle.ts";
import { Neoterm } from "../app.ts";
import { getAttention, resolveAttention } from "../attention.ts";
import { DAEMON_PORT, readSettings } from "../config.ts";
import { applyMigrations, connect, errorMessage } from "../db/client.ts";
import type { NeotermEvent, TurnEvent } from "../events.ts";
import { GroupProblem, addMember, createGroup, deleteGroup, getGroup, listGroups, removeMember } from "../groups/store.ts";
import { FollowupRefused, cancelFollowup, pendingFollowups } from "../routines/followups.ts";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutines,
  RoutineRefused,
  updateRoutine,
} from "../routines/store.ts";
import { agentRowById, ensureAgentRow, findAgentRow, lastMessages, mainConversation } from "../store/conversations.ts";
import { desc, eq } from "drizzle-orm";
import { messages, runs } from "../db/schema.ts";

/*
 * O motor: um servidor HTTP só em 127.0.0.1, que o CLI e a interface de terminal usam. Ele é o
 * único que abre o banco e o único que roda agentes.
 *
 * UM TURNO NÃO DEPENDE DE QUEM PEDIU. Se o terminal que mandou a mensagem fechar no meio, o agente
 * termina o que estava fazendo e a resposta fica na conversa.
 */

const Text = z.object({ text: z.string().trim().min(1).max(100_000) });
const Confirm = z.object({ confirm: z.literal(true) });
const NewAgent = z.object({
  slug: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  unattended: z.array(z.string()).optional(),
});
const NewRoutine = z.object({
  agent: z.string().min(1),
  group: z.string().optional(),
  title: z.string().min(1),
  instruction: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  mode: z.enum(["act", "notify"]).optional(),
});
const RoutinePatch = z.object({
  title: z.string().min(1).optional(),
  instruction: z.string().min(1).optional(),
  cron: z.string().min(1).optional(),
  timezone: z.string().optional(),
  mode: z.enum(["act", "notify"]).optional(),
  enabled: z.boolean().optional(),
});
const NewGroup = z.object({
  slug: z.string().min(1),
  folder: z.string().min(1),
  objective: z.string().optional(),
  members: z.array(z.string().min(1)).min(1),
  coordinator: z.string().optional(),
});

class BadRequest extends Error {}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequest(`${issue?.path.join(".") || "corpo"}: ${issue?.message ?? "inválido"}`);
  }
  return parsed.data;
}

export function createApp(neoterm: Neoterm): Hono {
  const { db, bus } = neoterm.core;
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof AgentNotFound) return c.json({ error: error.message }, 404);
    if (error instanceof BadRequest) return c.json({ error: error.message }, 400);
    if (
      error instanceof AgentProblem ||
      error instanceof GroupProblem ||
      error instanceof RoutineRefused ||
      error instanceof FollowupRefused
    ) {
      return c.json({ error: error.message }, 422);
    }
    console.error(error);
    return c.json({ error: errorMessage(error) }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/state", async (c) => c.json(await neoterm.state()));

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: NeotermEvent[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = bus.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 15_000);
          });
          wake = undefined;
          if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        const event = queue.shift() as NeotermEvent;
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
      unsubscribe();
    }),
  );

  // As ferramentas do neoterm para os agentes (MCP por HTTP, sem estado).
  app.post("/mcp", async (c) => {
    const payload = await c.req.json().catch(() => null);
    const { status, body: response } = await neoterm.hub.handle(c.req.header("authorization"), payload);
    if (response === undefined) return c.body(null, status as 202);
    return c.json(response, status as 200);
  });
  app.get("/mcp", (c) => c.body(null, 405));
  app.delete("/mcp", (c) => c.body(null, 405));

  // Agentes
  app.get("/agents", async (c) => {
    const state = await neoterm.state();
    return c.json({ agents: state.agents, problems: state.problems });
  });
  app.post("/agents", async (c) => {
    const input = await body(c.req.raw, NewAgent);
    const agent = await createAgent(input);
    await ensureAgentRow(db, agent.slug);
    bus.changed("agents");
    return c.json({ agent: await loadAgent(agent.slug) }, 201);
  });
  app.get("/agents/:slug", async (c) => {
    const agent = await loadAgent(c.req.param("slug"));
    const row = await ensureAgentRow(db, agent.slug);
    return c.json({ agent, paused: Boolean(row.pausedAt), defaults: { tools: DEFAULT_TOOLS, unattended: DEFAULT_UNATTENDED_TOOLS } });
  });
  app.get("/agents/:slug/messages", async (c) => {
    const agent = await loadAgent(c.req.param("slug"));
    const row = await findAgentRow(db, agent.slug);
    const limit = clampLimit(c.req.query("limit"));
    if (!row) return c.json({ messages: [] });
    const conversation = await mainConversation(db, row.id);
    return c.json({ messages: await lastMessages(db, conversation.id, limit) });
  });
  app.post("/agents/:slug/messages", async (c) => {
    const agent = await loadAgent(c.req.param("slug"));
    const { text } = await body(c.req.raw, Text);
    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const send = (event: TurnEvent) => {
        writes = writes.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })).catch(() => {});
      };
      try {
        await chatWithAgent(neoterm.core, agent.slug, text, send);
      } catch (error) {
        send({ type: "error", message: errorMessage(error) });
      }
      await writes;
    });
  });
  app.post("/agents/:slug/pause", async (c) => {
    await setPaused(neoterm.core, c.req.param("slug"), true);
    return c.json({ ok: true });
  });
  app.post("/agents/:slug/resume", async (c) => {
    await setPaused(neoterm.core, c.req.param("slug"), false);
    return c.json({ ok: true });
  });
  app.get("/agents/:slug/reset", async (c) => c.json({ plan: await planReset(neoterm.core, c.req.param("slug")) }));
  app.post("/agents/:slug/reset", async (c) => {
    await body(c.req.raw, Confirm);
    return c.json({ done: await reset(neoterm.core, c.req.param("slug")) });
  });
  app.delete("/agents/:slug", async (c) => {
    await body(c.req.raw, Confirm);
    return c.json({ trash: await removeAgent(neoterm.core, c.req.param("slug")) });
  });
  app.get("/agents/:slug/runs", async (c) => {
    const row = await findAgentRow(db, c.req.param("slug"));
    if (!row) return c.json({ runs: [] });
    const list = await db.select().from(runs).where(eq(runs.agentId, row.id)).orderBy(desc(runs.startedAt)).limit(clampLimit(c.req.query("limit")));
    return c.json({ runs: list });
  });

  // Rotinas e retornos
  app.get("/routines", async (c) => {
    const slug = c.req.query("agent");
    const row = slug ? await findAgentRow(db, slug) : undefined;
    if (slug && !row) return c.json({ routines: [] });
    return c.json({ routines: await listRoutines(db, row ? { agentId: row.id } : {}) });
  });
  app.post("/routines", async (c) => {
    const input = await body(c.req.raw, NewRoutine);
    const agent = await loadAgent(input.agent);
    const row = await ensureAgentRow(db, agent.slug);
    let conversationId: string;
    if (input.group) {
      const group = await getGroup(db, input.group);
      if (!group.members.some((member) => member.agent.id === row.id)) {
        throw new GroupProblem(`${agent.slug} não está no grupo #${group.slug}`);
      }
      conversationId = group.conversationId;
    } else {
      conversationId = (await mainConversation(db, row.id)).id;
    }
    const settings = await readSettings();
    const routine = await createRoutine(db, {
      agentId: row.id,
      conversationId,
      title: input.title,
      instruction: input.instruction,
      cron: input.cron,
      timezone: input.timezone ?? settings.timezone,
      ...(input.mode ? { mode: input.mode } : {}),
      now: neoterm.core.now(),
    });
    bus.changed("routines");
    return c.json({ routine }, 201);
  });
  app.patch("/routines/:id", async (c) => {
    const routine = await requireRoutine(c.req.param("id"));
    const updated = await updateRoutine(db, routine, await body(c.req.raw, RoutinePatch), neoterm.core.now());
    bus.changed("routines");
    return c.json({ routine: updated });
  });
  app.delete("/routines/:id", async (c) => {
    const routine = await requireRoutine(c.req.param("id"));
    await deleteRoutine(db, routine.id);
    bus.changed("routines");
    return c.json({ ok: true });
  });
  app.post("/routines/:id/run", async (c) => {
    const routine = await requireRoutine(c.req.param("id"));
    void neoterm.routines.fire(routine);
    return c.json({ ok: true }, 202);
  });
  app.get("/routines/:id/runs", async (c) => {
    const routine = await requireRoutine(c.req.param("id"));
    const list = await db.select().from(runs).where(eq(runs.routineId, routine.id)).orderBy(desc(runs.startedAt)).limit(clampLimit(c.req.query("limit")));
    return c.json({ runs: list });
  });
  app.get("/followups", async (c) => c.json({ followups: await pendingFollowups(db) }));
  app.delete("/followups/:id", async (c) => {
    const ok = await cancelFollowup(db, c.req.param("id"));
    if (ok) bus.changed("routines");
    return c.json({ ok });
  });

  // Grupos
  app.get("/groups", async (c) => c.json({ groups: (await neoterm.state()).groups }));
  app.post("/groups", async (c) => {
    const input = await body(c.req.raw, NewGroup);
    const members = [];
    for (const slug of input.members) {
      const agent = await loadAgent(slug);
      members.push({ agentId: (await ensureAgentRow(db, agent.slug)).id, coordinator: slug === input.coordinator });
    }
    const group = await createGroup(db, {
      slug: input.slug,
      folder: input.folder,
      members,
      ...(input.objective ? { objective: input.objective } : {}),
    });
    bus.changed("groups");
    return c.json({ group: { slug: group.slug, folder: group.folder, members: input.members } }, 201);
  });
  app.get("/groups/:slug/messages", async (c) => {
    const group = await getGroup(db, c.req.param("slug"));
    const slugById = Object.fromEntries(group.members.map((member) => [member.agent.id, member.agent.slug]));
    const list = await lastMessages(db, group.conversationId, clampLimit(c.req.query("limit")));
    const authors = new Map<string, string>(Object.entries(slugById));
    for (const message of list) {
      if (message.agentId && !authors.has(message.agentId)) {
        authors.set(message.agentId, (await agentRowById(db, message.agentId))?.slug ?? "agente");
      }
    }
    return c.json({ messages: list.map((message) => ({ ...message, agent: message.agentId ? authors.get(message.agentId) : null })) });
  });
  app.post("/groups/:slug/messages", async (c) => {
    const { text } = await body(c.req.raw, Text);
    return c.json(await neoterm.groups.postPersonMessage(c.req.param("slug"), text), 202);
  });
  app.post("/groups/:slug/members", async (c) => {
    const group = await getGroup(db, c.req.param("slug"));
    const { agent: slug } = await body(c.req.raw, z.object({ agent: z.string().min(1) }));
    const agent = await loadAgent(slug);
    await addMember(db, group, (await ensureAgentRow(db, agent.slug)).id);
    bus.changed("groups");
    return c.json({ ok: true });
  });
  app.delete("/groups/:slug/members/:agent", async (c) => {
    const group = await getGroup(db, c.req.param("slug"));
    const row = await findAgentRow(db, c.req.param("agent"));
    if (row) await removeMember(db, group, row.id);
    bus.changed("groups");
    return c.json({ ok: true });
  });
  app.delete("/groups/:slug", async (c) => {
    await body(c.req.raw, Confirm);
    await deleteGroup(db, await getGroup(db, c.req.param("slug")), neoterm.core.now());
    bus.changed("groups");
    return c.json({ ok: true });
  });

  // Precisa de você
  app.post("/attention/:id/resolve", async (c) => c.json({ ok: await resolveAttention(db, bus, c.req.param("id")) }));
  app.post("/attention/:id/allow", async (c) => {
    const item = await getAttention(db, c.req.param("id"));
    if (!item || item.kind !== "access" || !item.tool || !item.agentId) throw new BadRequest("esse item não é um pedido de acesso");
    const row = await agentRowById(db, item.agentId);
    if (!row) throw new BadRequest("o agente não existe mais");
    await grantTool(row.slug, item.tool);
    await resolveAttention(db, bus, item.id);
    // O agente fica sabendo na conversa, no próximo turno (veja withNotices).
    const conversation = await mainConversation(db, row.id);
    await db.insert(messages).values({
      conversationId: conversation.id,
      author: "system",
      text: `A pessoa liberou ${item.tool} para ${row.slug}, também quando roda sozinho.`,
      meta: { notice: "access_granted" },
    });
    bus.changed("messages", { kind: "agent", slug: row.slug });
    bus.changed("agents");
    return c.json({ ok: true, agent: row.slug, tool: item.tool });
  });

  async function requireRoutine(id: string) {
    const routine = await getRoutine(db, id);
    if (!routine) throw new RoutineRefused("essa rotina não existe");
    return routine;
  }

  return app;
}

function clampLimit(value: string | undefined): number {
  return Math.min(Math.max(Number(value ?? 40) || 40, 1), 500);
}

/** Liga o motor numa porta. `port: 0` escolhe uma livre (para os testes). */
export async function listen(neoterm: Neoterm, port: number) {
  const app = createApp(neoterm);
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => resolve(started));
  });
  const actual = (server.address() as AddressInfo).port;
  neoterm.setMcpUrl(`http://127.0.0.1:${actual}/mcp`);
  return { server, port: actual };
}

export async function startDaemon(): Promise<void> {
  const connection = connect();
  await applyMigrations(connection);
  const neoterm = new Neoterm(connection.db);
  const { server, port } = await listen(neoterm, DAEMON_PORT);
  await neoterm.start();
  console.log(`motor do neoterm em http://127.0.0.1:${port}  (ctrl+c para parar)`);
  const stop = () => {
    console.log("\nparando o motor…");
    neoterm.stop();
    server.close();
    connection.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
