# Começar

> Instalar, ligar o motor e criar o primeiro agente, em cinco minutos.

## Precisa de

- **macOS** (o serviço usa o launchd; a leitura de processos e do clipboard é do macOS)
- **Node 24 ou mais novo**: o neoterm roda TypeScript direto, sem build
- **[Claude Code](https://code.claude.com)** instalado e logado: rode `claude` e depois `/login`

Não precisa de Docker, de banco externo nem de chave de API. O neoterm usa o login que você já fez no
Claude Code, e os agentes gastam do seu plano.

## Instalar

```sh
git clone https://github.com/ViniciusSlongo/neoterm.git
cd neoterm
npm install
npm link          # deixa o comando `neoterm` disponível em qualquer pasta
```

Sem `npm link`, use `node src/cli/main.ts` no lugar de `neoterm`.

## Configurar e ligar

```sh
neoterm init          # confere o Claude Code, cria ~/.neoterm e o banco
neoterm service on    # liga o motor agora e sempre que você entrar no Mac
neoterm               # abre a interface
```

O **motor** é quem roda os agentes, as rotinas e os grupos. A interface só conversa com ele: fechar
a interface não para nada. Prefere não deixar o motor como serviço? Rode `neoterm daemon` num
terminal e deixe aberto.

## O primeiro agente

Na interface, aperte `n`:

1. **Nome**: o nome da pasta dele, em minúsculas (`analista`)
2. **Título**: uma linha sobre o que ele faz (`Acompanhamento financeiro`)
3. **Função**: o que ele faz em qualquer conversa, em texto livre (dá para mudar depois)
4. **Pastas**: escolha na lista ao lado com `espaço` o escopo dele: só trabalha nelas
5. `ctrl+s` salva

Pronto: escreva na conversa. Para rotinas, grupos e o resto, veja `neoterm docs`.

## Atualizar

```sh
cd neoterm && git pull && npm install
neoterm service restart     # o motor passa a rodar o código novo
```

Depois, feche e abra a interface.
