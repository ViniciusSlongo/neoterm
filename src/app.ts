import { chatWithAgent } from "./agents/chat.ts";
import type { Core } from "./core.ts";
import { connect } from "./db/client.ts";
import { EventBus, type TurnEvent } from "./events.ts";
import { GroupEngine } from "./groups/engine.ts";
import { McpHub } from "./mcp/hub.ts";
import { neotermTools } from "./mcp/tools.ts";
import type { PlanUsage } from "./runner/claude.ts";
import { RoutineRunner } from "./routines/runner.ts";
import { closeInterruptedWork, Scheduler } from "./routines/scheduler.ts";
import { TurnEngine } from "./runner/turn.ts";
import { buildState } from "./state.ts";

/** O motor inteiro, montado sobre um banco. O servidor HTTP e os testes usam isto. */
export class Neoterm {
  readonly core: Core;
  readonly hub: McpHub;
  readonly groups: GroupEngine;
  readonly routines: RoutineRunner;
  readonly scheduler: Scheduler;
  #mcpUrl: string | undefined;
  #planUsage: PlanUsage | null = null;

  constructor(db: ReturnType<typeof connect>["db"], options: { now?: () => Date } = {}) {
    const bus = new EventBus();
    const now = options.now ?? (() => new Date());
    this.hub = new McpHub(neotermTools({ db, bus, now }));
    const engine = new TurnEngine({ db, bus, hub: this.hub, mcpUrl: () => this.#mcpUrl });
    this.core = { db, bus, engine, now };
    this.groups = new GroupEngine(this.core);
    this.routines = new RoutineRunner(this.core, this.groups);
    this.scheduler = new Scheduler(this.core, this.routines);
    bus.subscribe((event) => {
      if (event.type === "plan_usage") this.#planUsage = event.usage;
    });
  }

  /** Onde os agentes acham as ferramentas do neoterm, depois que o servidor abriu a porta. */
  setMcpUrl(url: string): void {
    this.#mcpUrl = url;
  }

  async start(): Promise<void> {
    await closeInterruptedWork(this.core);
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  chat(slug: string, text: string, onEvent?: (event: TurnEvent) => void) {
    return chatWithAgent(this.core, slug, text, onEvent);
  }

  state() {
    return buildState(this.core, this.groups, this.#planUsage);
  }
}
