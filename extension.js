// Gadita Meditor: lê os transcripts do Claude Code (~/.claude/projects/*/*.jsonl),
// mede a janela de contexto e gera alertas com base nas boas práticas da Anthropic.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(os.homedir(), '.claude');
const PROJETOS = path.join(BASE, 'projects');
const GUARDA = path.join(BASE, 'context-guard');
const HANDOFFS = path.join(BASE, 'handoffs');
const RECENTE_MS = 24 * 3600 * 1000;
const MAX_SESSOES = 12;
const TTL_CACHE_MIN = 60; // assinatura: cache de 1h (docs: costs › cache misses)
const LEITURA = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
const CORRECAO = /\b(n[aã]o (funcionou|mudou|era|é isso)|errad[oa]|de novo|ainda (n[aã]o|t[aá]|est[aá])|continua|voltou|refa[zç]a?|nada mudou)\b/i;

// Pesos relativos ao preço de lista (entrada 1): escrita de cache 1h 2 · leitura 0,1 · saída 5.
const P = { entrada: 1, escrita: 2, leitura: 0.1, saida: 5 };

// ---------- limites (fonte única: context-guard/config.py) ----------
function lerLimites(janela) {
  const lim = { avisoPct: 40, avisoTokens: 120000, handoffPct: 60, handoffTokens: 200000, autoCompact: 0.8 };
  try {
    const cfg = fs.readFileSync(path.join(GUARDA, 'config.py'), 'utf8');
    const par = (nome) => cfg.match(new RegExp(`${nome}_PCT,\\s*${nome}_TOKENS\\s*=\\s*([\\d_]+),\\s*([\\d_]+)`));
    const a = par('AVISO'), h = par('HANDOFF');
    if (a) { lim.avisoPct = +a[1].replace(/_/g, ''); lim.avisoTokens = +a[2].replace(/_/g, ''); }
    if (h) { lim.handoffPct = +h[1].replace(/_/g, ''); lim.handoffTokens = +h[2].replace(/_/g, ''); }
  } catch { /* padrão */ }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(BASE, 'settings.json'), 'utf8'));
    if (typeof s.autoCompactWindow === 'number') lim.autoCompact = s.autoCompactWindow;
  } catch { /* padrão */ }
  return {
    janela,
    aviso: Math.min(janela * lim.avisoPct / 100, lim.avisoTokens),
    handoff: Math.min(janela * lim.handoffPct / 100, lim.handoffTokens),
    autoCompact: janela * lim.autoCompact,
  };
}

