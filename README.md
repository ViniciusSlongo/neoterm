# neoterm

**Agentes persistentes no terminal, com o Claude Code do seu plano.**

```
 AGENTES               │  analista  · Financeiro · ~/Documents/Caixa      ○ livre · 77 MB
 ● analista ⠹  ✎       │ ──────────────────────────────────────────────────────────────
 ○ dev                 │  ┃ quanto entrou essa semana?
 GRUPOS                │
 # fechamento          │    ⎿ Read   extratos/novembro.csv
 ROTINAS HOJE          │  ● Entraram R$ 48.200 em 12 recebimentos.
 ✓ 09:00 resumo        │    • 8 por pix · 4 por boleto
 PRECISA DE VOCÊ       │
 ! rotina backup falhou│ ──────────────────────────────────────────────────────────────
 ◆ painel            d │  > mensagem para analista · :ajuda
 ◆ integrações       i │ ──────────────────────────────────────────────────────────────
```

## Instalar

Precisa de macOS, Node 24+ e o Claude Code. O `neoterm init` usa o login dele ou abre o login.

```sh
git clone https://github.com/ViniciusSlongo/neoterm.git
cd neoterm && npm install && npm link

neoterm init
neoterm service on
neoterm
```

`n` cria o primeiro agente.

## Funcionalidades

| Funcionalidade | Como usar |
| --- | --- |
| Agentes com função e pastas | `n` cria, `e` edita |
| Conversa com imagens e markdown | escreva; cole imagens com cmd+v |
| Rotinas | "todo dia às 9h, …" na conversa, ou `r` |
| Grupos | `g` cria; `@nome` chama um agente |
| Consulta entre agentes | "pergunta ao dev …" na conversa |
| Esforço por agente | `:esforço alto` |
| Notas e tarefas | `ctrl+n`; `ctrl+t` cria tarefa |
| Processos e memória | `:processos` |
| Painel | `d` |
| Integrações (MCP) | `i` |
| Cor e modelo padrão | `c` |
| Tudo pelo terminal | `neoterm ask analista "…"` |

## Documentação

```sh
neoterm docs            # lista
neoterm docs agentes    # abre um tópico
```

| | Tópico |
| --- | --- |
| 1 | [Começar](docs/01-comecar.md) |
| 2 | [A interface](docs/02-interface.md) |
| 3 | [Comandos e teclas](docs/03-comandos.md) |
| 4 | [Agentes](docs/04-agentes.md) |
| 5 | [Rotinas e retornos](docs/05-rotinas.md) |
| 6 | [Grupos](docs/06-grupos.md) |
| 7 | [Pelo terminal](docs/07-terminal.md) |
| 8 | [Desenvolvimento](docs/08-desenvolvimento.md) |

---

[MIT](LICENSE)
