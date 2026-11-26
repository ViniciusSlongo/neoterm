# Rotinas e retornos

> Trabalho que roda sozinho: todo dia às 9h, toda sexta às 17h, ou daqui a uma hora.

## Rotinas

Uma rotina é uma instrução com horário. Peça na conversa ("todo dia útil às 18h, resume o caixa")
e o agente cria; ou crie na tela de rotinas (`r` na lateral, `n`), ou pelo terminal:

```sh
neoterm routine add analista --title resumo --cron "0 18 * * 1-5" --do "resume o caixa do dia"
```

- **Agir** faz o que a rotina pede. **Só avisar** verifica e informa, sem mudar nada.
- A resposta aparece na conversa com o agente, ou num grupo (`--group`).
- O horário é um cron de 5 campos, no seu fuso. Na interface, escolha entre todo dia, dias úteis,
  toda semana ou todo mês.

### Regras

- No máximo uma vez a cada 15 minutos, e no máximo 20 rotinas ligadas.
- Com o motor desligado ou o Mac dormindo, os horários perdidos são pulados, não repetidos
  (tolerância de 10 minutos).
- **Cansaço**: avisa na primeira falha e desliga depois de 10 falhas seguidas. Religar zera a
  contagem.

### Na tela de rotinas

`↑↓` escolhe, `n` cria, `espaço` liga e desliga, `x` roda agora, `d` duas vezes apaga. Embaixo, as
últimas execuções de cada uma.

## Retornos

Um retorno é uma vez só: o agente volta à conversa sozinho daqui a um tempo ("vejo o build de novo
em 1 hora"). Ele mesmo agenda, entre 1 minuto e 7 dias. Os pendentes aparecem no painel.

## Pausar

`p` na lateral (ou `:pausar`) segura as rotinas, os retornos e as consultas de colegas daquele
agente. A conversa com você continua. `:retomar` volta ao normal.
