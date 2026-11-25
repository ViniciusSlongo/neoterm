import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isScalar, isSeq, parseDocument, parse as parseYaml } from "yaml";
import { z } from "zod";
import { AGENTS_DIR, isMissingFile } from "../config.ts";

/*
 * Quem um agente é mora num arquivo que a pessoa pode abrir no editor: ~/.neoterm/agents/<slug>/AGENT.md.
 * O cabeçalho YAML diz o nome, o título, o modelo e o escopo; o corpo é a função, em texto livre.
 * É lido de novo a cada turno, então uma edição vale a partir da próxima resposta.
 */

export const AGENT_FILE = "AGENT.md";
export const MEMORY_FILE = "MEMORY.md";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** O que um agente novo pode usar com você por perto. */
export const DEFAULT_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "Bash",
  "WebSearch",
  "WebFetch",
] as const;
/** O que um agente novo pode usar sozinho, numa rotina: ler e pesquisar, nada que mude coisas. */
export const DEFAULT_UNATTENDED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
] as const;

const Folder = z.union([
  z.string().min(1).transform((path) => ({ path, write: false })),
  z.object({ path: z.string().min(1), write: z.boolean().default(false) }),
]);

const Frontmatter = z.object({
  name: z.string().min(1),
  title: z.string().default(""),
  model: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).default([...DEFAULT_TOOLS]),
  unattended: z.array(z.string().min(1)).default([...DEFAULT_UNATTENDED_TOOLS]),
  folders: z.array(Folder).default([]),
});

export type AgentFolder = { path: string; write: boolean };

export type AgentDefinition = {
  slug: string;
  /** A pasta do agente: AGENT.md, MEMORY.md e workspace/. */
  dir: string;
  /** Onde ele trabalha: o diretório em que o Claude Code roda. */
  workspace: string;
  name: string;
  title: string;
  /** A função: o corpo do AGENT.md. */
  role: string;
  model?: string;
  /** Escopo com você por perto. */
  tools: string[];
  /** Escopo sozinho, em rotinas. Nunca mais que `tools`. */
  unattended: string[];
  /** Pastas além do workspace, com caminho absoluto. */
  folders: AgentFolder[];
};

export class AgentProblem extends Error {
  readonly slug: string;
  constructor(slug: string, message: string) {
    super(message);
    this.name = "AgentProblem";
    this.slug = slug;
  }
}

export class AgentNotFound extends AgentProblem {
  constructor(slug: string) {
    super(slug, `não existe agente "${slug}" em ${AGENTS_DIR}`);
    this.name = "AgentNotFound";
  }
}

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

export function agentDir(slug: string): string {
  return join(AGENTS_DIR, slug);
}

/** Separa o cabeçalho YAML (entre `---`) do corpo. Sem cabeçalho, tudo é corpo. */
export function splitFrontmatter(source: string): { header: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match) return { header: "", body: source };
  return { header: match[1] ?? "", body: match[2] ?? "" };
}

export function parseAgentFile(slug: string, source: string): AgentDefinition {
  const dir = agentDir(slug);
  const workspace = join(dir, "workspace");
  const { header, body } = splitFrontmatter(source);
  let raw: unknown;
  try {
    raw = header ? parseYaml(header) : {};
  } catch (error) {
    throw new AgentProblem(slug, `o cabeçalho do ${AGENT_FILE} não é YAML válido: ${(error as Error).message}`);
  }
  const parsed = Frontmatter.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "cabeçalho";
    throw new AgentProblem(slug, `${AGENT_FILE}: ${where}: ${issue?.message ?? "inválido"}`);
  }
  const front = parsed.data;
  const role = body.trim();
  if (!role) throw new AgentProblem(slug, `${AGENT_FILE} está sem a função (o texto depois do cabeçalho)`);
  const tools = unique(front.tools);
  return {
    slug,
    dir,
    workspace,
    name: front.name,
    title: front.title,
    role,
    ...(front.model ? { model: front.model } : {}),
    tools,
    // Sozinho, ele nunca pode mais do que com você por perto.
    unattended: unique(front.unattended).filter((tool) => tools.includes(tool)),
    folders: front.folders.map((folder) => ({
      path: expandPath(folder.path, workspace),
      write: folder.write,
    })),
  };
}

export async function loadAgent(slug: string): Promise<AgentDefinition> {
  if (!isValidSlug(slug)) throw new AgentNotFound(slug);
  let source: string;
  try {
    source = await readFile(join(agentDir(slug), AGENT_FILE), "utf8");
  } catch (error) {
    if (isMissingFile(error)) throw new AgentNotFound(slug);
    throw error;
  }
  const agent = parseAgentFile(slug, source);
  await mkdir(agent.workspace, { recursive: true });
  // As regras de permissão do Claude Code comparam o caminho real: no Mac, /tmp é /private/tmp.
  agent.folders = await Promise.all(
    agent.folders.map(async (folder) => ({
      ...folder,
      path: await realpath(folder.path).catch(() => folder.path),
    })),
  );
  return agent;
}

