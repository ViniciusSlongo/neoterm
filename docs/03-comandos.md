# Comandos e teclas

> Tudo o que dá para digitar na conversa e as teclas de cada tela, numa página.

## Comandos da conversa

Escreva na conversa, com `:` ou `/` na frente (`:notas` e `/notas` são o mesmo).

| Comando | Apelidos | O que faz |
| --- | --- | --- |
| `:ajuda` | `:help`, `:?` | comandos e teclas, numa tela |
| `:notas` | `:notes` | suas anotações sobre o agente, à direita |
| `:path` | `:arquivo` | escolhe um arquivo do escopo e põe o caminho na mensagem |
| `:processos` | `:ps` | memória e serviços que o agente deixou rodando |
| `:editar` | `:edit` | muda (ou exclui) o agente ou o grupo |
| `:rotinas` | `:routines` | as rotinas desta conversa |
| `:pausar` | `:pause` | pausa as rotinas e retornos do agente |
| `:retomar` | `:resume` | volta a rodar o que foi pausado |
| `:painel` | `:dash` | resumo do neoterm: motor, plano, agentes |
| `:mcp` | `:integracoes` | integrações do Claude Code (só ver) |
| `:config` | `:cor`, `:tema` | cor da interface e modelo padrão dos agentes |
| `:selecionar` | `:sel` | modo seleção: selecione texto com o mouse e copie (`ctrl+s`) |
| `:copiar` | `:copy` | copia a última resposta do agente (`ctrl+y`) |

Num grupo, `@nome` chama um agente e `@você` é para você.

## Na conversa

| Tecla | O que faz |
| --- | --- |
| `enter` | envia |
| `shift+enter` | nova linha (ou `option+enter`, `ctrl+j`) |
| `ctrl+v` | cola uma imagem do clipboard |
| `ctrl+n` | abre as notas; abertas, alterna com a conversa |
| `ctrl+s` | modo seleção: arraste para selecionar, `cmd+c` copia, `esc` volta |
| `ctrl+y` | copia a última resposta do agente |
| `cmd+backspace` | apaga a palavra (também `option+backspace`, `ctrl+w`) |
| `←→`, `option+←→` | anda pelo texto, por letra ou palavra |
| `↑↓` | sobe e desce no texto; sem texto, troca de conversa |
| roda do mouse, `pgup`/`pgdn` | rolam a conversa |
| `esc` | vai para a lateral |

## Na lateral

| Tecla | O que faz |
| --- | --- |
| `↑↓`, `enter` | escolhe e abre |
| `e` | edita o agente ou grupo |
| `s` | processos do agente |
| `r` | rotinas |
| `p` | pausa ou retoma |
| `n`, `g` | novo agente, novo grupo |
| `d`, `i`, `c` | painel, integrações, config |
| `?` | ajuda |
| `q` | sai (o motor continua) |

## Listas de arquivos e pastas

| Tecla | O que faz |
| --- | --- |
| `↑↓` (ou `j`/`k`) | anda |
| `→`, `enter` | entra na pasta; no `:path`, num arquivo, insere o caminho |
| `←` | volta para a pasta de cima |
| `espaço` | escolhe |
| `/` | filtra pelo nome |
| `.` | mostra os ocultos |
| `~` | vai para a home (nos formulários) |
| `esc` | fecha |

## Notas

| Tecla | O que faz |
| --- | --- |
| `ctrl+t` | marca ou desmarca a tarefa da linha (ou transforma a linha em tarefa) |
| `ctrl+p` | fixa ao lado: as notas ficam abertas em todo agente |
| `ctrl+n`, `tab` | volta à conversa |
| `esc` | fecha (fixadas: volta à conversa) |

## Formulários

| Tecla | O que faz |
| --- | --- |
| `tab`, `shift+tab` | próximo, anterior |
| `ctrl+s` | salva |
| `ctrl+d` duas vezes | exclui (na edição) |
| `esc` | cancela |

## Outras telas

- **Rotinas**: `n` nova, `espaço` liga e desliga, `x` roda agora, `d` duas vezes apaga.
- **Processos**: `x` encerra o selecionado, `X` encerra todos os serviços (cada um pede a mesma
  tecla de novo), `enter` mostra o comando inteiro.
- **Precisa de você**: `enter` abre o assunto, `x` dispensa.
