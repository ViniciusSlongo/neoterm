# Pelo terminal

> Os comandos do `neoterm` para usar sem abrir a interface, ou em scripts.

```sh
neoterm                     # abre a interface
neoterm docs [tópico]       # esta documentação
neoterm help                # a lista curta de comandos
```

## Motor

```sh
neoterm init [--model <modelo>]     # configura: Claude Code, banco, pastas
neoterm service on|off|status|restart
neoterm daemon                      # roda o motor neste terminal, até o ctrl+c
```

## Agentes

```sh
neoterm agents
neoterm agent new analista --folder ~/Documents/Caixa --folder ~/Downloads/extratos \
  --title "Acompanhamento financeiro" --role "Acompanha o caixa…" [--model <modelo>] [--effort high]
neoterm agent pause|resume analista
neoterm agent reset analista [--yes]     # recomeça do zero; mantém o AGENT.md
neoterm agent delete analista [--yes]    # manda para ~/.neoterm/trash
neoterm ask analista "quanto entrou hoje?"
neoterm history analista [--limit 50]    # ou: neoterm history '#crm'
```

## Rotinas

```sh
neoterm routines [analista]
neoterm routine add analista --title resumo --cron "0 9 * * 1-5" --do "resuma os extratos" [--notify] [--group crm]
neoterm routine run|on|off|rm <id>
```

## Grupos

```sh
neoterm groups
neoterm group new crm --folder ~/Projects/crm --members arquiteto,dev,revisor [--coordinator arquiteto] [--objective "…"]
neoterm group say crm "precisamos de filtro por status"
```

## O resto

```sh
neoterm attention          # o que precisa de você
```
