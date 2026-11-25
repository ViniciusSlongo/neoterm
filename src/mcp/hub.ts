import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { RunMode } from "../agents/prompt.ts";

/*
 * As ferramentas do neoterm, servidas aos agentes por MCP (HTTP, sem estado) dentro do motor.
 *
 * QUEM CHAMA VEM DA CHAVE, NÃO DOS ARGUMENTOS. Cada execução recebe uma chave própria no
 * `--mcp-config`; ela diz qual agente, qual conversa e qual execução está chamando. O modelo não
 * escolhe em nome de quem age.
 *
 * TODA RECUSA É UMA RESPOSTA. Uma regra que barra (horário curto demais, limite de rotinas) volta
 * como texto que o agente pode repetir para a pessoa, e não como um erro que encerra o turno.
 */

export type ToolCaller = {
  runId: string;
  agentId: string;
  slug: string;
  conversationId: string;
  groupId?: string;
  mode: RunMode;
  timeZone: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodObject;
  run(caller: ToolCaller, args: Record<string, unknown>): Promise<string>;
};

/** Uma recusa que o agente deve ler e repassar. */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: unknown };
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export class McpHub {
  readonly #callers = new Map<string, ToolCaller>();
  readonly #tools: Map<string, ToolDefinition>;

  constructor(tools: ToolDefinition[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  get toolNames(): string[] {
    return [...this.#tools.keys()];
  }

  /** Uma chave para uma execução; vale até `revoke`. */
  issue(caller: ToolCaller): string {
    const token = randomBytes(24).toString("hex");
    this.#callers.set(token, caller);
    return token;
  }

  revoke(token: string): void {
    this.#callers.delete(token);
  }

  /** Atende um POST em /mcp. Devolve o status HTTP e o corpo JSON, se houver. */
  async handle(authorization: string | undefined, payload: unknown): Promise<{ status: number; body?: unknown }> {
    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    const caller = token ? this.#callers.get(token) : undefined;
    if (!caller) return { status: 401, body: { error: "chave inválida ou execução encerrada" } };
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((item) => this.#dispatch(caller, item)))).filter(
        (response): response is JsonRpcResponse => response !== undefined,
      );
      return responses.length > 0 ? { status: 200, body: responses } : { status: 202 };
    }
    const response = await this.#dispatch(caller, payload);
    return response ? { status: 200, body: response } : { status: 202 };
  }

  async #dispatch(caller: ToolCaller, payload: unknown): Promise<JsonRpcResponse | undefined> {
    const request = payload as JsonRpcRequest;
    if (typeof request !== "object" || request === null || typeof request.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    // Notificação: sem id, sem resposta.
    if (request.id === undefined || request.id === null) return undefined;
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: request.id ?? null, result });
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply({
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "neoterm", version: "0.1.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: [...this.#tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.schema),
          })),
        });
      case "tools/call":
        return reply(await this.call(caller, String(params.name ?? ""), params.arguments));
      default:
        return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
  }

  async call(caller: ToolCaller, name: string, rawArguments: unknown) {
    const tool = this.#tools.get(name);
    if (!tool) return { content: [{ type: "text", text: `não existe a ferramenta ${name}` }], isError: true };
    const parsed = tool.schema.safeParse(rawArguments ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        content: [{ type: "text", text: `argumentos inválidos: ${issue?.path.join(".") || name}: ${issue?.message}` }],
        isError: true,
      };
    }
    try {
      const text = await tool.run(caller, parsed.data as Record<string, unknown>);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
}
