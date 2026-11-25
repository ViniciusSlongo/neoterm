# neoterm

Agentes persistentes no terminal: cada um com identidade, função e escopo próprios, rodando com o
Claude Code do seu plano. Inspirado no [OpenBot](https://github.com/CopilotKit/OpenBot) (MIT).

## Precisa de

- Node 24 ou mais novo
- Docker (para o Postgres)
- [Claude Code](https://code.claude.com) instalado e logado (`claude`, depois `/login`)

## Começar

```sh
npm install
node src/cli/main.ts init          # confere o Claude Code, sobe o banco, cria ~/.neoterm
node src/cli/main.ts daemon        # o motor: deixe rodando num terminal
```

Em outro terminal:

```sh
node src/cli/main.ts agent new analista --title "Acompanhamento financeiro" \
  --role "Acompanha o fluxo de caixa a partir dos extratos e avisa o que foge do padrão."
node src/cli/main.ts ask analista "o que você consegue fazer?"
node src/cli/main.ts history analista
```

Com `npm link`, o comando vira só `neoterm`.

## Onde fica cada coisa

| O quê | Onde | Quem escreve |
| --- | --- | --- |
| Identidade, função e escopo | `~/.neoterm/agents/<nome>/AGENT.md` | você |
| Memória do agente | `~/.neoterm/agents/<nome>/MEMORY.md` | o agente (em breve) |
| O que todos sabem sobre você | `~/.neoterm/USER.md` | você |
| Pasta de trabalho | `~/.neoterm/agents/<nome>/workspace/` | o agente |
| Conversas e execuções | Postgres (`neoterm-db`, 127.0.0.1:5433) | o motor |

O `AGENT.md` é lido de novo a cada turno: editou, vale na próxima resposta.

```markdown
---
name: Analista
title: Acompanhamento financeiro
model: claude-opus-5-5           # opcional; sem isto usa o padrão
tools: [Read, Glob, Grep, Write, Edit, Bash, WebSearch, WebFetch]   # com você
unattended: [Read, Glob, Grep, WebSearch, WebFetch]                 # sozinho, em rotinas
folders:
  - path: ~/Documents/Financeiro
    write: false                 # só leitura
---
Acompanhar o fluxo de caixa a partir dos extratos em workspace/extratos...
```

## Como funciona

Cada turno de um agente é uma execução do `claude -p` oficial, com o login que você já fez nele.
O neoterm nunca lê nem guarda senha ou token.

- **Identidade:** vai em `--append-system-prompt`: quem ele é, a função, as pastas, o que sabe de
  você, a memória dele, se tem alguém olhando e a data.
- **Escopo:** é `--tools`. O agente só tem as ferramentas da lista: `tools` quando você está
  conversando, `unattended` quando roda sozinho. Uma pasta com `write: false` ganha uma regra
  `Edit(...)` negada, que o Claude Code aplica a toda ferramenta que edita arquivos. Quem tem `Bash`
  ainda consegue escrever pelo terminal, então não dê `Bash` a quem não deve mexer numa pasta.
- **Conversa:** cada agente tem uma sessão do Claude Code (`--session-id`, depois `--resume`), e o
  que ele faz e diz fica no Postgres.
- **Fila:** cada agente faz um turno por vez; agentes diferentes rodam ao mesmo tempo.
- **Configuração sua fora:** `--setting-sources project` e `--strict-mcp-config` deixam de fora os
  seus hooks, plugins e servidores MCP. O agente tem só o que o `AGENT.md` dá.

## Testes

```sh
npm test
npm run typecheck
```

## Próximos passos

1. ~~Motor, agentes com identidade e escopo, conversa pelo `claude`~~
2. Rotinas: cron com fuso, mínimo de 15 min, desliga após 10 falhas seguidas, pula horários perdidos
3. Ferramentas do agente: criar e mudar rotinas conversando, memória
4. Grupos: agentes conversando no mesmo projeto e chamando uns aos outros com `@nome`
5. Ciclo de vida: pausar, retomar, resetar, excluir
6. Eventos em tempo real e a interface de terminal
