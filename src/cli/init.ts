import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { AGENTS_DIR, DATABASE_FILE, readSettings, writeSettings } from "../config.ts";
import { applyMigrations, connect, errorMessage } from "../db/client.ts";
import { PROVIDERS, type Provider, type ProviderStatus } from "../providers.ts";
import { accent, bold, fail, muted, ok } from "./style.ts";

/*
 * `neoterm init`: o provedor (com login), o banco, a pasta dos agentes e o modelo padrão. Pode
 * rodar de novo a qualquer hora; cada passo só faz o que falta.
 */

const plan = (status: ProviderStatus) => (status.state === "logged-in" && status.plan ? muted(` · plano ${status.plan}`) : "");

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/** O provedor: usa o que já tem login; sem nenhum, pede para escolher e abre o login dele. */
async function provider(saved: string | undefined): Promise<Provider | null> {
  const found = await Promise.all(PROVIDERS.map(async (entry) => ({ entry, status: await entry.status() })));
  const logged = found.filter((item) => item.status.state === "logged-in");
  const current = logged.find((item) => item.entry.id === saved) ?? logged[0];
  if (current) {
    console.log(`   ${ok(`${current.entry.name} conectado${plan(current.status)}`)}`);
    return current.entry;
  }

  const available = found.filter((item) => item.status.state !== "missing");
  if (available.length === 0) {
    console.log(`   ${fail(`nenhum provedor instalado (${PROVIDERS.map((entry) => entry.command).join(", ")} não está no PATH)`)}`);
    return null;
  }
  let chosen = available[0]!.entry;
  if (available.length > 1) {
    console.log(`   ${muted("nenhum provedor conectado. Escolha um:")}`);
    available.forEach((item, at) => console.log(`     ${accent(String(at + 1))}  ${item.entry.name}`));
    const answer = Number(await ask(`   ${muted("número:")} `));
    chosen = available[answer - 1]?.entry ?? chosen;
  } else {
    console.log(`   ${muted(`${chosen.name} sem login. Abrindo o login dele…`)}\n`);
  }
  await chosen.login();
  const after = await chosen.status();
  if (after.state !== "logged-in") {
    console.log(`\n   ${fail(`${chosen.name} continua sem login`)}`);
    return null;
  }
  console.log(`\n   ${ok(`${chosen.name} conectado${plan(after)}`)}`);
  return chosen;
}

export async function init(options: { model?: string }): Promise<boolean> {
  const settings = await readSettings();
  const model = options.model ?? settings.defaultModel;

  console.log(`\n${bold("neoterm")}${muted(" · configuração")}\n`);

  console.log(`${accent("1")}  ${bold("Provedor")}`);
  const chosen = await provider(settings.provider);
  if (!chosen) {
    console.log(`\n${muted("Conecte um provedor e rode")} neoterm init ${muted("de novo.")}\n`);
    return false;
  }

  console.log(`\n${accent("2")}  ${bold("Banco de dados")}`);
  try {
    const connection = connect();
    await applyMigrations(connection);
    connection.close();
    console.log(`   ${ok(DATABASE_FILE)}`);
  } catch (error) {
    console.log(`   ${fail(errorMessage(error))}`);
    return false;
  }

  console.log(`\n${accent("3")}  ${bold("Pasta dos agentes")}`);
  await mkdir(AGENTS_DIR, { recursive: true });
  console.log(`   ${ok(AGENTS_DIR)}`);

  console.log(`\n${accent("4")}  ${bold("Modelo padrão")}`);
  await writeSettings({ ...settings, provider: chosen.id, defaultModel: model });
  console.log(`   ${ok(`${model}   ${muted("troque em :config ou com neoterm init --model <modelo>")}`)}`);

  console.log(`\n${bold("Pronto.")} ${accent("neoterm service on")} liga o motor; ${accent("neoterm")} abre a interface.\n`);
  return true;
}
