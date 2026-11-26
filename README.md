# neoterm

**Agentes persistentes no terminal, com o Claude Code do seu plano.**

Cada agente tem identidade, função e as pastas do computador em que trabalha. Eles conversam com
você, rodam rotinas sozinhos, consultam uns aos outros e trabalham juntos em grupos. Sem chave de
API, sem servidor na nuvem: tudo roda no seu Mac, pelo `claude` que você já usa.

```
 AGENTES               │  analista  · Financeiro · ~/Documents/Caixa      ○ livre · 77 MB
 ● analista ⠹          │ ──────────────────────────────────────────────────────────────
 ○ dev                 │  ┃ quanto entrou essa semana?
 GRUPOS                │
 # fechamento          │    ⎿ Read   extratos/novembro.csv
 ROTINAS HOJE          │  ● Entraram R$ 48.200 em 12 recebimentos.
 ✓ 09:00 resumo        │    • 8 por pix · 4 por boleto
 PRECISA DE VOCÊ       │
 ! rotina backup falhou│ ──────────────────────────────────────────────────────────────
 ◆ painel            d │  > mensagem para analista · :ajuda
 ◆ integrações       i │ ──────────────────────────────────────────────────────────────
```

## Começar

Precisa de **macOS**, **Node 24+** e o **[Claude Code](https://code.claude.com)** instalado e logado
(`claude`, depois `/login`).

```sh
git clone https://github.com/ViniciusSlongo/neoterm.git
cd neoterm && npm install && npm link

neoterm init          # confere o Claude Code e cria ~/.neoterm
neoterm service on    # liga o motor (e sempre que você entrar no Mac)
neoterm               # abre a interface
```

Na interface, `n` cria o primeiro agente: nome, função e as pastas dele. Depois é só conversar.

## O que dá para fazer

- **Conversar** com cada agente, com imagens, markdown e uma fila para o que você manda enquanto ele
  trabalha.
- **Rotinas**: "todo dia útil às 18h, resume o caixa". O agente cria e roda sozinho.
- **Grupos**: vários agentes num projeto, chamando uns aos outros com `@nome`.
- **Consultas entre agentes**: um pergunta ao outro e espera a resposta, sem precisar de grupo.
- **Memória e notas**: o que o agente lembra entre conversas, e as suas anotações sobre ele.
- **Processos**: a memória de cada agente e os serviços que ele deixou rodando, para encerrar o
  que sobrou.
- **Painel**: motor, plano, máquina e o trabalho do dia, numa tela.
- **Do seu jeito**: escolha a cor da interface e o modelo padrão em `:config`.

Tudo também pelo terminal: `neoterm ask analista "quanto entrou hoje?"`.

## Documentação

```sh
neoterm docs            # lista os tópicos
neoterm docs agentes    # abre um
```

| | Tópico | |
| --- | --- | --- |
| 1 | [Começar](docs/01-comecar.md) | instalar, ligar e o primeiro agente |
| 2 | [A interface](docs/02-interface.md) | as telas e como usar cada uma |
| 3 | [Comandos e teclas](docs/03-comandos.md) | tudo numa página |
| 4 | [Agentes](docs/04-agentes.md) | identidade, memória, consultas, processos |
| 5 | [Rotinas e retornos](docs/05-rotinas.md) | trabalho que roda sozinho |
| 6 | [Grupos](docs/06-grupos.md) | agentes trabalhando juntos |
| 7 | [Pelo terminal](docs/07-terminal.md) | os comandos do `neoterm` |
| 8 | [Segurança e privacidade](docs/08-seguranca.md) | o que fica onde, e o que um agente pode fazer |
| 9 | [Quando algo não funciona](docs/09-problemas.md) | os problemas mais comuns |
| 10 | [Desenvolvimento](docs/10-desenvolvimento.md) | código, testes, como contribuir |

## Sem chaves, tudo local

O neoterm **não tem nem guarda chave nenhuma**. Cada turno é o `claude -p` oficial, com o login que
você fez no Claude Code (guardado nas Chaves do macOS). Agentes, conversas e memória ficam em
`~/.neoterm`, fora do repositório, e o motor só ouve em `127.0.0.1`.

Os agentes rodam **sem pedir permissão**, como o Claude Code com `--dangerously-skip-permissions`.
As pastas que você escolhe são o escopo deles, mas são uma orientação, não uma trava. Leia
[Segurança e privacidade](docs/08-seguranca.md) antes de dar a um agente uma pasta importante.

## Desenvolvimento

```sh
npm test              # a suíte inteira, com um claude falso: não gasta o plano
npm run typecheck
```

Sem build: o Node 24 roda o TypeScript direto. Veja [Desenvolvimento](docs/10-desenvolvimento.md).

---

[MIT](LICENSE) · Inspirado no [OpenBot](https://github.com/CopilotKit/OpenBot).