// ---------- leitura incremental ----------
class Sessao {
  constructor(arquivo) {
    this.arquivo = arquivo;
    this.id = path.basename(arquivo, '.jsonl');
    this.projeto = path.basename(path.dirname(arquivo));
    this.reiniciar();
  }
  reiniciar() {
    this.offset = 0; this.resto = Buffer.alloc(0);
    this.turnos = []; this.porMsg = new Map(); this.compactacoes = []; this.falhasCache = [];
    this.prompts = 0; this.textos = []; this.ferramentas = {}; this.leiturasDesdePrompt = 0;
    this.titulo = ''; this.modelo = ''; this.cwd = ''; this.inicio = 0; this.ultimaAtividade = 0; this.mtime = 0;
  }
  ler() {
    let st;
    try { st = fs.statSync(this.arquivo); } catch { return false; }
    if (st.size < this.offset) this.reiniciar();
    this.mtime = st.mtimeMs;
    if (st.size === this.offset) return false;
    const fd = fs.openSync(this.arquivo, 'r');
    try {
      const buf = Buffer.alloc(st.size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const dados = Buffer.concat([this.resto, buf]);
      let ini = 0, i;
      while ((i = dados.indexOf(10, ini)) !== -1) { this.linha(dados.toString('utf8', ini, i)); ini = i + 1; }
      this.resto = dados.subarray(ini);
    } finally { fs.closeSync(fd); }
    return true;
  }
  linha(txt) {
    if (!txt) return;
    let d;
    try { d = JSON.parse(txt); } catch { return; }
    const t = d.timestamp ? Date.parse(d.timestamp) : 0;
    if (t && !this.inicio) this.inicio = t;
    if (d.cwd) this.cwd = d.cwd;
    if (d.type === 'ai-title' && d.aiTitle) { this.titulo = d.aiTitle; return; }
    if (d.isSidechain) return;
    if (d.type === 'user' && d.origin && d.origin.kind === 'human') {
      this.prompts++; this.leiturasDesdePrompt = 0;
      if (t) this.ultimaAtividade = t;
      const c = d.message && d.message.content;
      const texto = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '');
      this.textos.push(texto.slice(0, 400));
      if (this.textos.length > 8) this.textos.shift();
    } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
      const m = d.compactMetadata || {};
      this.compactacoes.push({ t, antes: m.preTokens || 0, depois: m.postTokens || 0, gatilho: m.trigger || '' });
    } else if (d.type === 'assistant' && d.message) {
      const m = d.message, u = m.usage;
      if (t) this.ultimaAtividade = t;
      if (m.model && !m.model.startsWith('<')) this.modelo = m.model;
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type !== 'tool_use' || !c.name) continue;
        this.ferramentas[c.name] = (this.ferramentas[c.name] || 0) + 1;
        if (LEITURA.has(c.name)) this.leiturasDesdePrompt++;
      }
      if (!u) return;
      const turno = {
        t,
        entrada: u.input_tokens || 0,
        escrita: u.cache_creation_input_tokens || 0,
        leitura: u.cache_read_input_tokens || 0,
        saida: u.output_tokens || 0,
      };
      turno.ctx = turno.entrada + turno.escrita + turno.leitura;
      const idx = this.porMsg.get(m.id);
      if (idx !== undefined) { this.turnos[idx] = turno; return; }
      // Falha de cache (mesmo critério do /usage): reprocessou >5% e ≥2.000 do que já estava em cache.
      const ant = this.turnos[this.turnos.length - 1];
      if (ant) {
        const reprocessado = turno.escrita + turno.entrada - Math.max(turno.ctx - ant.ctx, 0);
        if (reprocessado >= 2000 && reprocessado > 0.05 * ant.ctx && !this.compactouDepois(ant.t)) {
          this.falhasCache.push({ t, tokens: reprocessado });
        }
      }
      this.porMsg.set(m.id, this.turnos.length);
      this.turnos.push(turno);
    }
  }
  compactouDepois(t) {
    const c = this.compactacoes[this.compactacoes.length - 1];
    return c && c.t >= t;
  }
  atual() {
    const ult = this.turnos[this.turnos.length - 1];
    const comp = this.compactacoes[this.compactacoes.length - 1];
    if (comp && (!ult || comp.t >= ult.t)) return comp.depois;
    return ult ? ult.ctx : 0;
  }
}

// ---------- simulação: e se o handoff + /clear acontecesse no ponto certo? ----------
// Mesmo modelo validado no histórico de 60 dias (46% de economia; 40–46% nos cenários pessimistas).
function simular(turnos, handoff) {
  if (turnos.length < 2) return { real: 0, sim: 0 };
  const base = Math.min(...turnos.slice(0, 3).map((t) => t.ctx));
  const HO = 4000, HO_SAIDA = 3000, RELEITURA = 15000;
  let R = 0, anterior = 0, real = 0, sim = 0;
  for (const t of turnos) {
    const custo = t.entrada * P.entrada + t.escrita * P.escrita + t.leitura * P.leitura + t.saida * P.saida;
    real += custo;
    if (t.ctx < anterior * 0.5) R = 0;
    anterior = t.ctx;
    let ctxSim = t.ctx - R, extra = 0;
    if (ctxSim >= handoff) {
      R = t.ctx - (base + HO);
      ctxSim = base + HO;
      extra = HO_SAIDA * P.saida + (base + HO + RELEITURA) * P.escrita;
    }
    sim += custo - Math.min(t.ctx - ctxSim, t.leitura) * P.leitura + extra;
  }
  return { real, sim: Math.min(sim, real) };
}

