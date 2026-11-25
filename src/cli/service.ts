import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CLAUDE_BIN, DAEMON_URL, DATABASE_FILE, NEOTERM_HOME, REPO_ROOT, writeFileAtomic } from "../config.ts";
import { accent, bold, fail, muted, ok, yellow } from "./style.ts";

/*
 * `neoterm service`: liga o motor junto com o Mac, por um LaunchAgent do launchd.
 *
 * Ele sobe quando você entra na sua conta (não antes do login: o Claude Code lê o seu login nas
 * Chaves, que só abrem com você logado) e volta sozinho se cair. Roda com o mesmo PATH do terminal
 * onde você ligou, para os agentes acharem os mesmos programas que você acha.
 */

export const SERVICE_LABEL = process.env.NEOTERM_SERVICE_LABEL ?? "com.neoterm.daemon";
export const SERVICE_LOG = join(NEOTERM_HOME, "daemon.log");
const PLIST = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const PASSED_ENV = ["NEOTERM_HOME", "NEOTERM_DATABASE", "NEOTERM_PORT", "NEOTERM_CLAUDE_BIN", "LANG", "LC_ALL"];

export type ServiceSpec = {
  label: string;
  node: string;
  script: string;
  workingDirectory: string;
  log: string;
  env: Record<string, string>;
};

/** O LaunchAgent: roda `node bin/neoterm.js daemon` no login e de novo se cair. */
export function servicePlist(spec: ServiceSpec): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  const env = Object.entries(spec.env)
    .map(([key, value]) => `\t\t<key>${escapeXml(key)}</key>\n\t\t${string(value)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${string(spec.label)}
\t<key>ProgramArguments</key>
\t<array>
\t\t${string(spec.node)}
\t\t${string(spec.script)}
\t\t<string>daemon</string>
\t</array>
\t<key>WorkingDirectory</key>
\t${string(spec.workingDirectory)}
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>StandardOutPath</key>
\t${string(spec.log)}
\t<key>StandardErrorPath</key>
\t${string(spec.log)}
</dict>
</plist>
`;
}

