---
name: handoff
description: Gera o handoff da sessão (resumo para continuar depois de /clear) e grava em ~/.claude/handoffs. Use quando o usuário digitar /handoff, pedir "faz o handoff", "vou limpar", ou quando o guarda de contexto avisar que chegou o ponto ideal.
---

# Handoff

Objetivo: a próxima sessão continua o trabalho lendo só este arquivo, sem reler a conversa.

## Onde gravar
- Se o aviso do guarda de contexto trouxe um caminho, use exatamente ele.
- Senão: `~/.claude/handoffs/AAAAMMDD-HHMM-<assunto-curto>.md`.
- Primeira linha obrigatória: `cwd: <pasta de trabalho atual>` (o hook usa para devolver o handoff na pasta certa).

## Formato (máximo ~60 linhas)
```
cwd: C:/...
# Handoff: <assunto>, <data e hora>

## Objetivo
Uma ou duas frases: o que o usuário quer no fim.

## Estado atual
O que está feito e verificado. O que está feito mas NÃO testado.

## Decisões
- decisão: motivo (só o que não dá para deduzir do código)

## Arquivos e lugares
- caminho/arquivo.py:linha: o que tem ali
- links, IDs de tarefa, ambiente (ex.: homologação)

## Próximo passo
1. ação concreta e exata que vem agora
2. ...

## Armadilhas
Erros já cometidos, comandos que falharam, o que não fazer.
```

## Regras
- Aponte, não copie: caminho e linha em vez de colar código ou log.
- Nada de senha, token ou dado pessoal de colaborador.
- Aprendizado duradouro (preferência do usuário, regra de projeto) vai para a memória, não só para o handoff.
- Ao terminar, responda em uma linha: "Handoff salvo em <arquivo>. Digite /clear que eu retomo daqui."
