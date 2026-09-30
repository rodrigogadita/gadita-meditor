"""Limites do guarda de contexto. Ajuste aqui."""
from pathlib import Path

BASE = Path.home() / ".claude"
STATE_DIR = BASE / "context-guard" / "state"
HANDOFF_DIR = BASE / "handoffs"

# A qualidade cai por volume absoluto de tokens, não só por %.
# Vale o que chegar primeiro: o % da janela ou o teto em tokens.
AVISO_PCT, AVISO_TOKENS = 40, 120_000
HANDOFF_PCT, HANDOFF_TOKENS = 60, 200_000
# Depois do primeiro pedido de handoff, lembra de novo a cada +10% da janela.
RELEMBRAR_PCT = 10

# Janela usada quando nada informa o tamanho real. A extensão Gadita Meditor corrige isso sozinha.
JANELA_PADRAO = 200_000

# Handoff volta sozinho: após /clear se tiver até 12h; em sessão nova, até 2h.
VALIDADE_CLEAR_H, VALIDADE_STARTUP_H = 12, 2


def limites(tamanho):
    aviso = min(tamanho * AVISO_PCT / 100, AVISO_TOKENS)
    handoff = min(tamanho * HANDOFF_PCT / 100, HANDOFF_TOKENS)
    return aviso, handoff
