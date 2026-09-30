// Gera prévias HTML do painel com dados fictícios (para capturas de tela e desenvolvimento).
//   node ferramentas/previa.js            -> docs/previa-*.html
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const agora = Date.UTC(2026, 8, 29, 18, 0);
const serie = [];
let ctx = 31000;
for (let i = 0; i < 64; i++) {
  ctx += i === 41 ? 34000 : 900 + Math.round(1200 * Math.abs(Math.sin(i * 1.7)));
  serie.push([agora - (64 - i) * 150000, ctx]);
}
const atual = serie[serie.length - 1][1];
const lim = { janela: 1000000, aviso: 120000, handoff: 200000, autoCompact: 800000 };
const dados = {
  lim, kit: true,
  economiaDia: { real: 48.2e6, sim: 27.4e6 },
  sessoes: [
    ['Refatorar módulo de pagamentos', 'api-pagamentos', atual, 3, 18],
    ['Testes do checkout', 'loja-web', 238000, 42, 31],
    ['Dashboard de vendas', 'painel-bi', 96000, 95, 9],
    ['Migração do banco', 'api-pagamentos', 410000, 180, 57],
    ['Revisão de PR #214', 'loja-web', 54000, 260, 4],
  ].map(([titulo, projeto, a, min, prompts], i) => ({ id: `s${i}`, titulo, projeto, atual: a, mtime: agora - min * 60000, prompts })),
  s: {
    id: 's0', titulo: 'Refatorar módulo de pagamentos', projeto: 'api-pagamentos', modelo: 'claude-opus-5-5',
    fixada: false, mtime: agora, atual, pico: atual, turnos: 64, prompts: 18, saidaTotal: 61200, cacheHit: 0.94,
    ritmo: 2300, turnosAteHandoff: Math.ceil((lim.handoff - atual) / 2300),
    serie, saidas: serie.slice(-40).map((_, i) => 400 + Math.round(2600 * Math.abs(Math.sin(i * 2.3)))),
    compactacoes: [],
    ferramentas: [['Read', 58], ['Edit', 31], ['Bash', 24], ['Grep', 19], ['Write', 7], ['Agent', 3]],
    alertas: [
      { nivel: 'amarelo', id: 'aviso', titulo: 'Contexto crescendo', detalhe: `${Math.round(atual / 1000)}k na janela; o handoff chega em 200k.`, acao: 'Feche a tarefa atual antes de começar outra.', aplicar: null },
      { nivel: 'amarelo', id: 'saida-grande', titulo: 'Resultado grande entrou no contexto', detalhe: 'Um único passo adicionou 34k.', acao: 'Peça saída filtrada (grep, head) ou use um subagente para logs, testes e documentação.', aplicar: 'subagente' },
    ],
    economia: { real: 9.8e6, sim: 7.9e6 },
  },
};

const media = path.join(raiz, 'media');
function previa(nome, { compacto = false, claro = false } = {}) {
  const html = fs.readFileSync(path.join(media, 'painel.html'), 'utf8')
    .replace(/<meta http-equiv[^>]+>/, '')
    .replace('<link rel="stylesheet" href="{{css}}">', `<style>${fs.readFileSync(path.join(media, 'painel.css'), 'utf8')}
      html, body { width: 340px; }</style>`)
    .replace('{{modo}}', 'lateral')
    .replace('<body', claro ? '<body class="vscode-light"' : '<body class="vscode-dark"')
    .replace(/<script nonce="\{\{nonce\}\}" src="\{\{js\}\}"><\/script>/, `<script>
      window.acquireVsCodeApi = () => ({ getState: () => (${compacto} ? { compacto: true } : null), setState() {},
        postMessage(m) { if (m.tipo === 'pronto') setTimeout(() => window.postMessage({ tipo: 'dados', dados: ${JSON.stringify(dados)} }, '*'), 0); } });
      Date.now = () => ${agora + 60000};
    </script><script>${fs.readFileSync(path.join(media, 'painel.js'), 'utf8')}</script>`);
  const saida = path.join(raiz, 'docs', `previa-${nome}.html`);
  fs.writeFileSync(saida, html);
  console.log(saida);
}

previa('escuro');
previa('compacto', { compacto: true });
previa('claro', { claro: true });
