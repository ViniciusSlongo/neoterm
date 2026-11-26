import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_ENV, INSTANCE } from "./runner/claude.ts";

/*
 * Os processos de cada agente. Todo `claude` que o motor abre leva NEOTERM_AGENT=<agente> no
 * ambiente, e tudo o que ele roda herda: o turno em si e os serviços que ficam rodando depois
 * (um servidor de desenvolvimento, um watcher), mesmo quando o `claude` já saiu e eles viraram
 * órfãos. O neoterm lê essa marca com o `ps -E`.
 *
 * Limites: programas do sistema da Apple (/bin, /usr/bin) escondem o ambiente e não aparecem;
 * contêineres do Docker rodam na máquina virtual dele e também não.
 *
 * ENCERRAR SÓ O QUE É DO AGENTE. Antes de mandar o sinal, confere de novo que o processo ainda
 * tem a marca daquele agente: um pid reaproveitado pelo sistema nunca é encerrado por engano.
 */

export type AgentProcess = {
  pid: number;
  ppid: number;
  /** `claude`: o turno em andamento; `service`: o resto (do turno ou deixado rodando). */
  kind: "claude" | "service";
  /** Ainda pendurado no `claude` do turno (um comando em execução), ou já solto (deixado rodando). */
  inTurn: boolean;
  command: string;
  rssBytes: number;
  uptimeSeconds: number;
  ports: number[];
};

type Row = { pid: number; ppid: number; rss: number; etime: number; command: string };

const run = promisify(execFile);

/** "1-02:03:04", "02:03:04", "03:04" → segundos. */
export function parseEtime(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = (rest ?? "").split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts as [number, number, number];
  return Number(days) * 86_400 + hours * 3600 + minutes * 60 + seconds;
}

/** Os pids marcados com cada agente: o `ps eww` põe o ambiente depois do comando. */
async function markedPids(): Promise<Map<number, string>> {
  const { stdout } = await run("ps", ["-A", "-ww", "-E", "-o", "pid=,command="], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  // Só os desta instância do neoterm.
  const marker = new RegExp(`(?:^|\\s)${AGENT_ENV}=([a-z0-9][a-z0-9-]*)@${INSTANCE}(?:\\s|$)`);
  const marked = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    const agent = match ? marker.exec(match[2]!)?.[1] : undefined;
    if (match && agent) marked.set(Number(match[1]), agent);
  }
  return marked;
}

async function processTable(): Promise<Map<number, Row>> {
  const { stdout } = await run("ps", ["-A", "-ww", "-o", "pid=,ppid=,rss=,etime=,command="], { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  const rows = new Map<number, Row>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) * 1024, etime: parseEtime(match[4]!), command: match[5]! });
  }
  return rows;
}

/** As portas em que cada processo escuta (TCP), quando o lsof consegue ver. */
async function listeningPorts(pids: number[]): Promise<Map<number, number[]>> {
  const ports = new Map<number, number[]>();
  if (pids.length === 0) return ports;
  try {
    const { stdout } = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-F", "pn"], { timeout: 10_000 });
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      const port = line.startsWith("n") ? Number(/:(\d+)$/.exec(line)?.[1]) : Number.NaN;
      if (pid && Number.isFinite(port) && !(ports.get(pid) ?? []).includes(port)) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
  } catch {
    // lsof sai com erro quando nenhum processo escuta em nada
  }
  return ports;
}

const isClaude = (command: string) => /(^|\/)claude(\s|$)/.test(command.split(/\s+/)[0] ?? "") && /\s-p(\s|$)/.test(command);

/** Os processos de todos os agentes, por agente. */
export async function processesByAgent(): Promise<Map<string, AgentProcess[]>> {
  const [marked, table] = await Promise.all([markedPids(), processTable()]);
  const own = [...marked.keys()].filter((pid) => pid !== process.pid && table.has(pid));
  const ports = await listeningPorts(own);
  const result = new Map<string, AgentProcess[]>();
  for (const pid of own) {
    const row = table.get(pid)!;
    const agent = marked.get(pid)!;
    const claude = isClaude(row.command);
    // Do turno: algum ancestral é o `claude` do mesmo agente.
    let inTurn = claude;
    for (let parent = table.get(row.ppid), hops = 0; parent && !inTurn && hops < 64; parent = table.get(parent.ppid), hops++) {
      if (marked.get(parent.pid) === agent && isClaude(parent.command)) inTurn = true;
    }
    const entry: AgentProcess = {
      pid,
      ppid: row.ppid,
      kind: claude ? "claude" : "service",
      inTurn,
      command: row.command,
      rssBytes: row.rss,
      uptimeSeconds: row.etime,
      ports: ports.get(pid) ?? [],
    };
    result.set(agent, [...(result.get(agent) ?? []), entry]);
  }
  for (const list of result.values()) list.sort((a, b) => Number(b.kind === "claude") - Number(a.kind === "claude") || b.rssBytes - a.rssBytes);
  return result;
}

export async function agentProcesses(slug: string): Promise<AgentProcess[]> {
  return (await processesByAgent()).get(slug) ?? [];
}

/** Os serviços que ficaram rodando: soltos, sem o turno que os iniciou. */
export function leftRunning(list: readonly AgentProcess[]): AgentProcess[] {
  return list.filter((entry) => entry.kind === "service" && !entry.inTurn);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Encerra processos de um agente: pede para parar (SIGTERM) e, quem não sair em alguns segundos,
 * força (SIGKILL). Recusa um pid que não seja (mais) daquele agente. Devolve os encerrados.
 */
export async function stopProcesses(slug: string, pids: readonly number[], graceMs = 3000): Promise<number[]> {
  const marked = await markedPids();
  const own = pids.filter((pid) => marked.get(pid) === slug);
  for (const pid of own) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // já saiu
    }
  }
  const deadline = Date.now() + graceMs;
  while (own.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of own.filter(alive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // saiu agora
    }
  }
  return own;
}