// ---------- alertas (boas práticas da Anthropic: docs costs + best-practices) ----------
function alertas(s, lim) {
  const a = [];
  const atual = s.atual();
  const agora = Date.now();
  const k = fmt;
  const add = (nivel, id, titulo, detalhe, acao) => a.push({ nivel, id, titulo, detalhe, acao });

  if (atual >= lim.handoff) {
    add('vermelho', 'handoff', 'Hora do handoff',
      `Cada mensagem reenvia ${k(atual)} de histórico. A qualidade também cai com a janela cheia.`,
      'Ctrl+Alt+H: handoff + limpar, e a sessão nova já retoma de onde parou.');
  } else if (atual >= lim.aviso) {
    add('amarelo', 'aviso', 'Contexto crescendo',
      `${k(atual)} na janela; o handoff chega em ${k(lim.handoff)}.`,
      'Feche a tarefa atual antes de começar outra.');
  }

  const pausaMin = (agora - s.ultimaAtividade) / 60000;
  if (s.ultimaAtividade && pausaMin > TTL_CACHE_MIN - 5 && atual > 50000) {
    add(atual >= lim.aviso ? 'vermelho' : 'amarelo', 'cache-frio', 'Cache expirado',
      `Pausa de ${Math.round(pausaMin)} min: a próxima mensagem reprocessa ${k(atual)} sem cache (validade de 1h).`,
      'Vai mudar de assunto? /clear. Mesma tarefa? /handoff antes de seguir.');
  }

  const falhas = s.falhasCache.filter((f) => agora - f.t < 3600000);
  const reescrito = falhas.reduce((x, f) => x + f.tokens, 0);
  if (falhas.length && reescrito >= 20000) {
    add('amarelo', 'falha-cache', 'Cache perdido',
      `${falhas.length} ${falhas.length > 1 ? 'turnos reescreveram' : 'turno reescreveu'} ${k(reescrito)} no cache na última hora.`,
      'Evite pausas longas no meio da tarefa e trocar de modelo no meio da sessão.');
  }

  const ult = s.turnos.slice(-6);
  const salto = ult.slice(1).reduce((mx, t, i) => Math.max(mx, t.ctx - ult[i].ctx), 0);
  if (salto > 25000) {
    add('amarelo', 'saida-grande', 'Resultado grande entrou no contexto',
      `Um único passo adicionou ${k(salto)}.`,
      'Peça saída filtrada (grep, head) ou use um subagente para logs, testes e documentação.');
  }

  const correcoes = s.textos.slice(-4).filter((x) => CORRECAO.test(x)).length;
  if (correcoes >= 2) {
    add('amarelo', 'correcoes', 'Correções repetidas',
      `${correcoes} dos últimos 4 pedidos parecem correções. O contexto acumula tentativas que falharam.`,
      'Depois de duas correções: /clear e um pedido novo com o que você aprendeu.');
  }

  const horas = s.inicio ? (s.ultimaAtividade - s.inicio) / 3600000 : 0;
  if (horas > 4 && s.prompts > 20) {
    add('amarelo', 'pia', 'Sessão longa com vários assuntos',
      `${horas.toFixed(1).replace('.', ',')}h e ${s.prompts} pedidos na mesma conversa.`,
      '/clear entre tarefas diferentes; /rename antes para achar a sessão depois.');
  }

  if (s.compactacoes.length) {
    const c = s.compactacoes[s.compactacoes.length - 1];
    add('amarelo', 'compactacao', 'Compactação é cara',
      `${s.compactacoes.length}× nesta sessão; a última leu ${k(c.antes)} para resumir.`,
      'Quando quiser recomeçar, prefira handoff + /clear, que não custa nada.');
  }

  const base = s.turnos.length ? Math.min(...s.turnos.slice(0, 3).map((t) => t.ctx)) : 0;
  if (base > 40000) {
    add('amarelo', 'base', 'Começo pesado',
      `A sessão já abre com ${k(base)} (sistema, memória, skills, ferramentas).`,
      '/context para ver o que pesa; desligue MCP sem uso; mantenha o CLAUDE.md abaixo de 200 linhas.');
  }

  if (s.leiturasDesdePrompt >= 15) {
    add('amarelo', 'exploracao', 'Exploração longa',
      `${s.leiturasDesdePrompt} leituras e buscas desde o último pedido.`,
      'Delimite o escopo ou peça "use um subagente para investigar".');
  }

  const recentes = s.turnos.slice(-10);
  const mediaSaida = recentes.length ? recentes.reduce((x, t) => x + t.saida, 0) / recentes.length : 0;
  if (/opus/i.test(s.modelo) && s.prompts >= 3 && recentes.length >= 8 && mediaSaida < 350) {
    add('verde', 'modelo', 'Tarefas simples no Opus',
      `Respostas curtas nos últimos turnos (média ${Math.round(mediaSaida)} tokens).`,
      'Para tarefas simples, /model sonnet ou /effort menor.');
  }

  // Técnica que resolve cada alerta (botão "Aplicar" no painel e na notificação).
  const APLICAR = {
    handoff: 'handoffLimpar', 'cache-frio': 'handoffLimpar', pia: 'handoffLimpar', compactacao: 'handoffLimpar',
    correcoes: 'conversaNova', 'saida-grande': 'subagente', exploracao: 'subagente', base: 'contexto', modelo: 'modelo',
  };
  for (const x of a) x.aplicar = APLICAR[x.id] || null;
  const ordem = { vermelho: 0, amarelo: 1, verde: 2 };
  return a.sort((x, y) => ordem[x.nivel] - ordem[y.nivel]);
}

function nomeProjeto(p) {
  const partes = p.replace(/^[a-zA-Z]--/, '').split('-').filter(Boolean);
  return partes.slice(-2).join('-') || p;
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(Math.round(n));
}

