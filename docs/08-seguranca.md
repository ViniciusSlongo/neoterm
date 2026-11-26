# Segurança e privacidade

> O que o neoterm guarda, onde, e o que um agente pode fazer.

## Sem chaves

O neoterm **não tem nem guarda chave nenhuma**. Cada turno de um agente é o `claude -p` oficial,
com o login que você fez no Claude Code. Esse login fica nas Chaves do macOS, onde o Claude Code o
guarda. O neoterm nunca lê, copia nem envia senha ou token.

## Tudo local

| O quê | Onde |
| --- | --- |
| Agentes, memória, notas | `~/.neoterm/agents/` |
| Conversas, rotinas, grupos, execuções | `~/.neoterm/neoterm.db` (SQLite) |
| Imagens coladas | `~/.neoterm/imagens/` |
| Agentes excluídos | `~/.neoterm/trash/` |
| Log do motor | `~/.neoterm/daemon.log` |

Nada disso fica na pasta do repositório, e o `.gitignore` barra arquivos de credenciais por
garantia. O motor só ouve em `127.0.0.1:4777`, nunca na rede.

As conversas vão para a Anthropic pelo Claude Code, como qualquer uso do Claude Code.

## O que um agente pode fazer

Os agentes rodam **sem pedir permissão**, como você rodaria o Claude Code com
`--dangerously-skip-permissions`: leem, escrevem e rodam comandos sozinhos, inclusive em rotinas,
sem você olhando.

- **As pastas são uma orientação, não uma trava.** O agente é instruído a trabalhar só nelas, mas
  nada o impede de ir além.
- **A sua configuração pessoal fica de fora**: hooks, plugins e servidores MCP do seu Claude Code
  não vão para os agentes. A configuração do projeto (`CLAUDE.md`, `.claude/`) vale.
- **Cada execução tem uma chave própria** para as ferramentas do neoterm; o agente não age em
  nome de outro.

Na prática: dê a cada agente só as pastas de que ele precisa, e prefira **só avisar** em rotinas
que mexem em algo importante.

## Pastas protegidas do macOS

Rodando como serviço, quem acessa os arquivos é o `node`. Documentos, Mesa, Downloads e iCloud podem
pedir permissão ou bloquear. Se um agente não conseguir ler uma dessas, libere o `node` em Ajustes
do Sistema → Privacidade e Segurança → Acesso Total ao Disco.
