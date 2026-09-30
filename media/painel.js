(function () {
  const vscode = acquireVsCodeApi();
  const salvo = vscode.getState() || {};
  let compacto = !!salvo.compacto;
  const abertos = Object.assign({ alertas: true, economia: true, evolucao: true, turnos: false, ferramentas: false, sessoes: true, acoes: true, dicas: false }, salvo.abertos);
  let dados = null;

  const $ = (s) => document.querySelector(s);
  const salvar = () => vscode.setState({ compacto, abertos });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(Math.round(n));
  };
  const pct = (v) => Math.round(v * 100) + '%';
  const hora = (t) => (t ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
  function atras(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `há ${m} min`;
    return `há ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }
  // verde / amarelo / vermelho pela posição em relação ao aviso e ao handoff
  function nivel(v, lim) {
    if (v >= lim.handoff) return { cor: 'vermelho', nome: 'hora do handoff' };
    if (v >= lim.aviso) return { cor: 'amarelo', nome: 'atenção' };
    return { cor: 'verde', nome: 'saudável' };
  }
  const v = (cor) => `var(--${cor})`;

  const icEncolher = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 5h3V2M10 7H7v3M5 5 1.5 1.5M7 7l3.5 3.5"/></svg>';
  const icExpandir = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 4.5v-3h3M10.5 7.5v3h-3M1.5 1.5 5 5M10.5 10.5 7 7"/></svg>';

  // ---------- anel neon: progresso até o handoff ----------
  function anel(val, lim, tam) {
    const grande = tam >= 100;
    const esp = grande ? 6 : 4;
    const r = tam / 2 - (grande ? 10 : 5), c = 2 * Math.PI * r, cx = tam / 2;
    const fr = Math.min(val / lim.handoff, 1);
    const n = nivel(val, lim);
    const pos = (f, rr) => { const a = -Math.PI / 2 + 2 * Math.PI * f; return [cx + rr * Math.cos(a), cx + rr * Math.sin(a)]; };
    const tiques = grande ? Array.from({ length: 48 }, (_, i) => {
      const [x1, y1] = pos(i / 48, r + 6), [x2, y2] = pos(i / 48, r + (i % 4 ? 7.5 : 9.5));
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--linha-forte)" stroke-width="1"/>`;
    }).join('') : '';
    const [ax1, ay1] = pos(lim.aviso / lim.handoff, r - esp), [ax2, ay2] = pos(lim.aviso / lim.handoff, r + esp);
    return `<svg class="anel neon-${n.cor}" width="${tam}" height="${tam}" viewBox="0 0 ${tam} ${tam}" role="img" aria-label="${Math.round(fr * 100)}% do ponto de handoff">
      ${tiques}
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--linha)" stroke-width="${esp}"/>
      <circle class="brilha" cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="currentColor" stroke-width="${esp}" stroke-linecap="round"
        stroke-dasharray="${Math.max(c * fr, 0.01)} ${c}" transform="rotate(-90 ${cx} ${cx})"/>
      <line x1="${ax1}" y1="${ay1}" x2="${ax2}" y2="${ay2}" stroke="var(--amarelo)" stroke-width="1.5"/>
      <text class="brilha-texto" x="${cx}" y="${cx + (grande ? 3 : 4)}" text-anchor="middle" font-size="${grande ? 25 : 12}" font-weight="600">${Math.floor((val / lim.handoff) * 100)}%</text>
      ${grande ? `<text x="${cx}" y="${cx + 18}" text-anchor="middle" font-size="8" style="fill:var(--suave);letter-spacing:.16em">DO HANDOFF</text>` : ''}
    </svg>`;
  }

  // ---------- linha: janela por turno ----------
  function grafLinha(s, lim, larg) {
    const alt = 150, pe = 30, pd = 8, pt = 12, pb = 18, pts = s.serie;
    if (pts.length < 2) return '<p class="vazio">Poucos turnos ainda para o gráfico.</p>';
    const maxY = Math.max(lim.handoff * 1.15, ...pts.map((p) => p[1]));
    const X = (i) => pe + (i / (pts.length - 1)) * (larg - pe - pd);
    const Y = (val) => pt + (1 - val / maxY) * (alt - pt - pb);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const ult = pts[pts.length - 1], n = nivel(ult[1], lim);
    const guia = (val, cor, nome) => val <= maxY ? `<line x1="${pe}" x2="${larg - pd}" y1="${Y(val)}" y2="${Y(val)}" stroke="${v(cor)}" stroke-opacity=".7" stroke-dasharray="3 4"/>
      <text x="${pe + 4}" y="${Y(val) - 4}">${nome} ${fmt(val)}</text>` : '';
    const eixo = [0, maxY / 2, maxY].map((val) => `<text x="${pe - 5}" y="${Y(val) + 3}" text-anchor="end">${fmt(val)}</text>
      <line x1="${pe}" x2="${larg - pd}" y1="${Y(val)}" y2="${Y(val)}" stroke="var(--linha)"/>`).join('');
    const comps = s.compactacoes.map((c) => {
      let i = pts.findIndex((p) => p[0] >= c.t); if (i < 0) i = pts.length - 1;
      return `<line x1="${X(i)}" x2="${X(i)}" y1="${pt}" y2="${alt - pb}" stroke="var(--suave)" stroke-dasharray="1 3"/>`;
    }).join('');
    return `<svg class="grafico" width="${larg}" height="${alt}" viewBox="0 0 ${larg} ${alt}">
      <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${v(n.cor)}" stop-opacity=".18"/><stop offset="1" stop-color="${v(n.cor)}" stop-opacity="0"/></linearGradient></defs>
      ${eixo}${comps}
      <path d="${d}L${X(pts.length - 1)},${Y(0)}L${X(0)},${Y(0)}Z" fill="url(#g)"/>
      <g class="neon-${n.cor}"><path class="brilha" d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/>
      <circle class="brilha" cx="${X(pts.length - 1)}" cy="${Y(ult[1])}" r="3" fill="currentColor"/></g>
      ${guia(lim.aviso, 'amarelo', 'aviso')}${guia(lim.handoff, 'vermelho', 'handoff')}
      <text class="valor-rotulo" x="${X(pts.length - 1) - 7}" y="${Y(ult[1]) - 7}" text-anchor="end">${fmt(ult[1])}</text>
      <text x="${pe}" y="${alt - 3}">${hora(pts[0][0])}</text><text x="${larg - pd}" y="${alt - 3}" text-anchor="end">${hora(ult[0])}</text>
    </svg>
    <div class="legenda"><span><i style="background:${v(n.cor)}"></i>tokens na janela</span><span><i style="background:var(--amarelo)"></i>aviso</span>
      <span><i style="background:var(--vermelho)"></i>handoff</span>${s.compactacoes.length ? '<span><i style="background:var(--suave)"></i>compactação</span>' : ''}</div>`;
  }

  function grafBarras(vals, larg) {
    if (!vals.length) return '<p class="vazio">Sem turnos.</p>';
    const alt = 70, pb = 14, max = Math.max(...vals, 1), w = larg / vals.length, iMax = vals.indexOf(max);
    const barras = vals.map((val, i) => {
      const h = Math.max(1, (val / max) * (alt - pb - 12));
      return `<rect x="${i * w + 1}" y="${alt - pb - h}" width="${Math.max(1, w - 2)}" height="${h}" fill="${i === vals.length - 1 ? 'var(--acento)' : 'var(--linha-forte)'}"/>`;
    }).join('');
    const xm = Math.min(Math.max(iMax * w + w / 2, 14), larg - 14);
    return `<svg class="grafico" width="${larg}" height="${alt}" viewBox="0 0 ${larg} ${alt}">${barras}
      <text class="valor-rotulo" x="${xm}" y="9" text-anchor="middle">${fmt(max)}</text>
      <text x="0" y="${alt - 2}">últimos ${vals.length} turnos</text><text x="${larg}" y="${alt - 2}" text-anchor="end">último ${fmt(vals[vals.length - 1])}</text></svg>`;
  }

  function secao(chave, titulo, extra, corpo, semPadding) {
    return `<details class="bloco" data-chave="${chave}" ${abertos[chave] ? 'open' : ''}>
      <summary><span class="rotulo">${titulo}</span><span class="extra num">${extra == null ? '' : extra}</span></summary>
      <div class="${semPadding ? '' : 'corpo'}">${corpo}</div></details>`;
  }

  function alertasHtml(lista) {
    if (!lista.length) {
      return `<div class="alerta neon-verde"><span class="ponto"></span><div><div class="t">Tudo em ordem</div>
        <div class="d">Nenhum sinal de desperdício pelas recomendações da Anthropic.</div></div></div>`;
    }
    return lista.map((a) => `<div class="alerta neon-${a.nivel}"><span class="ponto"></span><div>
      <div class="t">${esc(a.titulo)}</div><div class="d">${esc(a.detalhe)}</div><div class="a">${esc(a.acao)}</div></div></div>`).join('');
  }

  function economiaHtml(eco, dia) {
    const linha = (rotulo, val, max, cor) => `<div class="eco-linha"><span class="rotulo">${rotulo}</span>
      <span class="trilho"><div class="${cor === 'verde' ? 'brilha neon-verde' : ''}" style="width:${max ? (val / max) * 100 : 0}%;background:${v(cor)}"></div></span><span class="num">${fmt(val)}</span></div>`;
    const bloco = (titulo, e) => {
      if (!e.real) return '';
      const ganho = 1 - e.sim / e.real;
      return `<div><div class="linha-dado" style="margin-bottom:6px"><span>${titulo}</span>
        <b class="num ${ganho > 0.05 ? 'neon-verde brilha-texto' : ''}">${ganho > 0.005 ? '−' + pct(ganho) : 'sem ganho'}</b></div>
        ${linha('como foi', e.real, e.real, 'suave')}${linha('com handoff', e.sim, e.real, 'verde')}</div>`;
    };
    return `<div class="economia">${bloco('Esta sessão', eco)}${bloco('Últimas 24h', dia)}
      <div class="eco-nota">Custo ponderado pelo preço de lista (cache lido 0,1 · escrito 2 · saída 5), simulando handoff + /clear no ponto de handoff, já descontando o handoff e 15k de releitura. Num histórico real de 60 dias, a economia medida foi de 46%.</div></div>`;
  }

  // Recomendações oficiais (code.claude.com/docs/en/costs e /best-practices), em ordem de impacto.
  const DICAS = [
    ['/clear entre tarefas', 'Contexto velho é reenviado em toda mensagem. Feche a tarefa, faça o handoff e limpe.'],
    ['Pedido específico', 'Arquivo, função e critério de pronto. Pedido vago dispara leitura ampla.'],
    ['Duas correções, recomeça', 'Depois de 2 correções sem sucesso: /clear e um pedido melhor.'],
    ['Subagente para volume', 'Logs, testes e documentação ficam fora da conversa principal.'],
    ['Modelo sob medida', 'Sonnet para a maior parte do código; Opus para arquitetura. /effort menor no simples.'],
    ['Pausa longa quebra o cache', 'Depois de 1h parado, a próxima mensagem reprocessa tudo.'],
    ['Base enxuta', 'CLAUDE.md abaixo de 200 linhas, MCP sem uso desligado, instruções raras em skills.'],
  ];
  const dicasHtml = () => DICAS.map(([t, d], i) => `<div class="dica-item"><span class="num dica-n">${String(i + 1).padStart(2, '0')}</span>
    <div><div class="t">${t}</div><div class="d">${d}</div></div></div>`).join('');

  function sessoesHtml(d) {
    return d.sessoes.map((x) => {
      const n = nivel(x.atual, d.lim), fr = Math.min(x.atual / d.lim.handoff, 1);
      return `<button class="sessao ${d.s && x.id === d.s.id ? 'ativa' : ''}" data-id="${x.id}" title="${esc(x.titulo)}">
        <span class="t">${esc(x.titulo)}</span><span class="num neon-${n.cor}">${fmt(x.atual)}</span>
        <span class="m">${esc(x.projeto)} · ${atras(x.mtime)}</span><span class="m num">${x.prompts} pedidos</span>
        <span class="mini"><div style="width:${fr * 100}%;background:${v(n.cor)}"></div></span></button>`;
    }).join('') || '<p class="vazio" style="padding:0 12px">Nenhuma sessão nas últimas 24h.</p>';
  }

  function render() {
    const alvo = $('#conteudo');
    $('#modo').innerHTML = compacto ? icExpandir : icEncolher;
    $('#modo').title = compacto ? 'Expandir' : 'Encolher';
    if (!dados || !dados.s) { alvo.innerHTML = '<p class="vazio">Nenhuma sessão do Claude Code nas últimas 24h.</p>'; return; }
    const { s, lim } = dados;
    const n = nivel(s.atual, lim);
    const principal = s.alertas.find((a) => a.nivel !== 'verde');
    const larg = Math.max(180, Math.min(alvo.clientWidth, document.documentElement.clientWidth - 28) - 26);

    if (compacto) {
      alvo.innerHTML = `<div class="bloco compacto">${anel(s.atual, lim, 56)}
        <div class="dados"><span class="grande num">${fmt(s.atual)} <span style="color:var(--suave);font-size:11px">/ ${fmt(lim.handoff)}</span></span>
        <span class="estado neon-${principal ? principal.nivel : n.cor}">${esc(principal ? principal.titulo : n.nome)}</span>
        <span class="sub">${esc(s.titulo)}</span></div></div>`;
      return;
    }

    const falta = Math.max(lim.handoff - s.atual, 0);
    const kpis = [
      ['Janela', pct(s.atual / lim.janela), `${fmt(s.atual)} de ${fmt(lim.janela)}`],
      ['Até o handoff', falta ? fmt(falta) : 'agora', s.turnosAteHandoff ? `~${s.turnosAteHandoff} turnos no ritmo atual` : (falta ? 'ritmo indefinido' : 'gere o handoff e /clear')],
      ['Ritmo', fmt(s.ritmo), 'tokens por turno (últ. 10)'],
      ['Pico', fmt(s.pico), 'maior janela da sessão'],
      ['Pedidos', s.prompts, `${s.turnos} respostas do modelo`],
      ['Cache', pct(s.cacheHit), 'da entrada veio do cache'],
    ].map(([r, val, nota]) => `<div class="kpi"><span class="rotulo">${r}</span><span class="valor">${val}</span><span class="nota">${nota}</span></div>`).join('');

    const maxF = s.ferramentas.length ? s.ferramentas[0][1] : 1;
    const ferr = s.ferramentas.map(([nome, q]) => `<div class="hbar"><span class="nome" title="${esc(nome)}">${esc(nome.replace(/^mcp__claude_ai_/, ''))}</span>
      <span class="trilho"><div style="width:${(q / maxF) * 100}%"></div></span><span class="num">${q}</span></div>`).join('') || '<p class="vazio">Nenhuma ferramenta usada.</p>';
    const qtdAlertas = s.alertas.filter((a) => a.nivel !== 'verde').length;

    alvo.innerHTML = `
      <section class="bloco heroi">${anel(s.atual, lim, 132)}
        <div class="info-heroi">
          <span class="titulo-sessao" title="${esc(s.titulo)}">${esc(s.titulo)}</span>
          <span class="estado neon-${n.cor}">${n.nome}</span>
          <span class="linha-dado"><span>na janela</span><b class="num">${fmt(s.atual)}</b></span>
          <span class="linha-dado"><span>handoff em</span><b class="num">${fmt(lim.handoff)}</b></span>
          <span class="linha-dado"><span>modelo</span><b class="num">${esc((s.modelo || '—').replace('claude-', ''))}</b></span>
        </div>
      </section>
      ${secao('alertas', 'Alertas', qtdAlertas || '', `<div class="alertas">${alertasHtml(s.alertas)}</div>`, true)}
      <section class="kpis">${kpis}</section>
      ${secao('economia', 'Economia com handoff', '', economiaHtml(s.economia, dados.economiaDia), true)}
      ${secao('evolucao', 'Evolução da janela', `${s.turnos} turnos`, grafLinha(s, lim, larg))}
      ${secao('turnos', 'Saída por turno', fmt(s.saidaTotal), grafBarras(s.saidas, larg))}
      ${secao('ferramentas', 'Ferramentas mais usadas', s.ferramentas.length || '', ferr)}
      ${secao('sessoes', 'Sessões de hoje', dados.sessoes.length, sessoesHtml(dados), true)}
      ${secao('acoes', 'Ações', '', `<div class="acoes">
        <button class="botao principal" data-cmd="copiarHandoff">Copiar /handoff</button>
        <button class="botao" data-cmd="flutuar">Janela flutuante</button>
        <button class="botao" data-cmd="aba">Abrir como aba</button>
        <button class="botao" data-cmd="pastaHandoffs">Pasta de handoffs</button>
        <button class="botao" data-cmd="limites">Ajustar limites</button>
        ${dados.kit ? '' : '<button class="botao principal" data-cmd="kit">Instalar kit de handoff automático</button>'}
        <p class="dica">Ctrl+Alt+G abre a janela flutuante. Para fixar à direita, arraste o ícone do Gadita para a barra lateral secundária.</p></div>`)}
      ${secao('dicas', 'Técnicas que economizam', '', dicasHtml())}
      <div class="rodape num">${s.fixada ? 'sessão fixada · ' : 'segue a sessão mais recente · '}atualizado ${hora(s.mtime)}</div>`;
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'modo') { compacto = !compacto; salvar(); render(); }
    else if (b.id === 'flutuar') vscode.postMessage({ tipo: 'flutuar' });
    else if (b.id === 'menu') vscode.postMessage({ tipo: 'menu' });
    else if (b.dataset.id) vscode.postMessage({ tipo: 'fixar', id: b.dataset.id });
    else if (b.dataset.cmd) vscode.postMessage({ tipo: b.dataset.cmd });
  });
  document.addEventListener('toggle', (e) => {
    const k = e.target.dataset && e.target.dataset.chave;
    if (k) { abertos[k] = e.target.open; salvar(); }
  }, true);
  window.addEventListener('message', (e) => { if (e.data.tipo === 'dados') { dados = e.data.dados; render(); } });
  let rt;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(render, 120); }).observe(document.body);
  setInterval(render, 60000);
  vscode.postMessage({ tipo: 'pronto' });
})();
