"""Hooks do guarda de contexto.

  prompt -> UserPromptSubmit: no ponto ideal, pede ao Claude o handoff ao fim da tarefa.
  start  -> SessionStart (clear/startup): injeta o último handoff pendente da mesma pasta.
"""
import json
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from config import (HANDOFF_DIR, JANELA_PADRAO, RELEMBRAR_PCT, STATE_DIR, VALIDADE_CLEAR_H,  # noqa: E402
                    VALIDADE_STARTUP_H, limites)


def saida(evento, texto):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": evento, "additionalContext": texto}},
                     ensure_ascii=False))


def uso_pelo_transcript(caminho):
    """Plano B quando a barra de status ainda não gravou estado."""
    try:
        linhas = Path(caminho).read_text(encoding="utf-8").splitlines()
    except (OSError, TypeError):
        return None
    for linha in reversed(linhas[-400:]):
        if '"usage"' not in linha:
            continue
        try:
            u = json.loads(linha)["message"]["usage"]
        except (json.JSONDecodeError, KeyError, TypeError):
            continue
        return (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                + u.get("cache_creation_input_tokens", 0))
    return None


def prompt(d):
    sid = d.get("session_id", "")
    arq = STATE_DIR / f"{sid}.json"
    try:
        st = json.loads(arq.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        st = {}
    tamanho = st.get("tamanho") or JANELA_PADRAO
    tokens = st.get("tokens")
    if tokens is None:
        tokens = uso_pelo_transcript(d.get("transcript_path"))
        if tokens is None:
            return
    pct = tokens * 100 / tamanho
    _, handoff = limites(tamanho)
    if tokens < handoff:
        return

    ultimo = st.get("handoff_pedido_pct")
    if ultimo is not None and pct < ultimo + RELEMBRAR_PCT:
        return

    HANDOFF_DIR.mkdir(parents=True, exist_ok=True)
    destino = st.get("handoff_arquivo") or str(
        HANDOFF_DIR / f"{datetime.now():%Y%m%d-%H%M}-{sid[:8]}.md").replace("\\", "/")
    st.update(handoff_pedido_pct=round(pct, 1), handoff_arquivo=destino)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        arq.write_text(json.dumps(st), encoding="utf-8")
    except OSError:
        pass

    saida("UserPromptSubmit",
          f"[guarda de contexto] A janela está em {pct:.0f}% ({tokens // 1000}k tokens), ponto ideal de handoff. "
          f"Atenda o pedido atual normalmente. Ao terminar, siga a skill `handoff`: grave o handoff em "
          f"`{destino}` (primeira linha: `cwd: {d.get('cwd', '')}`) e encerre a resposta com uma linha "
          f"pedindo ao usuário que digite /clear, avisando que o contexto volta sozinho. "
          f"Se já existir handoff nesse arquivo, apenas atualize.")


def start(d):
    fonte = d.get("source")
    if fonte not in ("clear", "startup") or not HANDOFF_DIR.exists():
        return
    validade = (VALIDADE_CLEAR_H if fonte == "clear" else VALIDADE_STARTUP_H) * 3600
    cwd = (d.get("cwd") or "").replace("\\", "/").lower()
    agora = time.time()
    pendentes = [p for p in HANDOFF_DIR.glob("*.md") if not p.name.endswith(".usado.md")]
    for arq in sorted(pendentes, key=lambda p: p.stat().st_mtime, reverse=True):
        if agora - arq.stat().st_mtime > validade:
            break
        texto = arq.read_text(encoding="utf-8")
        primeira = texto.splitlines()[0] if texto else ""
        if primeira.startswith("cwd:") and primeira[4:].strip().replace("\\", "/").lower() != cwd:
            continue
        arq.rename(arq.with_suffix(".usado.md"))
        saida("SessionStart",
              f"[guarda de contexto] Retomando do handoff `{arq.name}` da sessão anterior. "
              f"Leia, confirme ao usuário em uma linha onde paramos e siga pelo próximo passo.\n\n{texto}")
        return


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        dados = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        dados = {}
    {"prompt": prompt, "start": start}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda _: None)(dados)