/** Todos os agentes da pasta. Um AGENT.md com defeito vira um problema listado, não um erro. */
export async function listAgents(): Promise<{
  agents: AgentDefinition[];
  problems: AgentProblem[];
}> {
  let entries: string[];
  try {
    entries = await readdir(AGENTS_DIR);
  } catch (error) {
    if (isMissingFile(error)) return { agents: [], problems: [] };
    throw error;
  }
  const agents: AgentDefinition[] = [];
  const problems: AgentProblem[] = [];
  for (const slug of entries.sort()) {
    if (!isValidSlug(slug)) continue;
    if (!(await isDirectory(agentDir(slug)))) continue;
    try {
      agents.push(await loadAgent(slug));
    } catch (error) {
      if (error instanceof AgentNotFound) continue;
      problems.push(
        error instanceof AgentProblem
          ? error
          : new AgentProblem(slug, (error as Error).message),
      );
    }
  }
  return { agents, problems };
}

export type NewAgent = {
  slug: string;
  name?: string;
  title?: string;
  role?: string;
  model?: string;
};

export async function createAgent(input: NewAgent): Promise<AgentDefinition> {
  if (!isValidSlug(input.slug)) {
    throw new AgentProblem(
      input.slug,
      "o nome da pasta do agente usa só letras minúsculas, números e '-', até 40 caracteres",
    );
  }
  const dir = agentDir(input.slug);
  if (await exists(join(dir, AGENT_FILE))) {
    throw new AgentProblem(input.slug, `o agente "${input.slug}" já existe em ${dir}`);
  }
  await mkdir(join(dir, "workspace"), { recursive: true });
  await writeFile(join(dir, AGENT_FILE), agentTemplate(input), { encoding: "utf8", flag: "wx" });
  if (!(await exists(join(dir, MEMORY_FILE)))) {
    await writeFile(join(dir, MEMORY_FILE), "", "utf8");
  }
  return loadAgent(input.slug);
}

/**
 * Dá uma ferramenta ao agente, também para quando roda sozinho: o "liberar" de um pedido de acesso.
 * Edita o cabeçalho do AGENT.md mantendo comentários e formato.
 */
export async function grantTool(slug: string, tool: string): Promise<AgentDefinition> {
  const path = join(agentDir(slug), AGENT_FILE);
  const source = await readFile(path, "utf8");
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))([\s\S]*)$/.exec(source);
  if (!match) throw new AgentProblem(slug, `${AGENT_FILE} está sem cabeçalho`);
  const document = parseDocument(match[2] ?? "");
  for (const [key, defaults] of [
    ["tools", DEFAULT_TOOLS],
    ["unattended", DEFAULT_UNATTENDED_TOOLS],
  ] as const) {
    const node = document.get(key, true);
    if (isSeq(node)) {
      if (!node.items.some((item) => String(isScalar(item) ? item.value : item) === tool)) node.add(tool);
    } else {
      const seq = document.createNode([...new Set([...defaults, tool])]);
      seq.flow = true;
      document.set(key, seq);
    }
  }
  const next = `${match[1]}${document.toString().trimEnd()}${match[3]}${match[4]}`;
  parseAgentFile(slug, next);
  await writeFile(path, next, "utf8");
  return loadAgent(slug);
}

export function agentTemplate(input: NewAgent): string {
  const name = input.name?.trim() || input.slug;
  const role =
    input.role?.trim() ||
    "Descreva aqui o que este agente faz, em qualquer conversa: do que ele cuida, de onde tira as informações e como deve responder.";
  const lines = [
    "---",
    `name: ${yamlString(name)}`,
    `title: ${yamlString(input.title?.trim() ?? "")}`,
    input.model ? `model: ${input.model}` : "# model: claude-opus-5-5   # sem isto, usa o modelo padrão do neoterm",
    "",
    "# Escopo com você por perto: as ferramentas que ele tem.",
    `tools: [${DEFAULT_TOOLS.join(", ")}]`,
    "# Escopo sozinho, em rotinas: só o que pode fazer sem ninguém olhando.",
    `unattended: [${DEFAULT_UNATTENDED_TOOLS.join(", ")}]`,
    "",
    "# Pastas além de workspace/. write: false deixa só leitura.",
    "folders: []",
    "#  - path: ~/Documents/exemplo",
    "#    write: false",
    "---",
    "",
    role,
    "",
  ];
  return lines.join("\n");
}

function expandPath(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
