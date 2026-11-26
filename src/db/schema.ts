import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/*
 * O banco (SQLite, um arquivo em ~/.neoterm/neoterm.db) guarda o que o sistema registra:
 * conversas, execuções, rotinas, grupos e o estado de cada agente. Quem o agente é (nome, função,
 * escopo) fica no AGENT.md dele, que a pessoa edita; aqui ele é só um id ligado à pasta pelo `slug`.
 */

/** Um pedaço do que o agente fez num turno, na ordem: palavras, ou uma ferramenta que usou. */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string; error?: string };

/**
 * Quem escreveu: a pessoa, um agente, uma rotina (a instrução que disparou) ou o próprio neoterm
 * (avisos como "a rotina falhou" ou "o grupo parou").
 */
export type MessageAuthor = "person" | "agent" | "routine" | "system";

export type MessageMeta = {
  routineId?: string;
  routineTitle?: string;
  followupId?: string;
  /** Agentes chamados com @nome nesta mensagem. */
  mentions?: string[];
  /** Pediu uma decisão da pessoa com @você. */
  asksPerson?: boolean;
  /** Uma consulta de outro agente (ask_agent): quem perguntou. */
  fromAgent?: string;
  notice?: "routine_failed" | "routine_disabled" | "group_stopped" | "agent_paused" | "followup" | "access_granted" | "compacted";
  /** Numa resposta: quanto do contexto a sessão ocupava ao terminar, e a janela do modelo. */
  context?: { used: number; window: number };
};

/** `agent`: respondendo a uma consulta de outro agente (ask_agent). */
export type RunTrigger = "chat" | "routine" | "followup" | "group" | "agent";
export type RunStatus = "running" | "succeeded" | "failed" | "skipped";
export type RoutineMode = "act" | "notify";
export type FollowupStatus = "scheduled" | "running" | "done" | "skipped" | "cancelled";
/** `idle_services`: um agente parado há um tempo com serviços que ele deixou rodando. */
export type AttentionKind = "access" | "routine_failed" | "routine_disabled" | "group_waiting" | "group_stopped" | "idle_services";

let lastStamp = 0;
/**
 * Um instante que nunca se repete neste processo. Mensagens são ordenadas e lidas "desde a última"
 * pelo horário, e duas gravadas no mesmo milissegundo se perderiam uma da outra.
 */
export function monotonicNow(): Date {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp);
}

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const at = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => at("created_at").notNull().$defaultFn(monotonicNow);
const flag = (name: string) => integer(name, { mode: "boolean" });

export const agents = sqliteTable("agents", {
  id: id(),
  /** O nome da pasta em ~/.neoterm/agents. Um agente excluído ganha um sufixo e libera o nome. */
  slug: text("slug").notNull().unique(),
  pausedAt: at("paused_at"),
  deletedAt: at("deleted_at"),
  createdAt: createdAt(),
});

export const groups = sqliteTable("groups", {
  id: id(),
  slug: text("slug").notNull().unique(),
  /** A pasta do projeto: onde os agentes do grupo trabalham. */
  folder: text("folder").notNull(),
  objective: text("objective").notNull().default(""),
  createdAt: createdAt(),
  deletedAt: at("deleted_at"),
});

export const groupMembers = sqliteTable(
  "group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Responde quando a pessoa escreve sem chamar ninguém. */
    coordinator: flag("coordinator").notNull().default(false),
    /** A sessão do Claude Code deste agente neste grupo. */
    claudeSessionId: text("claude_session_id"),
    /** Até onde ele já leu a conversa do grupo. */
    lastSeenAt: at("last_seen_at"),
    joinedAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.agentId] })],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    /** A conversa da pessoa com um agente; nula numa conversa de grupo. */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    /** A sessão do Claude Code que guarda o contexto desta conversa (`--resume`). */
    claudeSessionId: text("claude_session_id"),
    archivedAt: at("archived_at"),
    createdAt: createdAt(),
  },
  (table) => [index("conversations_agent_idx").on(table.agentId), index("conversations_group_idx").on(table.groupId)],
);

export const routines = sqliteTable(
  "routines",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Onde a resposta aparece: a conversa com o agente, ou a de um grupo. */
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull(),
    mode: text("mode").$type<RoutineMode>().notNull().default("act"),
    enabled: flag("enabled").notNull().default(true),
    nextRunAt: at("next_run_at").notNull(),
    lastRunAt: at("last_run_at"),
    enabledAt: at("enabled_at").notNull().$defaultFn(() => new Date()),
    /** Falhas seguidas desde o último sucesso ou desde que foi religada. */
    failureStreak: integer("failure_streak").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: at("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    unique("routines_agent_title_unique").on(table.agentId, table.title),
    index("routines_due_idx").on(table.enabled, table.nextRunAt),
  ],
);

export const followups = sqliteTable(
  "followups",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    instruction: text("instruction"),
    dueAt: at("due_at").notNull(),
    status: text("status").$type<FollowupStatus>().notNull().default("scheduled"),
    createdAt: createdAt(),
    finishedAt: at("finished_at"),
  },
  (table) => [index("followups_due_idx").on(table.status, table.dueAt)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    routineId: text("routine_id").references(() => routines.id, { onDelete: "set null" }),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    startedAt: at("started_at").notNull().$defaultFn(() => new Date()),
    finishedAt: at("finished_at"),
  },
  (table) => [
    index("runs_agent_idx").on(table.agentId, table.startedAt),
    index("runs_routine_idx").on(table.routineId, table.startedAt),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    author: text("author").$type<MessageAuthor>().notNull(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** O texto final; o que o agente fez no caminho está em `parts`. */
    text: text("text").notNull(),
    parts: text("parts", { mode: "json" })
      .$type<MessagePart[]>()
      .notNull()
      .$defaultFn(() => []),
    meta: text("meta", { mode: "json" })
      .$type<MessageMeta>()
      .notNull()
      .$defaultFn(() => ({})),
    createdAt: createdAt(),
  },
  (table) => [index("messages_conversation_idx").on(table.conversationId, table.createdAt)],
);

/** O que precisa da pessoa: um acesso pedido, uma rotina com problema, um grupo esperando. */
export const attention = sqliteTable(
  "attention",
  {
    id: id(),
    kind: text("kind").$type<AttentionKind>().notNull(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    groupId: text("group_id").references(() => groups.id, { onDelete: "cascade" }),
    routineId: text("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** Num pedido de acesso, a ferramenta pedida. */
    tool: text("tool"),
    createdAt: createdAt(),
    resolvedAt: at("resolved_at"),
  },
  (table) => [index("attention_open_idx").on(table.resolvedAt)],
);
