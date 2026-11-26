# Agentes

> Quem um agente é, onde ele mora, a memória dele, consultar colegas e os processos que ele deixa rodando.

Um agente é uma pasta em `~/.neoterm/agents/<nome>/`, com um arquivo que você pode abrir em qualquer
editor:

```markdown
---
name: analista
title: Acompanhamento financeiro
model: claude-opus-5-5        # opcional; sem isto, o padrão do neoterm
effort: high                  # opcional: low, medium, high, xhigh, max
folders:                      # o escopo: as pastas em que ele trabalha; roda na primeira
  - "/Users/voce/Documents/Caixa"
  - "/Users/voce/Downloads/extratos"
---

Acompanha o fluxo de caixa a partir dos extratos. Responde com números, e avisa
quando um recebimento esperado não entrou.
```

O `AGENT.md` é lido de novo a cada turno: mudou, vale na próxima resposta.

## Criar, editar e excluir

- **Criar**: `n` na lateral, ou `neoterm agent new`.
- **Editar**: `e` na lateral ou `:editar` na conversa. Muda título, função, pastas e modelo, e
  preserva o que você escreveu à mão no cabeçalho.
- **Excluir**: na edição, `ctrl+d` duas vezes. A pasta dele vai para `~/.neoterm/trash` (dá para
  recuperar), as rotinas desligam e ele sai dos grupos. As pastas do escopo nunca são tocadas.
- **Recomeçar do zero**: `neoterm agent reset <nome>` apaga conversas, rotinas e memória e mantém o
  `AGENT.md`. Mostra o que vai apagar e pede confirmação.

## Esforço

Quanto o agente raciocina antes de agir: **baixo**, **médio**, **alto**, **muito alto** ou
**máximo** (o `--effort` do Claude Code). Mais esforço dá respostas mais cuidadosas, mais lentas e
que gastam mais do plano. Sem escolher, vale o padrão do Claude Code.

- Na criação ou na edição (`e`), no campo **Esforço**, com `←→`.
- Na conversa: `:esforço` mostra o atual; `:esforço alto` muda (também `baixo`, `médio`,
  `muito alto`, `máximo` e `padrão`).
- No terminal: `neoterm agent new … --effort high`.

Vale a partir da próxima resposta, e aparece no cabeçalho da conversa.

## O que fica na pasta do agente

| Arquivo | O que é | Quem escreve |
| --- | --- | --- |
| `AGENT.md` | identidade, função, pastas, modelo | você |
| `MEMORY.md` | o que ele lembra entre conversas | ele (`remember`, `forget`) e você |
| `notas.txt` | suas anotações (`:notas`); ele não vê | você |

E em `~/.neoterm/USER.md`, o que todos os agentes sabem sobre você.

## Escopo

As pastas são o escopo: ele roda na primeira e as outras vão junto. **É uma orientação, não uma
trava**: os agentes rodam sem pedir permissão, como você rodaria o Claude Code, e nada impede um
agente de ir além. Escolha agentes e pastas com isso em mente (veja `neoterm docs seguranca`).

## Ferramentas que todo agente tem

Além das ferramentas do Claude Code (ler, escrever, rodar comandos), cada agente recebe as do
neoterm:

- **Rotinas**: criar, listar, mudar e apagar as dele (`neoterm docs rotinas`)
- **Retornos**: voltar à conversa sozinho daqui a um tempo
- **Memória**: `remember` e `forget`
- **Consultar um colega** (`ask_agent`): pergunta a outro agente e espera a resposta. O consultado
  responde num turno dele, e a troca fica na conversa dele com você. Recusa na hora se o outro
  estiver ocupado ou pausado, e quem responde uma consulta não consulta mais ninguém: nada de
  cadeias.

## Processos e memória

Tudo o que um agente roda leva uma marca, então o neoterm sabe o que é de quem, mesmo depois que o
turno acabou:

- No cabeçalho da conversa: a memória do agente e quantos serviços ele deixou rodando (`◆`).
- `:processos` (ou `s` na lateral): cada processo com memória, tempo de vida e porta. `x` encerra
  um, `X` encerra todos os serviços. Só encerra o que é daquele agente.
- Se um agente fica **30 minutos parado** com serviços rodando, aparece um aviso em **precisa de
  você**. O neoterm não encerra nada sozinho: um agente com rotinas pode ter deixado algo de pé de
  propósito.

Não aparecem: programas do sistema da Apple e contêineres do Docker.

## Integrações (MCP)

A tela de integrações (`i`) mostra os MCPs que o seu Claude Code tem: os conectores da conta
claude.ai, os que você adicionou e os `.mcp.json` das pastas dos agentes. Só para ver; quem conecta
e autentica é o Claude Code (`/mcp`, `claude mcp add`).

Os agentes **não** usam essas integrações hoje: rodam só com as ferramentas do neoterm. A
configuração da pasta do projeto (`CLAUDE.md`, `.claude/`) vale para eles, como valeria para você.
