# Começar

> Instalar, ligar e criar o primeiro agente.

## Instalar

Precisa de macOS, Node 24+ e o [Claude Code](https://code.claude.com) logado (`claude`, depois `/login`).

```sh
git clone https://github.com/ViniciusSlongo/neoterm.git
cd neoterm && npm install && npm link
```

## Ligar

```sh
neoterm init            # prepara ~/.neoterm e testa o Claude Code
neoterm service on      # liga o motor (e sempre que você entrar no Mac)
neoterm                 # abre a interface
```

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
