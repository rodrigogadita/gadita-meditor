# Histórico

## 3.1.2
- Corrigido: depois do `/clear` o painel continuava mostrando os tokens antigos. A sessão nova (ainda sem resposta) não aparecia, e com várias conversas abertas o painel seguia a que gravou por último, que podia ser outra.
- Sessão atual agora é a que recebeu o seu último pedido; a conversa recém-limpa aparece na hora.
- Novo: economia real das limpezas feitas (tokens que deixaram de ser reenviados e custo ponderado), além da estimativa simulada.

## 3.1.0
- Atalhos que aplicam as técnicas: `Ctrl+Alt+H` handoff + limpar (abre a conversa nova sozinho quando o handoff é salvo), `Ctrl+Alt+N` conversa nova, `Ctrl+Alt+C` compactar com foco, `Ctrl+Alt+T` todas as técnicas.
- Seção Atalhos no painel e botão Aplicar em cada alerta; atalho rápido no modo encolhido.
- Notificações dos alertas vermelhos com a técnica que resolve.

## 3.0.0
- Primeira versão pública.
- Menu na barra de status: janela flutuante, aba ou barra lateral. Atalho `Ctrl+Alt+G`.
- A aba volta sozinha depois de recarregar o VS Code; opção de abrir ao iniciar.
- Janela automática: 1M se a conta já passou de 200k, senão 200k.
- Seção "Técnicas que economizam" no painel.
- Kit de handoff com instalador (`kit/instalar.py`) e medidor de economia (`ferramentas/economia.py`).

## 2.0.0
- Alertas baseados na documentação da Anthropic, economia estimada, visual neon com status verde, amarelo e vermelho.

## 1.0.0
- Barra de status e painel com anel de handoff, indicadores e evolução da janela.