function config() {
  const c = vscode.workspace.getConfiguration('gaditaMeditor');
  return {
    janela: c.get('janela') || 0, // 0 = automático
    notificar: c.get('notificar') !== false,
    abrirAoIniciar: c.get('abrirAoIniciar') || 'nada',
    limparAposHandoff: c.get('limparAposHandoff') !== false,
  };
}

// ---------- monitor ----------
class Monitor {
  constructor() { this.sessoes = new Map(); this.fixada = null; this.notificados = new Set(); this.maiorVisto = 0; }
  varrer() {
    const agora = Date.now();
    let arquivos = [], dirs = [];
    try { dirs = fs.readdirSync(PROJETOS, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return false; }
    for (const d of dirs) {
      const pasta = path.join(PROJETOS, d.name);
      let nomes = [];
      try { nomes = fs.readdirSync(pasta); } catch { continue; }
      for (const n of nomes) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(pasta, n);
        try { const m = fs.statSync(f).mtimeMs; if (agora - m < RECENTE_MS) arquivos.push([f, m]); } catch { /* sumiu */ }
      }
    }
    arquivos = arquivos.sort((a, b) => b[1] - a[1]).slice(0, MAX_SESSOES);
    const vivos = new Set(arquivos.map((a) => a[0]));
    for (const k of [...this.sessoes.keys()]) if (!vivos.has(k)) this.sessoes.delete(k);
    let mudou = false;
    for (const [f] of arquivos) {
      if (!this.sessoes.has(f)) this.sessoes.set(f, new Sessao(f));
      const s = this.sessoes.get(f);
      if (s.ler()) {
        mudou = true;
        for (const t of s.turnos) if (t.ctx > this.maiorVisto) this.maiorVisto = t.ctx;
        for (const c of s.compactacoes) if (c.antes > this.maiorVisto) this.maiorVisto = c.antes;
        this.gravarEstado(s);
      }
    }
    return mudou;
  }
  // Janela automática: 1M se o modelo indica contexto estendido ou se já se viu mais de 200k; senão 200k.
  janela() {
    const fixa = config().janela;
    if (fixa) return fixa;
    const s = this.corrente();
    if (this.maiorVisto > 200000 || (s && /\[1m\]|-1m\b/i.test(s.modelo))) return 1000000;
    return 200000;
  }
  lista() { return [...this.sessoes.values()].filter((s) => s.turnos.length).sort((a, b) => b.mtime - a.mtime); }
  corrente() { const l = this.lista(); return l.find((s) => s.id === this.fixada) || l[0]; }
  // Alimenta o hook do kit de handoff, se ele estiver instalado (~/.claude/context-guard).
  gravarEstado(s) {
    if (!fs.existsSync(GUARDA)) return;
    const janela = this.janela();
    const arq = path.join(GUARDA, 'state', `${s.id}.json`);
    let st = {};
    try { st = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { /* novo */ }
    const tokens = s.atual();
    Object.assign(st, { tokens, tamanho: janela, pct: Math.round(tokens * 1000 / janela) / 10, cwd: s.cwd, ts: Date.now() / 1000 });
    try { fs.mkdirSync(path.dirname(arq), { recursive: true }); fs.writeFileSync(arq, JSON.stringify(st)); } catch { /* sem estado */ }
  }
}

function montarDados(mon) {
  const lim = lerLimites(mon.janela());
  const lista = mon.lista();
  const s = mon.corrente();
  const sessoes = lista.map((x) => ({
    id: x.id, titulo: x.titulo || '(sem título)', projeto: nomeProjeto(x.projeto),
    mtime: x.mtime, atual: x.atual(), prompts: x.prompts,
  }));
  let realDia = 0, simDia = 0;
  for (const x of lista) { const r = simular(x.turnos, lim.handoff); realDia += r.real; simDia += r.sim; }
  const economiaDia = { real: realDia, sim: simDia };
  const kit = fs.existsSync(path.join(GUARDA, 'hook.py'));
  if (!s) return { lim, sessoes, economiaDia, kit, s: null };

  const turnos = s.turnos;
  const rec = turnos.slice(-10);
  const deltas = rec.slice(1).map((t, i) => t.ctx - rec[i].ctx).filter((d) => d > 0);
  const ritmo = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
  const atual = s.atual();
  const entradaTotal = turnos.reduce((a, t) => a + t.ctx, 0);
  const passo = Math.max(1, Math.ceil(turnos.length / 160));
  return {
    lim, sessoes, economiaDia, kit,
    s: {
      id: s.id, titulo: s.titulo || '(sem título)', projeto: nomeProjeto(s.projeto), modelo: s.modelo,
      fixada: mon.fixada === s.id, mtime: s.mtime, atual,
      pico: turnos.reduce((a, t) => Math.max(a, t.ctx), 0),
      turnos: turnos.length, prompts: s.prompts,
      saidaTotal: turnos.reduce((a, t) => a + t.saida, 0),
      cacheHit: entradaTotal ? turnos.reduce((a, t) => a + t.leitura, 0) / entradaTotal : 0,
      ritmo, turnosAteHandoff: ritmo && atual < lim.handoff ? Math.ceil((lim.handoff - atual) / ritmo) : null,
      serie: turnos.filter((_, i) => i % passo === 0 || i === turnos.length - 1).map((t) => [t.t, t.ctx]),
      saidas: turnos.slice(-40).map((t) => t.saida),
      compactacoes: s.compactacoes.map((c) => ({ t: c.t, antes: c.antes })),
      ferramentas: Object.entries(s.ferramentas).sort((a, b) => b[1] - a[1]).slice(0, 8),
      alertas: alertas(s, lim),
      economia: simular(turnos, lim.handoff),
    },
  };
}

// ---------- webviews: barra lateral, aba e janela flutuante usam o mesmo HTML ----------
const TIPO_PAINEL = 'gaditaMeditor.flutuante';

class Paineis {
  constructor(ctx, mon) { this.ctx = ctx; this.mon = mon; this.alvos = new Set(); this.painel = null; }
  html(webview, modo) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f)).toString();
    return fs.readFileSync(path.join(this.ctx.extensionPath, 'media', 'painel.html'), 'utf8')
      .replace(/\{\{nonce\}\}/g, nonce).replace(/\{\{csp\}\}/g, webview.cspSource)
      .replace('{{js}}', uri('painel.js')).replace('{{css}}', uri('painel.css')).replace('{{modo}}', modo);
  }
  ligar(webview, modo) {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    webview.html = this.html(webview, modo);
    webview.onDidReceiveMessage((m) => this.comando(m));
    this.alvos.add(webview);
  }
  resolveWebviewView(view) {
    this.ligar(view.webview, 'lateral');
    view.onDidDispose(() => this.alvos.delete(view.webview));
    view.onDidChangeVisibility(() => view.visible && this.enviar());
  }
  // Painel em aba (restaurado depois de recarregar a janela).
  adotar(p) {
    this.painel = p;
    p.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icone.png');
    this.ligar(p.webview, 'aba');
    p.onDidDispose(() => { this.alvos.delete(p.webview); if (this.painel === p) this.painel = null; });
  }
  deserializeWebviewPanel(p) { this.adotar(p); return Promise.resolve(); }
  async abrirAba(flutuante) {
    if (this.painel) {
      this.painel.reveal(undefined, true);
      if (!flutuante) return;
    } else {
      this.adotar(vscode.window.createWebviewPanel(TIPO_PAINEL, 'Gadita Meditor',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { retainContextWhenHidden: true, enableFindWidget: false }));
    }
    if (!flutuante) return;
    // Solta a aba numa janela própria, compacta e sempre por cima (ignora o que a versão do VS Code não tiver).
    for (const cmd of ['workbench.action.moveEditorToNewWindow', 'workbench.action.enableCompactAuxiliaryWindow', 'workbench.action.toggleWindowAlwaysOnTop']) {
      try { await vscode.commands.executeCommand(cmd); } catch { /* sem suporte */ }
    }
  }
  enviar() {
    if (!this.alvos.size) return;
    const dados = montarDados(this.mon);
    for (const w of this.alvos) w.postMessage({ tipo: 'dados', dados }).then(undefined, () => {});
  }
  async comando(m) {
    if (m.tipo === 'pronto') this.enviar();
    else if (m.tipo === 'fixar') { this.mon.fixada = m.id === this.mon.fixada ? null : m.id; atualizarTudo(); }
    else if (m.tipo === 'copiarHandoff') copiarHandoff();
    else if (m.tipo === 'pastaHandoffs') vscode.commands.executeCommand('gaditaMeditor.pastaHandoffs');
    else if (m.tipo === 'limites') {
      const cfg = path.join(GUARDA, 'config.py');
      if (fs.existsSync(cfg)) vscode.window.showTextDocument(vscode.Uri.file(cfg));
      else vscode.commands.executeCommand('workbench.action.openSettings', 'gaditaMeditor');
    } else if (m.tipo === 'flutuar') this.abrirAba(true);
    else if (m.tipo === 'aba') this.abrirAba(false);
    else if (m.tipo === 'menu') vscode.commands.executeCommand('gaditaMeditor.menu');
    else if (m.tipo === 'tecnica' && TECNICAS[m.id]) TECNICAS[m.id].fn();
    else if (m.tipo === 'kit') vscode.env.openExternal(vscode.Uri.parse(`${REPO}#kit-de-handoff-opcional`));
  }
}

