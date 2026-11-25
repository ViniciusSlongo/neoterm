import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AGENTS_DIR, isMissingFile } from "../config.ts";

/*
 * Quem um agente é mora num arquivo que a pessoa pode abrir no editor: ~/.neoterm/agents/<slug>/AGENT.md.
 * O cabeçalho YAML diz o nome, o título, o modelo e as pastas; o corpo é a função, em texto livre.
 * É lido de novo a cada turno, então uma edição vale a partir da próxima resposta.
 */

export const AGENT_FILE = "AGENT.md";
export const MEMORY_FILE = "MEMORY.md";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Uma pasta é só o caminho. Aceita também `{ path: … }`, o formato de antes.
const Folder = z.union([z.string().min(1), z.object({ path: z.string().min(1) }).transform((folder) => folder.path)]);

const Frontmatter = z.object({
  name: z.string().min(1),
  title: z.string().default(""),
  model: z.string().min(1).optional(),
  folders: z.array(Folder).default([]),
});

export type AgentDefinition = {
  slug: string;
  /** A pasta do agente: AGENT.md e MEMORY.md. */
  dir: string;
  /** Onde ele roda: a primeira das pastas (ou workspace/, num AGENT.md sem pastas). */
  workspace: string;
  name: string;
  title: string;
  /** A função: o corpo do AGENT.md. */
  role: string;
  model?: string;
  /** O escopo: as pastas do computador em que ele trabalha, com caminho absoluto. */
  folders: string[];
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
  const folders = unique(front.folders.map((folder) => expandPath(folder, dir)));
  // Sem pastas (um AGENT.md escrito à mão), ele trabalha numa pasta própria, workspace/.
  const workspace = folders[0] ?? join(dir, "workspace");
  const role = body.trim();
  if (!role) throw new AgentProblem(slug, `${AGENT_FILE} está sem a função (o texto depois do cabeçalho)`);
  return {
    slug,
    dir,
    workspace,
    name: front.name,
    title: front.title,
    role,
    ...(front.model ? { model: front.model } : {}),
    folders,
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
  if (agent.folders.length === 0) {
    await mkdir(agent.workspace, { recursive: true });
    return agent;
  }
  // As pastas são da pessoa: o neoterm nunca cria nem apaga. Se uma sumiu, o agente vira um problema.
  for (const folder of agent.folders) {
    if (!(await isDirectory(folder))) {
      throw new AgentProblem(slug, `a pasta ${folder} não existe mais. Corrija as pastas no ${AGENT_FILE}`);
    }
  }
  // O caminho real (no Mac, /tmp é /private/tmp), para comparar com a pasta de um grupo.
  agent.folders = unique(await Promise.all(agent.folders.map((folder) => realpath(folder))));
  agent.workspace = agent.folders[0]!;
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
  /** O escopo: pastas que já existem, com caminho absoluto ou ~. Ele roda na primeira. */
  folders: string[];
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
  const folders = await resolveFolders(input.slug, input.folders);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, AGENT_FILE), agentTemplate({ ...input, folders }), { encoding: "utf8", flag: "wx" });
  if (!(await exists(join(dir, MEMORY_FILE)))) {
    await writeFile(join(dir, MEMORY_FILE), "", "utf8");
  }
  return loadAgent(input.slug);
}

/** Confere as pastas de um agente novo: pelo menos uma, e todas já existindo. */
async function resolveFolders(slug: string, folders: readonly string[] | undefined): Promise<string[]> {
  const given = (folders ?? []).map((folder) => folder.trim()).filter(Boolean);
  if (given.length === 0) throw new AgentProblem(slug, "escolha pelo menos uma pasta: o escopo onde o agente vai trabalhar");
  const resolved: string[] = [];
  for (const folder of given) {
    if (!folder.startsWith("~") && !isAbsolute(folder)) {
      throw new AgentProblem(slug, `a pasta precisa de um caminho completo: ${folder}`);
    }
    const absolute = expandPath(folder, homedir());
    if (!(await isDirectory(absolute))) throw new AgentProblem(slug, `a pasta ${absolute} não existe`);
    resolved.push(await realpath(absolute));
  }
  return unique(resolved);
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
    "# Escopo: as pastas do computador em que ele trabalha. Roda na primeira.",
    "folders:",
    ...input.folders.map((folder) => `  - ${yamlString(folder)}`),
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
