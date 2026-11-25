import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { AGENTS_DIR, CLAUDE_BIN, DATABASE_FILE, readSettings, writeSettings } from "../config.ts";
import { applyMigrations, connect, errorMessage } from "../db/client.ts";
import { accent, bold, fail, muted, ok, seconds } from "./style.ts";

/*
 * `neoterm init`: confere o Claude Code, prepara o banco, cria a pasta dos agentes e guarda o
 * modelo padrão. Pode rodar de novo a qualquer hora; cada passo só faz o que falta.
 */

export async function init(options: { model?: string }): Promise<boolean> {
  const settings = await readSettings();
  const model = options.model ?? settings.defaultModel;
  let healthy = true;

  console.log(`\n${bold("neoterm")}${muted(" · configuração")}\n`);

  console.log(`${accent("1")}  ${bold("Conexão com o Claude")}`);
  const version = await capture(CLAUDE_BIN, ["--version"]);
  if (version.code !== 0) {
    console.log(`   ${fail(`não encontrei o "${CLAUDE_BIN}". Instale o Claude Code: https://code.claude.com`)}`);
    return false;
  }
  console.log(`   ${ok(`Claude Code ${version.stdout.trim().split(" ")[0]} encontrado`)}`);
  const started = Date.now();
  const test = await capture(
    CLAUDE_BIN,
    [
      "-p",
      "--output-format",
      "json",
      "--model",
      model,
      "--tools",
      "",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    "Responda apenas: ok",
  );
  const reply = parseJson(test.stdout);
  if (test.code === 0 && reply?.is_error === false) {
    console.log(`   ${ok(`logado na sua conta Claude ${muted("· usa o seu plano")}`)}`);
    console.log(`   ${ok(`teste: ${model} respondeu em ${seconds(Date.now() - started)}`)}`);
  } else {
    healthy = false;
    const why = (typeof reply?.result === "string" && reply.result) || test.stderr.trim() || "sem resposta";
    console.log(`   ${fail(`o Claude não respondeu: ${why}`)}`);
    console.log(`   ${muted("sem login? rode")} claude ${muted("e digite")} /login`);
  }

  console.log(`\n${accent("2")}  ${bold("Banco de dados")}`);
  try {
    const connection = connect();
    await applyMigrations(connection);
    connection.close();
    console.log(`   ${ok(`SQLite em ${DATABASE_FILE}`)}`);
    console.log(`   ${ok("tabelas em dia")}`);
  } catch (error) {
    console.log(`   ${fail(errorMessage(error))}`);
    return false;
  }

  console.log(`\n${accent("3")}  ${bold("Pasta dos agentes")}`);
  await mkdir(AGENTS_DIR, { recursive: true });
  console.log(`   ${ok(`${AGENTS_DIR}   ${muted("identidade e memória em .md")}`)}`);

  console.log(`\n${accent("4")}  ${bold("Modelo padrão dos agentes")}`);
  await writeSettings({ ...settings, defaultModel: model });
  console.log(`   ${ok(`${model}   ${muted("troque com: neoterm init --model <modelo>")}`)}`);

  console.log(
    healthy
      ? `\n${bold("Pronto.")} Ligue o motor com ${accent("neoterm service on")} (junto com o Mac) ou ${accent("neoterm daemon")} (neste terminal), e abra a interface com ${accent("neoterm")}.\n`
      : `\n${muted("Resolva o item acima e rode")} neoterm init ${muted("de novo.")}\n`,
  );
  return healthy;
}

type Captured = { code: number | null; stdout: string; stderr: string };

function capture(command: string, args: string[], input?: string): Promise<Captured> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