const REPO = 'https://github.com/rodrigogadita/gadita-meditor';

async function copiarHandoff() {
  await levarAoChat('/handoff');
}

// ---------- técnicas: atalhos que aplicam a limpeza ----------
// Comandos da extensão oficial do Claude Code para VS Code (anthropic.claude-code).
const CLAUDE_NOVA = 'claude-vscode.newConversation';
const CLAUDE_FOCO = 'claude-vscode.focus';
let comandosClaude = null;

async function temComando(id) {
  if (!comandosClaude) comandosClaude = new Set(await vscode.commands.getCommands(true));
  return comandosClaude.has(id);
}

// Nenhuma extensão pode digitar no chat do Claude: copia o comando e põe o cursor na caixa de mensagem.
async function levarAoChat(texto, dica) {
  await vscode.env.clipboard.writeText(texto);
  if (await temComando(CLAUDE_FOCO)) {
    try { await vscode.commands.executeCommand(CLAUDE_FOCO); } catch { /* chat fechado */ }
  }
  vscode.window.setStatusBarMessage(`$(clippy) ${dica || `"${texto.trim()}" pronto: Ctrl+V e Enter no chat do Claude`}`, 10000);
}

// Equivale ao /clear: abre uma conversa limpa (a anterior continua salva e pode ser retomada).
async function conversaNova() {
  if (await temComando(CLAUDE_NOVA)) {
    await vscode.commands.executeCommand(CLAUDE_NOVA);
    vscode.window.setStatusBarMessage('$(check) Conversa nova aberta. A anterior continua salva.', 8000);
    return true;
  }
  await levarAoChat('/clear', '"/clear" pronto: cole no Claude Code e envie');
  return false;
}

