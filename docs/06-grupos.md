# Grupos

> Vários agentes num projeto, conversando entre si e com você.

Um grupo é uma pasta de projeto, uma conversa e alguns agentes. Cada um entra com a própria função,
roda na pasta do projeto e leva as pastas dele junto.

```sh
neoterm group new crm --folder ~/Projects/crm --members arquiteto,dev,revisor
```

Ou `g` na lateral: escolha a pasta na lista (`espaço`), marque os membros e salve.

## Como a conversa anda

- Sem `@nome`, quem responde é o **coordenador**: o primeiro membro.
- `@dev` chama um agente. Um agente que escreve `@colega` passa a vez.
- `@você` para o grupo e te chama: aparece em **precisa de você**.
- **Freio**: depois de 30 falas seguidas de agentes sem você, o grupo para e te chama.

## Editar e excluir

`e` na lateral ou `:editar` na conversa do grupo: muda a pasta, os membros (o primeiro marcado
coordena) e o objetivo. Na edição, `ctrl+d` duas vezes exclui o grupo: ele some da lateral, a
conversa fica guardada e os agentes continuam existindo.
