import { spawn } from "node:child_process";
import { CLAUDE_BIN } from "./config.ts";

/*
 * Os provedores de modelo: quem roda os turnos dos agentes, com o login da própria ferramenta do
 * provedor. O neoterm só pergunta se há login e, se não houver, abre o login dela. Hoje: Claude
 * (Claude Code). Um provedor novo (ChatGPT pelo Codex, por exemplo) entra nesta lista.
 */

export type ProviderStatus =
  | { state: "missing" }
  | { state: "logged-out" }
  | { state: "logged-in"; plan?: string };

export type Provider = {
  id: string;
  name: string;
  /** O programa que precisa estar no PATH. */
  command: string;
  status(): Promise<ProviderStatus>;
  /** Abre o login do próprio provedor, neste terminal. Devolve se terminou bem. */
  login(): Promise<boolean>;
};

type Run = { code: number | null; stdout: string };

function capture(command: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.once("error", () => resolve({ code: null, stdout }));
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

function interactive(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/** O `claude auth status --json`: se há login e o plano (sem guardar e-mail ou organização). */
export function parseClaudeStatus(stdout: string): ProviderStatus {
  try {
    const status = JSON.parse(stdout) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string };
    if (!status.loggedIn) return { state: "logged-out" };
    const plan = status.subscriptionType ?? (status.authMethod === "console" ? "console" : undefined);
    return plan ? { state: "logged-in", plan } : { state: "logged-in" };
  } catch {
    return { state: "logged-out" };
  }
}

export const claude: Provider = {
  id: "claude",
  name: "Claude",
  command: CLAUDE_BIN,
  async status() {
    const run = await capture(CLAUDE_BIN, ["auth", "status", "--json"]);
    if (run.code === null) return { state: "missing" };
    return parseClaudeStatus(run.stdout);
  },
  login: () => interactive(CLAUDE_BIN, ["auth", "login"]),
};

export const PROVIDERS: Provider[] = [claude];
