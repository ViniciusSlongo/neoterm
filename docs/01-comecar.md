# Começar

> Instalar, ligar e criar o primeiro agente.

## Instalar

Precisa de macOS, Node 24+ e o Claude Code.

```sh
git clone https://github.com/ViniciusSlongo/neoterm.git
cd neoterm && npm install && npm link
```

## Ligar

```sh
neoterm init            # conecta o provedor e prepara ~/.neoterm
neoterm service on      # liga o motor (e sempre que você entrar no Mac)
neoterm                 # abre a interface
```

O `init` usa o login que já existe. Sem login, ele abre o login do próprio provedor.

O motor roda os agentes. Fechar a interface não para nada.

## Primeiro agente

Na interface, `n`:

1. **Nome**: `analista`
2. **Título**: `Acompanhamento financeiro`
3. **Função**: o que ele faz
4. **Pastas**: `espaço` escolhe na lista ao lado
5. `ctrl+s` salva

Depois é escrever na conversa.

## Atualizar

```sh
git pull && npm install && neoterm service restart
```
