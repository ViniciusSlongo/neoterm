import type { Database } from "./db/client.ts";
import type { EventBus } from "./events.ts";
import type { TurnEngine } from "./runner/turn.ts";

/** O que quase todo serviço do motor usa. */
export type Core = {
  db: Database;
  bus: EventBus;
  engine: TurnEngine;
  now: () => Date;
};

export const agentKey = (slug: string) => `agent:${slug}`;
export const groupKey = (groupId: string) => `group:${groupId}`;
