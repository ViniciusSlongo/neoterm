# Desenvolvimento

> Rodar do código e testar.

```sh
npm install
node src/cli/main.ts daemon      # motor
node src/cli/main.ts             # interface
npm test                         # testes (não gastam o plano)
npm run typecheck
```

| Pasta | O quê |
| --- | --- |
| `src/daemon/` | servidor do motor |
| `src/runner/` | turnos dos agentes |
| `src/agents/` | identidade, memória, notas, consultas |
| `src/routines/` | rotinas e retornos |
| `src/groups/` | grupos |
| `src/tui/` | interface |
| `src/cli/` | comandos do terminal |
| `docs/` | esta documentação |

Num teste, importe `test/harness.ts` antes de qualquer coisa de `src/`.

Cada doc começa com `# Título` e `> resumo`; o número no nome do arquivo é a ordem.
