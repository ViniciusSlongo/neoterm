# neoterm

Agentes persistentes no terminal. Cada um tem identidade, função e escopo próprios, roda rotinas
sozinho e conversa com os colegas em grupos. Tudo roda pelo Claude Code do seu plano.
Inspirado no [OpenBot](https://github.com/CopilotKit/OpenBot) (MIT).

## Precisa de

- Node 24 ou mais novo (o neoterm usa o `node:sqlite` e roda TypeScript direto, sem build)
- [Claude Code](https://code.claude.com) instalado e logado (`claude`, depois `/login`)

Não precisa de Docker nem de banco externo: o banco é um arquivo SQLite em `~/.neoterm`.

## Começar

```sh
npm install
npm link                    # opcional: deixa o comando `neoterm` disponível
neoterm init                # confere o Claude Code, cria ~/.neoterm e o banco
neoterm service on          # liga o motor junto com o Mac (ou: neoterm daemon, num terminal)
neoterm                     # abre a interface
```

Sem `npm link`, use `node src/cli/main.ts` no lugar de `neoterm`. Funciona de qualquer pasta: os
dados ficam em `~/.neoterm`.

## O motor

O motor (`daemon`) dispara as rotinas e os retornos, roda os turnos dos agentes e toca os grupos. A
interface e o CLI só conversam com ele, em `127.0.0.1:4777`. Fechar a interface não para nada.

```sh
neoterm service on          # liga junto com o Mac, pelo launchd
neoterm service status      # está rodando? com qual pid?
neoterm service restart     # depois de atualizar o código do neoterm
neoterm service off         # para e não liga mais sozinho
neoterm daemon              # ou: roda neste terminal, até o ctrl+c
```

- **Quando sobe:** quando você entra na sua conta do Mac, não antes. O Claude Code lê o seu login
  nas Chaves, que só abrem com você logado. Se o motor cair, o launchd liga de novo.
- **Com o Mac dormindo nada roda.** Horários perdidos são pulados, como com o motor desligado.
- **Ambiente:** o serviço usa o `node`, o `claude` e o PATH do terminal onde você rodou
  `neoterm service on`. Mudou de lugar algum deles (outro Node, outro PATH)? Rode `on` de novo.
- **Log:** `~/.neoterm/daemon.log`.
- **Pastas protegidas do macOS** (Documentos, Mesa, Downloads, iCloud): rodando pelo launchd, quem
  acessa é o `node`, não o seu terminal. O macOS pode pedir permissão na primeira vez ou bloquear.
  Se um agente não conseguir ler uma pasta dessas, libere o `node` em Ajustes do Sistema →
  Privacidade e Segurança → Acesso Total ao Disco.

## A interface

```
 AGENTES            │ analista · Acompanhamento financeiro        ○ livre
 ● analista         │ ──────────────────────────────────────────────────
 ‖ suporte  pausado │ › quanto entrou essa semana?
 GRUPOS             │   ⎿ Read   workspace/extratos/novembro.csv
 # crm              │   Entraram R$ 48.200 em 12 recebimentos.
 ROTINAS HOJE       │
 ✓ 09:00 resumo     │ ╭─────────────────────────────────────────────────╮
 PRECISA DE VOCÊ    │ │ > mensagem para analista · /ajuda               │
 ! analista quer …  │ ╰─────────────────────────────────────────────────╯
```

- **Na conversa:** `enter` envia; `esc` vai para a lateral; `↑↓` (sem texto) troca de agente;
  `pgup`/`pgdn` rola; `ctrl+r` abre as rotinas. Num grupo, `@nome` chama um agente.
- **Na lateral:** `↑↓` escolhe; `enter` abre; `n` cria um agente; `g` cria um grupo; `r` abre as
  rotinas; `p` pausa ou retoma; `q` sai.
- **Nas rotinas:** `n` cria; `espaço` liga ou desliga; `x` roda agora; `d d` apaga.
- **Em "precisa de você":** `s` libera um acesso pedido; `x` dispensa; `enter` abre o assunto.

## O CLI

```sh
neoterm agents
neoterm agent new analista --title "Acompanhamento financeiro" --role "Acompanha o caixa…"
neoterm agent pause|resume analista
neoterm agent reset analista        # mostra o que vai apagar e pede confirmação
neoterm agent delete analista       # manda para ~/.neoterm/trash
neoterm ask analista "quanto entrou hoje?"
neoterm history analista            # ou: neoterm history '#crm'

neoterm routines [analista]
neoterm routine add analista --title resumo --cron "0 9 * * 1-5" --do "resuma os extratos" [--notify] [--group crm]
neoterm routine run|on|off|rm <id>

neoterm group new crm --folder ~/Projects/crm --members arquiteto,dev,revisor [--objective "…"]
neoterm group say crm "precisamos de filtro por status"
neoterm attention
```

## Onde fica cada coisa

| O quê | Onde | Quem escreve |
| --- | --- | --- |
| Identidade, função e escopo | `~/.neoterm/agents/<nome>/AGENT.md` | você |
| Memória do agente | `~/.neoterm/agents/<nome>/MEMORY.md` | o agente (`remember`/`forget`) e você |
| O que todos sabem sobre você | `~/.neoterm/USER.md` | você |
| Pasta de trabalho | `~/.neoterm/agents/<nome>/workspace/` | o agente |
| Conversas, execuções, rotinas, grupos, avisos | `~/.neoterm/neoterm.db` (SQLite) | o motor |
| Agentes excluídos | `~/.neoterm/trash/` | o motor |

O `AGENT.md` é lido de novo a cada turno: editou, vale na próxima resposta.

```markdown
---
name: Analista
title: Acompanhamento financeiro
model: claude-opus-5-5           # opcional; sem isto, o padrão do neoterm init
tools: [Read, Glob, Grep, Write, Edit, Bash, WebSearch, WebFetch]   # com você
unattended: [Read, Glob, Grep, WebSearch, WebFetch]                 # sozinho, em rotinas
folders:
  - path: ~/Documents/Financeiro
    write: false                 # só leitura
---
Acompanhar o fluxo de caixa a partir dos extratos em workspace/extratos…
```

## Como funciona

**Cada turno é um `claude -p` oficial**, com o login que você já fez nele. O neoterm nunca lê nem
guarda senha ou token.

- **Identidade e contexto** vão em `--append-system-prompt`, montado a cada turno: quem ele é, a
  função, as pastas, o que sabe de você, a memória, se tem alguém olhando e quais ferramentas tem
  agora. O neoterm passa `--system-prompt-snapshot off`, porque por padrão o Claude Code congela o
  prompt de sistema na primeira mensagem e uma edição do `AGENT.md` não chegaria às conversas já
  começadas.
- **Escopo é `--tools`:** o agente só tem as ferramentas da lista, `tools` com você e `unattended`
  sozinho. A lista de liberadas não basta, porque o Claude Code libera sozinho comandos de leitura.
  Uma pasta com `write: false` ganha uma regra `Edit(...)` negada. Quem tem `Bash` ainda escreve
  pelo terminal, então não dê `Bash` a quem não deve mexer numa pasta.
- **Sua configuração fica de fora:** `--setting-sources project` e `--strict-mcp-config` deixam de
  fora seus hooks, plugins e servidores MCP. O agente tem só o que o `AGENT.md` dá, mais as
  ferramentas do neoterm.
- **As ferramentas do neoterm** vêm por MCP, servidas pelo próprio motor: criar, listar, mudar e
  apagar rotinas; agendar um retorno; lembrar e esquecer; pedir acesso. Cada execução recebe uma
  chave própria, que diz quem está chamando; o modelo não escolhe em nome de quem age.
- **Avisos na conversa:** quando você libera um acesso ou uma rotina falha, o próximo turno do
  agente começa com esses avisos.
- **Fila:** um agente faz um turno por vez, e um grupo fala um de cada vez.

### Rotinas (regras do OpenBot)

- Cron de 5 campos, com fuso; no máximo uma vez a cada 15 minutos; no máximo 20 ligadas.
- **Agir** usa o escopo sozinho. **Só avisar** usa apenas ferramentas de leitura.
- Horários perdidos com o motor desligado são pulados, não repetidos (tolerância de 10 minutos).
- **Regra do cansaço:** avisa na primeira falha e desliga depois de 10 falhas seguidas. Religar zera
  a contagem.
- Sem a ferramenta que precisa, a rotina pede acesso. Você libera em "precisa de você".

### Grupos

- Um grupo é um projeto: uma pasta, uma conversa e os agentes. Cada um entra com a própria função e
  escopo e trabalha na pasta do projeto, com uma sessão própria nesse grupo.
- Sem `@nome`, quem responde é o coordenador (o primeiro membro). Um agente que escreve `@colega`
  passa a vez; `@você` para o grupo e te chama.
- Freio único, sem configuração: depois de 30 falas seguidas de agentes sem você, o grupo para e te
  chama.

### Ciclo de vida

- **Pausar:** segura rotinas, retornos e chamadas de colegas. A conversa com você continua.
- **Recomeçar:** mostra o que vai apagar (conversas, rotinas, retornos, memória, sessões em grupos),
  pede confirmação e mantém o `AGENT.md`.
- **Excluir:** manda a pasta para a lixeira e libera o nome.

## Testes

```sh
npm test            # 72 testes, com um "claude falso" (test/fixtures/fake-claude.mjs)
npm run typecheck
```

O claude falso imita o `claude -p`: sessões, ferramentas, chamadas MCP de verdade, falhas e
respostas roteirizadas por agente. Os testes não gastam o plano.
