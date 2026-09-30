"""Mede quanto você economizaria com handoff + /clear, usando o SEU histórico do Claude Code.

    python ferramentas/economia.py                       # handoff em 200k, últimos 60 dias
    python ferramentas/economia.py --handoff 150000 --dias 30

Como funciona: lê ~/.claude/projects/*/*.jsonl (fica tudo na sua máquina), refaz cada
sessão turno a turno e simula que, ao chegar no ponto de handoff, a conversa foi limpa
e recomeçou com a base + um handoff. Compara o custo real com o simulado.

Pesos relativos ao preço de lista da Anthropic (entrada = 1):
escrita de cache (1h) 2 · leitura de cache 0,1 · saída 5.
O custo do recomeço já está incluído: gerar o handoff, reescrever o cache e reler arquivos.
"""
import argparse
import json
import sys
import time
from pathlib import Path

P_IN, P_CW, P_CR, P_OUT = 1, 2, 0.1, 5


def carregar(dias):
    limite = time.time() - dias * 86400
    sessoes = []
    for f in (Path.home() / ".claude" / "projects").glob("*/*.jsonl"):
        if f.stat().st_mtime < limite:
            continue
        turnos, vistos = [], {}
        for linha in f.open(encoding="utf-8", errors="ignore"):
            try:
                d = json.loads(linha)
            except json.JSONDecodeError:
                continue
            if d.get("type") != "assistant" or d.get("isSidechain"):
                continue
            m = d.get("message") or {}
            u = m.get("usage")
            if not u:
                continue
            t = dict(inp=u.get("input_tokens", 0), cw=u.get("cache_creation_input_tokens", 0),
                     cr=u.get("cache_read_input_tokens", 0), out=u.get("output_tokens", 0))
            t["ctx"] = t["inp"] + t["cw"] + t["cr"]
            if m.get("id") in vistos:
                turnos[vistos[m["id"]]] = t
            else:
                vistos[m.get("id")] = len(turnos)
                turnos.append(t)
        if len(turnos) > 3:
            sessoes.append(turnos)
    return sessoes


def simular(sessoes, h, handoff_tam=4000, handoff_saida=3000, releitura=15000):
    tot = dict(real=0.0, sim=0.0, ctx_real=0, ctx_sim=0, resets=0, turnos=0, acima=0)
    for turnos in sessoes:
        base = min(t["ctx"] for t in turnos[:3])
        R = anterior = 0
        for t in turnos:
            custo = t["inp"] * P_IN + t["cw"] * P_CW + t["cr"] * P_CR + t["out"] * P_OUT
            if t["ctx"] < anterior * 0.5:  # houve compactação de verdade
                R = 0
            anterior = t["ctx"]
            ctx_sim, extra = t["ctx"] - R, 0
            if ctx_sim >= h:
                R = t["ctx"] - (base + handoff_tam)
                ctx_sim = base + handoff_tam
                tot["resets"] += 1
                extra = handoff_saida * P_OUT + (base + handoff_tam + releitura) * P_CW
            tot["real"] += custo
            tot["sim"] += custo - min(t["ctx"] - ctx_sim, t["cr"]) * P_CR + extra
            tot["ctx_real"] += t["ctx"]
            tot["ctx_sim"] += ctx_sim
            tot["turnos"] += 1
            tot["acima"] += t["ctx"] >= h
    return tot


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--handoff", type=int, default=200_000, help="ponto de handoff em tokens (padrão 200000)")
    ap.add_argument("--dias", type=int, default=60, help="janela de histórico em dias (padrão 60)")
    ap.add_argument("--releitura", type=int, default=15_000, help="tokens relidos após cada recomeço (padrão 15000)")
    a = ap.parse_args()

    sessoes = carregar(a.dias)
    if not sessoes:
        print("Nenhuma sessão encontrada em ~/.claude/projects no período.")
        return
    t = simular(sessoes, a.handoff, releitura=a.releitura)
    print(f"Sessões: {len(sessoes)} · respostas: {t['turnos']:,}".replace(",", "."))
    print(f"Respostas acima de {a.handoff // 1000}k: {t['acima'] / t['turnos']:.0%}")
    print(f"Handoffs que teriam acontecido: {t['resets']}")
    print(f"Tokens processados: {t['ctx_real'] / 1e6:,.0f}M → {t['ctx_sim'] / 1e6:,.0f}M "
          f"({1 - t['ctx_sim'] / t['ctx_real']:.0%} a menos)".replace(",", "."))
    print(f"Custo ponderado: {1 - t['sim'] / t['real']:.0%} de economia")


if __name__ == "__main__":
    main()
