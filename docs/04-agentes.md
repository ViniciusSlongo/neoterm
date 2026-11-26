# Agentes

> Criar, editar, esforço, memória, consultas entre agentes e processos.

## Criar e editar

| O quê | Como |
| --- | --- |
| Criar | `n` na lateral |
| Editar título, função, pastas, modelo, esforço | `e` na lateral ou `:edit` |
| Excluir | na edição, `ctrl+d` duas vezes (vai para `~/.neoterm/trash`) |
| Recomeçar do zero | `neoterm agent reset <nome>` |
| Pausar rotinas e retornos | `p` na lateral ou `:pause` |

Cada agente é uma pasta em `~/.neoterm/agents/<nome>/`:

| Arquivo | O que é |
| --- | --- |
| `AGENT.md` | título, função, pastas, modelo, esforço |
| `MEMORY.md` | o que ele lembra entre conversas |
| `notas.txt` | suas notas (`ctrl+n`) |

```markdown
---
name: analista
title: Acompanhamento financeiro
model: claude-opus-5-5
effort: high
folders:
  - "/Users/voce/Documents/Caixa"
---

Acompanha o fluxo de caixa a partir dos extratos.
```

Editou o `AGENT.md`, vale na próxima resposta.

## Pastas

O agente trabalha nas pastas escolhidas e roda na primeira.

## Esforço

Quanto o agente raciocina antes de responder: baixo (`low`), médio (`medium`), alto (`high`), muito
alto (`xhigh`) ou máximo (`max`).

| Onde | Como |
| --- | --- |
| Formulário | campo **Esforço**, `←→` |
| Conversa | `:effort high` (`:effort` mostra o atual) |
| Terminal | `neoterm agent new … --effort high` |

## Contexto

Quando a conversa chega perto do limite do modelo, o agente compacta o contexto sozinho: guarda um
resumo e segue. A conversa mostra um aviso, e o histórico na tela continua inteiro. A partir da
metade, o cabeçalho mostra quanto do contexto está em uso.

## Memória

O agente guarda fatos com `remember` e tira com `forget`, no `MEMORY.md`. Peça na conversa:
"lembra que o fechamento é dia 30".

## Consultar outro agente

Peça na conversa: "pergunta ao dev onde está a planilha". O agente consulta o outro com
`ask_agent` e responde com o que ele disse. A troca fica na conversa do consultado.

## Processos

| O quê | Como |
| --- | --- |
| Ver memória e serviços | cabeçalho da conversa, ou `:processes` |
| Encerrar um | `x` na tela de processos |
| Encerrar todos | `X` |

Agente parado há 30 minutos com serviços rodando aparece em **precisa de você**.

## Integrações

`i` na lateral mostra os MCPs do Claude Code e o status de cada um. Para conectar ou
autenticar, use `/mcp` no Claude Code.
