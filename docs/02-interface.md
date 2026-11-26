# A interface

> As telas do neoterm: conversa, lateral, painel, integrações, processos e formulários.

```
 AGENTES               │  analista  · Financeiro · ~/Documents/Caixa      ○ livre · 77 MB
 ● analista ⠹          │ ──────────────────────────────────────────────────────────────
 ○ dev                 │  ┃ quanto entrou essa semana?
 GRUPOS                │
 # fechamento          │    ⎿ Read   extratos/novembro.csv
 ROTINAS HOJE          │  ● Entraram R$ 48.200 em 12 recebimentos.
 ✓ 09:00 resumo        │
 PRECISA DE VOCÊ       │ ──────────────────────────────────────────────────────────────
 ! dev parado há 45 min│  > mensagem para analista · :ajuda
 ◆ painel            d │ ──────────────────────────────────────────────────────────────
 ◆ integrações       i │
```

Em qualquer lugar, `:ajuda` (na conversa) ou `?` (na lateral) mostra todos os comandos e teclas.

## A lateral

- **Agentes**: `●` verde com um spinner ao lado do nome é quem está trabalhando; `‖` é pausado.
  Um `•` depois do nome é mensagem nova.
- **Grupos**, **rotinas de hoje** e **precisa de você**: o que só você resolve (uma rotina que
  falhou, um grupo esperando uma decisão, serviços esquecidos rodando).
- **Painel** (`d`), **integrações** (`i`) e **config** (`c`) ficam embaixo, junto de criar agente
  (`n`) e grupo (`g`).

## A conversa

- Suas mensagens têm fundo e uma barra à esquerda; as do agente começam com `●`. As ferramentas que
  ele usou aparecem recuadas, com `⎿`.
- O agente escreve em markdown: negrito, código, títulos e listas aparecem formatados.
- O que você manda enquanto ele responde vai para uma **fila** numerada, embaixo, e é respondido na
  ordem.
- **Imagens**: cole o caminho de uma imagem ou use `ctrl+v` com um print no clipboard. No texto
  aparece `[imagem 1]`; o agente recebe o arquivo.
- A roda do mouse rola só a conversa.
- **Selecionar e copiar texto**: `ctrl+s` entra no modo seleção (o rodapé fica amarelo). Arraste
  com o mouse e copie com `cmd+c`; `↑↓` rolam; `esc` volta. Para copiar a última resposta inteira,
  `ctrl+y`. Sem entrar no modo, também dá para selecionar segurando `option` (iTerm2) ou `shift`
  (Ghostty, kitty).
- No cabeçalho: o estado do agente e, quando ele está rodando algo, a memória e os serviços dele.

## Painéis à direita

- **Notas** (`ctrl+n`, ou `:notas`): suas anotações sobre o agente, num `notas.txt` na pasta dele.
  Salvam sozinhas e são suas: o agente não as vê.
  - **Lista de tarefas**: `ctrl+t` transforma a linha em tarefa e marca ou desmarca. Aparecem como
    `☐` e `☑`; no arquivo ficam `- [ ]` e `- [x]`.
  - **Fixar** (`ctrl+p`): as notas ficam abertas ao lado da conversa e acompanham o agente que você
    abrir. Vale até soltar, inclusive depois de fechar a interface.
  - **Lembrete**: na lateral, `☐2` depois do nome são tarefas abertas e `✎` são notas; no
    cabeçalho da conversa aparecem as tarefas abertas quando as notas estão fechadas.
- `:path`: a lista de arquivos do escopo. Escolha um e o caminho entra na mensagem. Funciona no
  fim de uma frase: `compare com :path` abre a lista sem enviar.

`ctrl+n` (nas notas) ou `tab` alterna entre o painel e a mensagem; `esc` fecha.

## Telas

- **Painel** (`d`): o motor, a memória da máquina, o uso do plano, o trabalho de hoje e da semana,
  cada agente, rotinas, retornos e o espaço em `~/.neoterm`. Atualiza a cada 5 segundos.
- **Integrações** (`i`): os MCPs do Claude Code, conectados ou não. Só para ver; veja
  `neoterm docs agentes`.
- **Processos** (`:processos`, ou `s` na lateral): a memória do agente e os serviços que ele deixou
  rodando, com `x` para encerrar.
- **Rotinas** (`:rotinas`, ou `r` na lateral): as rotinas da conversa, com a próxima execução e as
  últimas.
- **Config** (`:config`, ou `c` na lateral): a cor de destaque da interface e o modelo padrão dos
  agentes. Passe com `↑↓` pelas cores para ver a prévia na tela inteira; `enter` salva. Na
  **personalizada**, digite qualquer cor `#RRGGBB`. Fica em `~/.neoterm/config.json`.

## Formulários

Criar e editar agentes, grupos e rotinas. `tab` passa de campo, `ctrl+s` salva, `esc` cancela.

- **Pastas**: uma lista ao lado. `↑↓` anda, `→` entra, `←` volta, `espaço` escolhe (de novo,
  desmarca), `esc` fecha a lista com o que foi escolhido.
- **Função e objetivo**: texto de várias linhas; `enter` quebra a linha.
- **Excluir** (na edição): `ctrl+d` e `ctrl+d` de novo.
