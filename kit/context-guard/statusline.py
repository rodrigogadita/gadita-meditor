"""Barra de status: % da janela de contexto, tokens e limite de 5h.

Também grava o estado da sessão em state/<session_id>.json para o hook
de prompt saber quando é hora do handoff (hooks não recebem o % direto).
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import JANELA_PADRAO, STATE_DIR, limites  # noqa: E402

VERDE, AMARELO, VERMELHO, CINZA, FIM = "\033[32m", "\033[33m", "\033[31m", "\033[90m", "\033[0m"


def k(n):
    return f"{n / 1000:.0f}k" if n < 1_000_000 else f"{n / 1_000_000:.1f}M"


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        d = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        d = {}

    cw = d.get("context_window") or {}
    tamanho = cw.get("context_window_size") or JANELA_PADRAO
    pct = cw.get("used_percentage")
    tokens = cw.get("total_input_tokens")
    if tokens is None and pct is not None:
        tokens = int(tamanho * pct / 100)
    if pct is None and tokens is not None:
        pct = tokens * 100 / tamanho
    pct, tokens = pct or 0, tokens or 0

    aviso, handoff = limites(tamanho)
    if tokens >= handoff:
        cor, rotulo = VERMELHO, "hora do handoff"
    elif tokens >= aviso:
        cor, rotulo = AMARELO, "atenção"
    else:
        cor, rotulo = VERDE, "ok"

    sid = d.get("session_id")
    if sid:
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            (STATE_DIR / f"{sid}.json").write_text(json.dumps({
                "pct": round(pct, 1), "tokens": tokens, "tamanho": tamanho,
                "cwd": (d.get("workspace") or {}).get("current_dir") or d.get("cwd"),
                "ts": time.time(),
            }), encoding="utf-8")
        except OSError:
            pass

    cheios = min(10, int(pct // 10))
    barra = "▓" * cheios + "░" * (10 - cheios)
    modelo = (d.get("model") or {}).get("display_name", "")
    partes = [
        f"{CINZA}{modelo}{FIM}",
        f"{cor}{barra} {pct:.0f}%{FIM} {CINZA}({k(tokens)}/{k(tamanho)}){FIM}",
        f"{cor}{rotulo}{FIM}",
    ]
    cinco_h = ((d.get("rate_limits") or {}).get("five_hour") or {}).get("used_percentage")
    if cinco_h is not None:
        partes.append(f"{CINZA}limite 5h {cinco_h:.0f}%{FIM}")
    print(" · ".join(partes))


if __name__ == "__main__":
    main()