/** Acha um programa no PATH, como o `which`. */
export function findExecutable(name: string, path = process.env.PATH ?? ""): string | undefined {
  if (isAbsolute(name)) return isExecutable(name) ? name : undefined;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Monta o serviço a partir deste terminal: o node e o claude que ele acha, e o PATH dele. */
export function serviceSpec(): ServiceSpec {
  // O node pelo PATH (/opt/homebrew/bin/node), e não o process.execPath, que aponta para a pasta da
  // versão instalada e some na próxima atualização do Homebrew.
  const node = findExecutable("node") ?? process.execPath;
  const claude = findExecutable(CLAUDE_BIN);
  if (!claude) throw new Error(`não encontrei o "${CLAUDE_BIN}" no PATH deste terminal`);
  const path = unique([dirname(node), dirname(claude), ...(process.env.PATH ?? "").split(delimiter)]);
  const env: Record<string, string> = { PATH: path.join(delimiter) };
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return {
    label: SERVICE_LABEL,
    node,
    script: join(REPO_ROOT, "bin", "neoterm.js"),
    workingDirectory: NEOTERM_HOME,
    log: SERVICE_LOG,
    env,
  };
}

export async function serviceCommand(action: string | undefined): Promise<number> {
  if (process.platform !== "darwin") {
    console.error(fail("ligar junto com o computador só existe no macOS por enquanto. Rode neoterm daemon."));
    return 1;
  }
  switch (action) {
    case "on":
      return serviceOn();
    case "off":
      return serviceOff();
    case "restart":
      return serviceRestart();
    case "status":
    case undefined:
      return serviceStatus();
    default:
      console.error(fail(`use: neoterm service on|off|status|restart`));
      return 1;
  }
}

async function serviceOn(): Promise<number> {
  if (!existsSync(DATABASE_FILE)) {
    console.error(fail(`rode ${accent("neoterm init")} antes`));
    return 1;
  }
  const before = await launchdState();
  if (!before.loaded && (await daemonAnswers())) {
    console.error(fail(`já tem um motor rodando em ${DAEMON_URL}, provavelmente num terminal.`));
    console.error(muted("  pare ele com ctrl+c e rode de novo."));
    return 1;
  }
  const spec = serviceSpec();
  await writeFileAtomic(PLIST, servicePlist(spec));
  if (before.loaded) {
    await launchctl(["bootout", target()]);
    await until(async () => !(await daemonAnswers()), 10_000);
  }
  const loaded = await launchctl(["bootstrap", domain(), PLIST]);
  if (!loaded.ok) {
    console.error(fail(`o launchd recusou: ${loaded.output.trim()}`));
    return 1;
  }
  if (!(await until(daemonAnswers, 20_000))) return startFailed();
  console.log(ok(`o motor liga junto com o Mac ${muted(`· ${DAEMON_URL}`)}`));
  console.log(muted(`  sobe quando você entra na sua conta e volta sozinho se cair`));
  console.log(muted(`  log: ${SERVICE_LOG}`));
  console.log(muted(`  node: ${spec.node}`));
  console.log(muted(`  desligar: neoterm service off`));
  return 0;
}

async function serviceOff(): Promise<number> {
  const { loaded } = await launchdState();
  if (loaded) {
    await launchctl(["bootout", target()]);
    await until(async () => !(await daemonAnswers()), 10_000);
  }
  const installed = existsSync(PLIST);
  await rm(PLIST, { force: true });
  if (!loaded && !installed) {
    console.log(muted("o motor não estava configurado para ligar junto com o Mac"));
    return 0;
  }
  console.log(ok("o motor não liga mais junto com o Mac, e foi parado"));
  console.log(muted("  para ligar na mão: neoterm daemon"));
  return 0;
}

async function serviceRestart(): Promise<number> {
  const { loaded } = await launchdState();
  if (!loaded) {
    console.error(fail(`o motor não está configurado para ligar junto com o Mac. Use ${accent("neoterm service on")}`));
    return 1;
  }
  await launchctl(["kickstart", "-k", target()]);
  if (!(await until(daemonAnswers, 20_000))) return startFailed();
  console.log(ok("motor reiniciado"));
  return 0;
}

async function serviceStatus(): Promise<number> {
  const state = await launchdState();
  const answers = await daemonAnswers();
  if (!existsSync(PLIST)) {
    console.log(`${bold("liga junto com o Mac:")} não ${muted("· ligue com neoterm service on")}`);
  } else {
    console.log(`${bold("liga junto com o Mac:")} sim`);
  }
  if (answers) {
    const how = state.pid ? `pelo launchd, pid ${state.pid}` : "num terminal";
    console.log(`${bold("motor:")} rodando ${muted(`· ${how} · ${DAEMON_URL}`)}`);
  } else {
    console.log(`${bold("motor:")} ${yellow("parado")}`);
    if (state.lastExit) console.log(muted(`  última saída: ${state.lastExit}`));
  }
  if (existsSync(PLIST)) console.log(muted(`log: ${SERVICE_LOG}`));
  return 0;
}

function startFailed(): number {
  console.error(fail("o motor não subiu em 20 s. O fim do log:"));
  console.error(muted(tail(SERVICE_LOG, 12)));
  return 1;
}

type LaunchdState = { loaded: boolean; pid?: number; lastExit?: string };

async function launchdState(): Promise<LaunchdState> {
  const printed = await launchctl(["print", target()]);
  if (!printed.ok) return { loaded: false };
  const pid = /^\s*pid = (\d+)/m.exec(printed.output)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/m.exec(printed.output)?.[1];
  return { loaded: true, ...(pid ? { pid: Number(pid) } : {}), ...(lastExit ? { lastExit } : {}) };
}

const domain = () => `gui/${process.getuid?.() ?? 501}`;
const target = () => `${domain()}/${SERVICE_LABEL}`;

function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", args, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }));
  });
}

async function daemonAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return check();
}

function tail(file: string, lines: number): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(sem log)";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
