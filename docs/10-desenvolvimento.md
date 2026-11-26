# Desenvolvimento

> Como o código está organizado, como rodar os testes e como contribuir.

## Rodar

```sh
npm install
node src/cli/main.ts daemon     # o motor, neste terminal
node src/cli/main.ts            # a interface, em outro
```

Sem build: o Node 24 roda o TypeScript direto.

## Testes

```sh
npm test            # a suíte inteira
npm run typecheck
```

Os testes usam um **claude falso** (`test/fixtures/fake-claude.mjs`), que imita o `claude -p`:
sessões, ferramentas, chamadas MCP de verdade, falhas e respostas roteirizadas. Não gastam o plano.

O `test/harness.ts` aponta tudo para uma pasta temporária **antes** de carregar o código. Ele se
recusa a rodar se algum teste carregar `src/` antes dele, para nenhum teste mexer no seu
`~/.neoterm` de verdade. Num teste novo, importe o harness primeiro, e o resto de `src/` com
`await import(...)` depois dele, quando precisar.

## Onde fica cada coisa

| Pasta | O quê |
| --- | --- |
| `src/daemon/` | o servidor HTTP do motor (`127.0.0.1:4777`) |
| `src/runner/` | um turno: o `claude -p`, a fila por agente |
| `src/agents/` | identidade, prompt, memória, notas, consultas entre agentes |
| `src/routines/` | rotinas, retornos e o agendador |
| `src/groups/` | grupos e menções |
| `src/mcp/` | as ferramentas do neoterm, servidas aos agentes por MCP |
| `src/tui/` | a interface (Ink) |
| `src/cli/` | os comandos do terminal |
| `docs/` | esta documentação (`neoterm docs`) |

## Docs

Cada arquivo em `docs/` começa com `# Título` e uma linha `> resumo`, que é o que o
`neoterm docs` lista. O número na frente do nome define a ordem.
