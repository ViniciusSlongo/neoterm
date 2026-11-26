/*
 * As notas também servem de lista de tarefas, no formato do markdown: `- [ ] fazer` é uma tarefa
 * aberta, `- [x] feito` uma feita. Continua sendo texto puro no notas.txt.
 */

const TASK = /^(\s*)[-*] \[( |x|X)\] ?(.*)$/;

export type TaskLine = { indent: string; done: boolean; text: string };

export function parseTask(line: string): TaskLine | null {
  const match = TASK.exec(line);
  return match ? { indent: match[1]!, done: match[2] !== " ", text: match[3]! } : null;
}

/** Quantas tarefas abertas e feitas há no texto. */
export function countTasks(text: string): { open: number; done: number } {
  let open = 0;
  let done = 0;
  for (const line of text.split("\n")) {
    const task = parseTask(line);
    if (task) task.done ? done++ : open++;
  }
  return { open, done };
}

/**
 * Marca ou desmarca a tarefa de uma linha. Uma linha que não é tarefa vira uma (aberta); uma vazia
 * vira o começo de uma.
 */
export function toggleTask(line: string): string {
  const task = parseTask(line);
  if (task) return `${task.indent}- [${task.done ? " " : "x"}] ${task.text}`;
  const [, indent = "", rest = ""] = /^(\s*)(.*)$/.exec(line) ?? [];
  return `${indent}- [ ] ${rest.replace(/^[-*]\s+/, "")}`;
}
