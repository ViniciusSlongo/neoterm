/*
 * Quem foi chamado numa mensagem: @nome de um membro do grupo, ou @você para a pessoa.
 * O que está dentro de blocos de código não conta, para um "@decorator" num trecho de código não
 * acordar ninguém.
 */

export type Member = { slug: string; name: string };

const PERSON = new Set(["voce", "vc", "pessoa"]);

export function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

export function findMentions(text: string, members: readonly Member[]): { agents: string[]; person: boolean } {
  const bySlug = new Map<string, string>();
  for (const member of members) {
    bySlug.set(normalizeName(member.slug), member.slug);
    const name = normalizeName(member.name);
    bySlug.set(name.replace(/\s+/g, ""), member.slug);
    bySlug.set(name.split(/\s+/)[0] ?? name, member.slug);
  }
  const agents: string[] = [];
  let person = false;
  for (const match of withoutCode(text).matchAll(/(^|[^\p{L}\p{N}_@.])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu)) {
    const token = normalizeName(match[2] ?? "").replace(/[-_]+$/, "");
    if (PERSON.has(token)) {
      person = true;
      continue;
    }
    const slug = bySlug.get(token);
    if (slug && !agents.includes(slug)) agents.push(slug);
  }
  return { agents, person };
}