function handoffNovo(desde) {
  let maisNovo = null, mt = 0;
  try {
    for (const n of fs.readdirSync(HANDOFFS)) {
      if (!n.endsWith('.md') || n.endsWith('.usado.md')) continue;
      const m = fs.statSync(path.join(HANDOFFS, n)).mtimeMs;
      if (m > desde - 1000 && m > mt) { mt = m; maisNovo = path.join(HANDOFFS, n); }
    }
  } catch { /* pasta ainda não existe */ }
  return maisNovo;
}

// Handoff + limpar: pede o handoff; quando o arquivo aparece e a resposta termina, abre a conversa nova.
let esperaHandoff = null;
async function handoffLimpar() {
  const inicio = Date.now();
  const s = mon.corrente();
  await levarAoChat('/handoff', 'Ctrl+V e Enter no chat. Quando o handoff for salvo, eu abro a conversa nova.');
  if (esperaHandoff) clearInterval(esperaHandoff);
  let achado = null;
  esperaHandoff = setInterval(async () => {
    if (Date.now() - inicio > 15 * 60000) { clearInterval(esperaHandoff); esperaHandoff = null; return; }
    achado = achado || handoffNovo(inicio);
    if (!achado) return;
    // Espera a resposta do Claude terminar (registro da sessão parado há 5s) antes de limpar.
    if (s) {
      try { if (Date.now() - fs.statSync(s.arquivo).mtimeMs < 5000) return; } catch { /* segue */ }
    }
    clearInterval(esperaHandoff); esperaHandoff = null;
    const kit = fs.existsSync(path.join(GUARDA, 'hook.py'));
    const retomar = async () => {
      const limpou = await conversaNova();
      if (!kit && limpou) {
        await levarAoChat(`Leia ${achado.replace(/\\/g, '/')} e continue do próximo passo.`,
          'Pedido de retomada pronto: Ctrl+V e Enter na conversa nova.');
      }
    };
    if (config().limparAposHandoff) {
      await retomar();
      vscode.window.showInformationMessage(`Handoff salvo (${path.basename(achado)}) e conversa nova aberta.${kit ? ' O contexto volta sozinho.' : ''}`);
    } else {
      const r = await vscode.window.showInformationMessage(`Handoff salvo: ${path.basename(achado)}.`, 'Abrir conversa nova', 'Ver handoff');
      if (r === 'Abrir conversa nova') await retomar();
      if (r === 'Ver handoff') vscode.window.showTextDocument(vscode.Uri.file(achado));
    }
  }, 1500);
}

async function compactarComFoco() {
  const foco = await vscode.window.showInputBox({
    title: 'Compactar com foco',
    prompt: 'O que precisa sobreviver ao resumo? (compactar lê a conversa inteira: prefira handoff + limpar quando for recomeçar)',
    placeHolder: 'ex.: decisões do módulo de pagamentos, arquivos alterados e testes pendentes',
  });
  if (foco === undefined) return;
  await levarAoChat(`/compact ${foco}`.trim());
}

