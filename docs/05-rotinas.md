# Rotinas e retornos

> Tarefas com horário e lembretes de uma vez.

## Rotinas

| O quê | Como |
| --- | --- |
| Criar pedindo | "todo dia útil às 18h, resume o caixa" |
| Criar na tela | `r` na lateral, `n` |
| Ligar ou desligar | `espaço` |
| Rodar agora | `x` |
| Apagar | `d` duas vezes |

Cada rotina **age** (faz o que pede) ou **só avisa** (verifica e informa). A resposta aparece na
conversa com o agente ou num grupo.

Pelo terminal:

```sh
neoterm routine add analista --title resumo --cron "0 18 * * 1-5" --do "resume o caixa"
```

Regras: no mínimo 15 minutos entre execuções, até 20 ligadas. Horários perdidos com o Mac
desligado são pulados. Depois de 10 falhas seguidas, a rotina desliga.

## Retornos

Peça na conversa: "vê de novo daqui a 1 hora". O agente volta sozinho na hora marcada (de 1
minuto a 7 dias).
