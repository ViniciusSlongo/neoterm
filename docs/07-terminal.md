# Pelo terminal

> Os comandos do `neoterm`.

```sh
neoterm                          # interface
neoterm docs [tópico]            # documentação
neoterm init [--model <modelo>]  # prepara e testa
neoterm service on|off|status|restart
neoterm daemon                   # motor neste terminal
```

## Agentes

```sh
neoterm agents
neoterm agent new analista --folder ~/Documents/Caixa [--title …] [--role …] [--model …] [--effort high]
neoterm agent pause|resume analista
neoterm agent reset analista [--yes]
neoterm agent delete analista [--yes]
neoterm ask analista "quanto entrou hoje?"
neoterm history analista
```

## Rotinas

```sh
neoterm routines [agente]
neoterm routine add analista --title resumo --cron "0 9 * * 1-5" --do "…" [--notify] [--group crm]
neoterm routine run|on|off|rm <id>
```

## Grupos

```sh
neoterm groups
neoterm group new crm --folder ~/Projects/crm --members a,b,c [--coordinator a] [--objective "…"]
neoterm group say crm "…"
```

## Outros

```sh
neoterm attention                # o que precisa de você
```