async function modeloEconomico() {
  const r = await vscode.window.showQuickPick([
    { label: '/model sonnet', description: 'a maior parte do código, custa menos que o Opus' },
    { label: '/model haiku', description: 'tarefas bem simples e repetitivas' },
    { label: '/effort low', description: 'menos raciocínio no mesmo modelo' },
    { label: '/model opus', description: 'voltar ao Opus para arquitetura e problemas difíceis' },
  ], { title: 'Modelo e esforço sob medida' });
  if (r) await levarAoChat(r.label);
}

const TECNICAS = {
  handoffLimpar: { fn: handoffLimpar, icone: 'sparkle', nome: 'Handoff + limpar', tecla: 'Ctrl+Alt+H', desc: 'resume, limpa e retoma na conversa nova' },
  conversaNova: { fn: conversaNova, icone: 'clear-all', nome: 'Conversa nova (/clear)', tecla: 'Ctrl+Alt+N', desc: 'trocou de assunto: comece limpo' },
  compactar: { fn: compactarComFoco, icone: 'fold', nome: 'Compactar com foco', tecla: 'Ctrl+Alt+C', desc: 'resume mantendo só o que você escolher' },
  contexto: { fn: () => levarAoChat('/context'), icone: 'pie-chart', nome: 'Ver o que pesa (/context)', tecla: '', desc: 'sistema, memória, ferramentas e conversa' },
  subagente: { fn: () => levarAoChat('Use um subagente para investigar: '), icone: 'hubot', nome: 'Investigar com subagente', tecla: '', desc: 'o volume fica fora da conversa principal' },
  lateral: { fn: () => levarAoChat('/btw '), icone: 'comment', nome: 'Pergunta lateral (/btw)', tecla: '', desc: 'a resposta não entra no histórico' },
  modelo: { fn: modeloEconomico, icone: 'dashboard', nome: 'Modelo econômico', tecla: '', desc: '/model sonnet, /effort low' },
};

async function tecnicas() {
  const itens = Object.entries(TECNICAS).map(([id, t]) => ({
    id, label: `$(${t.icone}) ${t.nome}`, description: t.tecla, detail: t.desc,
  }));
  const r = await vscode.window.showQuickPick(itens, { title: 'Gadita Meditor · técnicas que economizam', placeHolder: 'O que aplicar agora?' });
  if (r) TECNICAS[r.id].fn();
}

let mon, paineis, barra, atualizarTudo;

function atualizarBarra() {
  const lim = lerLimites(mon.janela());
  const s = mon.corrente();
  barra.backgroundColor = undefined;
  if (!s) { barra.text = '$(pulse) Gadita: sem sessão'; barra.tooltip = 'Nenhuma sessão do Claude Code nas últimas 24h. Clique para opções.'; barra.show(); return; }
  const atual = s.atual();
  const lista = alertas(s, lim);
  const vermelhos = lista.filter((a) => a.nivel === 'vermelho');
  const amarelos = lista.filter((a) => a.nivel === 'amarelo');
  if (vermelhos.length) barra.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  else if (amarelos.length || atual >= lim.aviso) barra.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  const qtd = vermelhos.length + amarelos.length;
  barra.text = `$(pulse) ${fmt(atual)} · ${Math.floor(atual * 100 / lim.handoff)}%` + (qtd ? ` · $(warning) ${qtd}` : '');
  const linhas = lista.map((a) => `- ${a.nivel === 'vermelho' ? '🔴' : a.nivel === 'amarelo' ? '🟡' : '🟢'} **${a.titulo}**: ${a.acao}`).join('\n');
  barra.tooltip = new vscode.MarkdownString(
    `**Gadita Meditor** · ${s.titulo || 'sessão atual'}\n\n${fmt(atual)} na janela · handoff em ${fmt(lim.handoff)}\n\n${linhas || '🟢 Tudo em ordem'}\n\nClique para abrir · Ctrl+Alt+G flutua`);
  barra.show();

  if (!config().notificar) return;
  for (const a of vermelhos) {
    const chave = `${s.id}:${a.id}`;
    if (mon.notificados.has(chave)) continue;
    mon.notificados.add(chave);
    const t = a.aplicar && TECNICAS[a.aplicar];
    const botoes = t ? [t.nome, 'Abrir flutuante'] : ['Abrir flutuante'];
    vscode.window.showWarningMessage(`Gadita Meditor · ${a.titulo}. ${a.acao}`, ...botoes).then((r) => {
      if (t && r === t.nome) t.fn();
      if (r === 'Abrir flutuante') paineis.abrirAba(true);
    });
  }
}

