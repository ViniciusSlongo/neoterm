# Grupos

> Vários agentes numa conversa e numa pasta de projeto.

| O quê | Como |
| --- | --- |
| Criar | `g` na lateral: pasta, membros, objetivo |
| Falar com o coordenador | escreva sem `@` (o primeiro membro responde) |
| Chamar um agente | `@nome` |
| Editar pasta, membros, objetivo | `e` na lateral ou `:edit` |
| Excluir | na edição, `ctrl+d` duas vezes |

Os agentes chamam uns aos outros com `@nome`. Com `@você`, o grupo para e te chama. Depois de 30
falas seguidas sem você, o grupo para sozinho.

Pelo terminal:

```sh
neoterm group new crm --folder ~/Projects/crm --members arquiteto,dev,revisor
neoterm group say crm "precisamos de filtro por status"
```
