import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * O banco guarda o que o sistema registra: conversas, execuções e o estado de cada agente.
 * Quem o agente é (nome, função, escopo) fica no AGENT.md dele, que a pessoa edita; aqui ele é só
 * um id ligado à pasta pelo `slug`.
 */

/** Um pedaço do que o agente fez num turno, na ordem: palavras, ou uma ferramenta que usou. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string; error?: string };

export type RunTrigger = "chat" | "routine";
export type RunStatus = "running" | "succeeded" | "failed";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** O nome da pasta em ~/.neoterm/agents. */
  slug: text("slug").notNull().unique(),
  pausedAt: at("paused_at"),
  deletedAt: at("deleted_at"),
  createdAt: at("created_at").notNull().defaultNow(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    /** A sessão do Claude Code que guarda o contexto desta conversa (`--resume`). */
    claudeSessionId: uuid("claude_session_id"),
    archivedAt: at("archived_at"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [index("conversations_agent_idx").on(table.agentId)],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    startedAt: at("started_at").notNull().defaultNow(),
    finishedAt: at("finished_at"),
  },
  (table) => [index("runs_agent_idx").on(table.agentId, table.startedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    author: text("author").$type<"person" | "agent">().notNull(),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    /** O texto final; o que o agente fez no caminho está em `parts`. */
    text: text("text").notNull(),
    parts: jsonb("parts")
      .$type<MessagePart[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("messages_conversation_idx").on(table.conversationId, table.createdAt),
  ],
);