async function menu() {
  const itens = [
    { label: '$(multiple-windows) Janela flutuante', description: 'sempre por cima, arraste para onde quiser', id: 'flutuar' },
    { label: '$(split-horizontal) Abrir como aba', description: 'arraste a aba para qualquer lado do editor', id: 'aba' },
    { label: '$(layout-sidebar-left) Barra lateral', description: 'arraste o ícone para a direita para fixar lá', id: 'lateral' },
    { label: 'técnicas', kind: vscode.QuickPickItemKind.Separator },
    ...Object.entries(TECNICAS).map(([id, t]) => ({ label: `$(${t.icone}) ${t.nome}`, description: t.tecla, id: `tec:${id}` })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(folder-opened) Pasta de handoffs', id: 'pasta' },
    { label: '$(gear) Configurações', id: 'config' },
  ];
  const r = await vscode.window.showQuickPick(itens, { title: 'Gadita Meditor', placeHolder: 'Onde abrir o painel?' });
  if (!r) return;
  if (r.id === 'flutuar') paineis.abrirAba(true);
  else if (r.id === 'aba') paineis.abrirAba(false);
  else if (r.id === 'lateral') vscode.commands.executeCommand('workbench.view.extension.gaditaMeditor');
  else if (r.id.startsWith('tec:')) TECNICAS[r.id.slice(4)].fn();
  else if (r.id === 'pasta') vscode.commands.executeCommand('gaditaMeditor.pastaHandoffs');
  else if (r.id === 'config') vscode.commands.executeCommand('workbench.action.openSettings', 'gaditaMeditor');
}

function activate(ctx) {
  mon = new Monitor();
  paineis = new Paineis(ctx, mon);
  barra = vscode.window.createStatusBarItem('gaditaMeditor.barra', vscode.StatusBarAlignment.Right, 1000);
  barra.name = 'Gadita Meditor';
  barra.command = 'gaditaMeditor.menu';
  atualizarTudo = () => { atualizarBarra(); paineis.enviar(); };

  ctx.subscriptions.push(
    barra,
    vscode.window.registerWebviewViewProvider('gaditaMeditor.painel', paineis, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewPanelSerializer(TIPO_PAINEL, paineis),
    vscode.commands.registerCommand('gaditaMeditor.menu', menu),
    vscode.commands.registerCommand('gaditaMeditor.abrir', () => vscode.commands.executeCommand('workbench.view.extension.gaditaMeditor')),
    vscode.commands.registerCommand('gaditaMeditor.flutuar', () => paineis.abrirAba(true)),
    vscode.commands.registerCommand('gaditaMeditor.aba', () => paineis.abrirAba(false)),
    vscode.commands.registerCommand('gaditaMeditor.copiarHandoff', copiarHandoff),
    vscode.commands.registerCommand('gaditaMeditor.tecnicas', tecnicas),
    vscode.commands.registerCommand('gaditaMeditor.handoffLimpar', handoffLimpar),
    vscode.commands.registerCommand('gaditaMeditor.conversaNova', conversaNova),
    vscode.commands.registerCommand('gaditaMeditor.compactar', compactarComFoco),
    vscode.commands.registerCommand('gaditaMeditor.contexto', TECNICAS.contexto.fn),
    vscode.commands.registerCommand('gaditaMeditor.subagente', TECNICAS.subagente.fn),
    vscode.commands.registerCommand('gaditaMeditor.lateral', TECNICAS.lateral.fn),
    vscode.commands.registerCommand('gaditaMeditor.modelo', modeloEconomico),
    vscode.commands.registerCommand('gaditaMeditor.atualizar', () => { mon.varrer(); atualizarTudo(); }),
    vscode.commands.registerCommand('gaditaMeditor.pastaHandoffs', () => {
      fs.mkdirSync(HANDOFFS, { recursive: true });
      vscode.env.openExternal(vscode.Uri.file(HANDOFFS));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gaditaMeditor') && atualizarTudo()),
  );

  mon.varrer();
  atualizarTudo();
  const inicio = config().abrirAoIniciar;
  if (inicio === 'flutuante' || inicio === 'aba') setTimeout(() => paineis.abrirAba(inicio === 'flutuante'), 1500);

  let tique = 0;
  const timer = setInterval(() => {
    // Arquivo mudou: atualiza já. Sem mudança: reavalia a cada 30s (alerta de cache frio depende do relógio).
    if (mon.varrer() || ++tique % 15 === 0) atualizarTudo();
  }, 2000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate, _teste: { Sessao, alertas, simular, lerLimites, Monitor, montarDados } };
