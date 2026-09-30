"""Instala (ou remove) o kit de handoff automático do Gadita Meditor no Claude Code.

    python kit/instalar.py              # instala
    python kit/instalar.py --remover    # desfaz

O que faz:
  1. Copia context-guard/ e skills/handoff/ para ~/.claude/
  2. Faz backup do ~/.claude/settings.json e acrescenta (sem apagar nada seu):
     - hook UserPromptSubmit: no ponto ideal, pede ao Claude o handoff
     - hook SessionStart: depois do /clear, devolve o handoff à sessão nova
     - statusLine: % da janela no terminal (só se você ainda não tiver uma)
"""
import json
import shutil
import sys
import time
from pathlib import Path

AQUI = Path(__file__).resolve().parent
CLAUDE = Path.home() / ".claude"
GUARDA = CLAUDE / "context-guard"
SKILL = CLAUDE / "skills" / "handoff"
SETTINGS = CLAUDE / "settings.json"
MARCA = "context-guard"


def comando(script, *args):
    py = Path(sys.executable).as_posix()
    alvo = (GUARDA / script).as_posix()
    return " ".join([f'"{py}"', f'"{alvo}"', *args])


def ler_settings():
    if not SETTINGS.exists():
        return {}
    return json.loads(SETTINGS.read_text(encoding="utf-8"))


def gravar_settings(dados):
    if SETTINGS.exists():
        copia = CLAUDE / "backups" / f"settings.antes-gadita-{time.strftime('%Y%m%d-%H%M%S')}.json"
        copia.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SETTINGS, copia)
        print(f"  backup: {copia}")
    SETTINGS.write_text(json.dumps(dados, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sem_kit(grupos):
    return [g for g in grupos if not any(MARCA in h.get("command", "") for h in g.get("hooks", []))]


def instalar():
    CLAUDE.mkdir(exist_ok=True)
    shutil.copytree(AQUI / "context-guard", GUARDA, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("state", "__pycache__"))
    shutil.copytree(AQUI / "skills" / "handoff", SKILL, dirs_exist_ok=True)
    print(f"  copiado: {GUARDA}\n  copiado: {SKILL}")

    s = ler_settings()
    hooks = s.setdefault("hooks", {})
    hooks["UserPromptSubmit"] = sem_kit(hooks.get("UserPromptSubmit", [])) + [
        {"hooks": [{"type": "command", "command": comando("hook.py", "prompt"), "timeout": 10}]}]
    hooks["SessionStart"] = sem_kit(hooks.get("SessionStart", [])) + [
        {"matcher": "clear|startup", "hooks": [{"type": "command", "command": comando("hook.py", "start"), "timeout": 10}]}]
    if "statusLine" not in s:
        s["statusLine"] = {"type": "command", "command": comando("statusline.py")}
    gravar_settings(s)
    print("\nPronto. Abra uma sessão nova do Claude Code para valer.")
    print("Limites em ~/.claude/context-guard/config.py (aviso 120k, handoff 200k).")


def remover():
    s = ler_settings()
    hooks = s.get("hooks", {})
    for evento in ("UserPromptSubmit", "SessionStart"):
        if evento in hooks:
            hooks[evento] = sem_kit(hooks[evento])
            if not hooks[evento]:
                del hooks[evento]
    if not hooks:
        s.pop("hooks", None)
    if MARCA in (s.get("statusLine") or {}).get("command", ""):
        del s["statusLine"]
    gravar_settings(s)
    shutil.rmtree(GUARDA, ignore_errors=True)
    shutil.rmtree(SKILL, ignore_errors=True)
    print("Kit removido. Os handoffs salvos em ~/.claude/handoffs foram mantidos.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    remover() if "--remover" in sys.argv else instalar()
