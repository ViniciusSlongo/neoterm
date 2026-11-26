# Quando algo não funciona

> Os problemas mais comuns e como resolver.

**"motor desligado" no rodapé**
O motor não está rodando. `neoterm service status` mostra; `neoterm service on` liga. O log fica
em `~/.neoterm/daemon.log`.

**"o motor está desatualizado: rode neoterm service restart"**
A interface é mais nova que o motor (você atualizou o código). `neoterm service restart`.

**Mudei o código ou dei `git pull` e nada mudou**
O motor roda o código de quando ligou: `neoterm service restart`. Depois, feche e abra a interface.

**O serviço não acha o `node` ou o `claude`**
O serviço usa o `node`, o `claude` e o PATH do terminal onde você rodou `neoterm service on`. Trocou
de Node ou de PATH? Rode `neoterm service on` de novo.

**Um agente aparece com ✗ na lateral**
O `AGENT.md` dele tem um problema, geralmente uma pasta que não existe mais. `e` na lateral abre a
edição mesmo assim: escolha as pastas de novo e salve.

**O agente não consegue ler uma pasta**
Veja "Pastas protegidas do macOS" em `neoterm docs seguranca`.

**`shift+enter` envia em vez de quebrar a linha**
Alguns terminais (o Terminal do macOS) não distinguem o `shift+enter`. Use `option+enter` ou
`ctrl+j`.

**Não consigo selecionar texto com o mouse**
A interface usa o mouse para rolar. Aperte `ctrl+s` (modo seleção), selecione e copie com `cmd+c`,
e `esc` para voltar. Ou segure `option` (iTerm2) ou `shift` (Ghostty, kitty) enquanto arrasta. Para
desligar a captura do mouse de vez: `NEOTERM_MOUSE=0 neoterm`.

**A rotina não rodou no horário**
O Mac estava dormindo ou o motor desligado: horários perdidos são pulados. Veja as últimas
execuções na tela de rotinas.

**O plano acabou**
O uso aparece no rodapé e no painel. Quando o limite do plano chega, os turnos falham até ele
renovar; o painel mostra quando.
