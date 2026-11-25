import { z } from "zod";
import { agentDir } from "../agents/identity.ts";
import { forget, MemoryRefused, remember } from "../agents/memory.ts";
import type { Database } from "../db/client.ts";
import type { EventBus } from "../events.ts";
import { FollowupRefused, scheduleFollowup } from "../routines/followups.ts";
import { describeWhen } from "../routines/schedule.ts";
import {
  createRoutine,
  deleteRoutine,
  describeRoutine,
  findRoutine,
  listRoutines,
  RoutineRefused,
  updateRoutine,
} from "../routines/store.ts";
import { type ToolCaller, type ToolDefinition, ToolRefusal } from "./hub.ts";

/* As ferramentas que todo agente recebe: rotinas, retornos e memória. */

const Mode = z.enum(["act", "notify"]);

const CRON_HELP =
  "Expressão cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana), no fuso da pessoa. Ex.: '0 9 * * 1-5' = dias úteis às 9h; '0 17 * * 5' = sexta às 17h; '30 8 1 * *' = dia 1 às 8h30. No máximo uma vez a cada 15 minutos.";

/** Recusas das regras viram texto para o agente; o resto continua erro. */
async function asAnswer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RoutineRefused || error instanceof FollowupRefused || error instanceof MemoryRefused) {
      throw new ToolRefusal(`Não deu: ${error.message}.`);
    }
    throw error;
  }
}

export function neotermTools(deps: { db: Database; bus: EventBus; now?: () => Date }): ToolDefinition[] {
  const { db, bus } = deps;
  const now = deps.now ?? (() => new Date());

  const routineOf = async (caller: ToolCaller, ref: string) => {
    const routine = await findRoutine(db, caller.agentId, ref);
    if (!routine) throw new ToolRefusal(`Não achei uma rotina sua chamada "${ref}". Use list_routines para ver as suas.`);
    return routine;
  };

  return [
    {
      name: "create_routine",
      description:
        "Cria uma rotina: algo que você fará sozinho, num horário, até a pessoa desligar. Use quando a pessoa pedir algo recorrente ('todo dia', 'toda sexta às 17h'). A resposta da rotina aparece nesta mesma conversa. Antes de criar, diga em palavras quando ela vai rodar.",
      schema: z.object({
        title: z.string().min(1).describe("Nome curto, ex.: resumo-diario"),
        instruction: z.string().min(1).describe("O que fazer a cada vez, completo, como se você fosse ler sem esta conversa"),
        cron: z.string().min(1).describe(CRON_HELP),
        timezone: z.string().optional().describe("Fuso IANA; sem isto, o da pessoa"),
        mode: Mode.default("act").describe("act = faz o que a rotina pede; notify = só verifica e avisa, sem mudar nada"),
      }),
      run: (caller, args) =>
        asAnswer(async () => {
          const input = args as { title: string; instruction: string; cron: string; timezone?: string; mode: "act" | "notify" };
          const routine = await createRoutine(db, {
            agentId: caller.agentId,
            conversationId: caller.conversationId,
            title: input.title,
            instruction: input.instruction,
            cron: input.cron,
            timezone: input.timezone ?? caller.timeZone,
            mode: input.mode,
            now: now(),
          });
          bus.changed("routines");
          return `Rotina criada: ${describeRoutine(routine, now())}`;
        }),
    },
    {
      name: "list_routines",
      description: "Lista as suas rotinas, ligadas e desligadas, com o próximo horário.",
      schema: z.object({}),
      run: async (caller) => {
        const list = await listRoutines(db, { agentId: caller.agentId });
        if (list.length === 0) return "Você não tem rotinas.";
        return list.map((routine) => `- ${describeRoutine(routine, now())}${routine.group ? ` · no grupo #${routine.group}` : ""}`).join("\n");
      },
    },
    {
      name: "update_routine",
      description: "Muda uma rotina sua: nome, instrução, horário, modo, ou liga/desliga (enabled).",
      schema: z.object({
        routine: z.string().min(1).describe("O id ou o nome da rotina"),
        title: z.string().min(1).optional(),
        instruction: z.string().min(1).optional(),
        cron: z.string().min(1).optional().describe(CRON_HELP),
        timezone: z.string().optional(),
        mode: Mode.optional(),
        enabled: z.boolean().optional(),
      }),
      run: (caller, args) =>
        asAnswer(async () => {
          const { routine: ref, ...patch } = args as { routine: string } & Record<string, unknown>;
          const routine = await routineOf(caller, ref);
          const updated = await updateRoutine(db, routine, patch, now());
          bus.changed("routines");
          return `Rotina atualizada: ${describeRoutine(updated, now())}`;
        }),
    },
    {
      name: "delete_routine",
      description: "Apaga uma rotina sua. Para só pausar, prefira update_routine com enabled=false.",
      schema: z.object({ routine: z.string().min(1).describe("O id ou o nome da rotina") }),
      run: async (caller, args) => {
        const routine = await routineOf(caller, String(args.routine));
        await deleteRoutine(db, routine.id);
        bus.changed("routines");
        return `Rotina ${routine.title} apagada.`;
      },
    },
    {
      name: "schedule_followup",
      description:
        "Agenda um retorno seu: daqui a N minutos você volta a esta conversa, sozinho, com o motivo que deixar aqui. Use para conferir algo depois ('vejo o build de novo em 1 hora'). Entre 1 minuto e 7 dias.",
      schema: z.object({
        minutes: z.number().int().min(1).max(7 * 24 * 60).describe("Daqui a quantos minutos"),
        reason: z.string().min(1).describe("Por que vai voltar, numa frase"),
        instruction: z.string().optional().describe("O que fazer ao voltar, se for mais que o motivo"),
      }),
      run: (caller, args) =>
        asAnswer(async () => {
          const input = args as { minutes: number; reason: string; instruction?: string };
          const followup = await scheduleFollowup(db, {
            agentId: caller.agentId,
            conversationId: caller.conversationId,
            minutes: input.minutes,
            reason: input.reason,
            ...(input.instruction ? { instruction: input.instruction } : {}),
            now: now(),
          });
          bus.changed("routines");
          return `Retorno agendado para ${describeWhen(followup.dueAt, caller.timeZone, now())}: ${followup.reason}`;
        }),
    },
    {
      name: "remember",
      description:
        "Guarda um fato durável na sua memória (MEMORY.md), que você verá em toda conversa: preferências da pessoa, nomes, onde fica cada coisa. Não use para o que só vale nesta conversa.",
      schema: z.object({ fact: z.string().min(1).describe("O fato, numa frase") }),
      run: (caller, args) =>
        asAnswer(async () => {
          const result = await remember(agentDir(caller.slug), String(args.fact), now(), caller.timeZone);
          return `${result[0]?.toUpperCase()}${result.slice(1)}.`;
        }),
    },
    {
      name: "forget",
      description: "Tira da sua memória as linhas que contêm um trecho de texto.",
      schema: z.object({ text: z.string().min(1).describe("Um trecho da linha a esquecer") }),
      run: (caller, args) =>
        asAnswer(async () => {
          const removed = await forget(agentDir(caller.slug), String(args.text));
          return removed > 0 ? `Esqueci ${removed} linha(s).` : "Nada na memória com esse texto.";
        }),
    },
  ];
}
