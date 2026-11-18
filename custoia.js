// Custo da IA: preço de cada modelo, conta do gasto de cada chamada, tipo de cada pergunta e teto do mês.
// Ideia central: pergunta simples vai no modelo barato (Haiku), a do dia a dia no Sonnet e só a análise grande,
// com aviso e confirmação de quem perguntou, no modelo mais forte e com mais raciocínio.
'use strict';

// Preços oficiais da Anthropic em US$ por milhão de tokens (platform.claude.com/docs/en/about-claude/pricing, nov/2026).
// i = entrada, o = saída (o raciocínio conta como saída), w5/w1 = gravar no cache por 5 min/1 hora, r = ler do cache.
const PRECOS = {
  'haiku-5': { i: 0.10, o: 0.50, w5: 0.125, w1: 0.20, r: 0.01 },
  'haiku-5-longo': { i: 0.50, o: 2.50, w5: 0.625, w1: 1.00, r: 0.05 },   // pedido acima de 100 mil tokens
  'sonnet-5.5': { i: 2, o: 10, w5: 2.5, w1: 4, r: 0.10 },
  'sonnet-5': { i: 2, o: 10, w5: 2.5, w1: 4, r: 0.20 },
  'opus-5.5': { i: 4, o: 20, w5: 5, w1: 8, r: 0.20 },
  'opus-5': { i: 5, o: 25, w5: 6.25, w1: 10, r: 0.50 },
  'fable-5.2': { i: 8, o: 40, w5: 10, w1: 16, r: 0.20 },
  'fable-5': { i: 10, o: 50, w5: 12.5, w1: 20, r: 1 },
  'haiku-4': { i: 1, o: 5, w5: 1.25, w1: 2, r: 0.10 },
  'sonnet-4': { i: 3, o: 15, w5: 3.75, w1: 6, r: 0.30 },
  'opus-4': { i: 5, o: 25, w5: 6.25, w1: 10, r: 0.50 }
};

// "claude-sonnet-5-5" -> { fam: 'sonnet', v: 5.5 }; "claude-sonnet-4-5-20250929" -> 4.5; "claude-3-5-haiku-latest" -> 3.5
function versao(id) {
  const s = String(id || '').toLowerCase();
  let m = s.match(/claude-(haiku|sonnet|opus|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/);
  if (m) return { fam: m[1] === 'mythos' ? 'fable' : m[1], v: Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0) };
  m = s.match(/claude-(\d+)(?:-(\d))?-(haiku|sonnet|opus)/);
  if (m) return { fam: m[3], v: Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) };
  const f = s.match(/haiku|sonnet|opus|fable|mythos/);
  return f ? { fam: f[0] === 'mythos' ? 'fable' : f[0], v: null } : { fam: null, v: null };
}
function familia(id) { return versao(id).fam; }

function tabela(id) {
  const { fam, v } = versao(id);
  if (fam === 'haiku') return v == null || v >= 5 ? 'haiku-5' : 'haiku-4';
  if (fam === 'sonnet') return v == null || v >= 5.5 ? 'sonnet-5.5' : v >= 5 ? 'sonnet-5' : 'sonnet-4';
  if (fam === 'opus') return v == null || v >= 5.5 ? 'opus-5.5' : v >= 5 ? 'opus-5' : 'opus-4';
  if (fam === 'fable') return v == null || v >= 5.2 ? 'fable-5.2' : 'fable-5';
  return 'sonnet-5.5';
}

// Custo em US$ de uma chamada, pelo "usage" que a API devolve (entrada, cache lido/gravado e saída com o raciocínio)
function custoUSD(modelo, usage) {
  const u = usage || {};
  const entrada = +u.input_tokens || 0, lido = +u.cache_read_input_tokens || 0, gravado = +u.cache_creation_input_tokens || 0, saida = +u.output_tokens || 0;
  const cc = u.cache_creation || {};
  const g1 = +cc.ephemeral_1h_input_tokens || 0;
  const g5 = cc.ephemeral_5m_input_tokens != null ? +cc.ephemeral_5m_input_tokens || 0 : Math.max(0, gravado - g1);
  let k = tabela(modelo);
  if (k === 'haiku-5' && entrada + lido + gravado > 100000) k = 'haiku-5-longo';
  const p = PRECOS[k];
  return (entrada * p.i + g5 * p.w5 + g1 * p.w1 + lido * p.r + saida * p.o) / 1e6;
}

// Escolhe o modelo mais novo da família numa lista de ids (ex.: o Haiku 5.5 em vez de um Haiku antigo e mais caro)
function melhorDaFamilia(ids, fam) {
  const daFam = (ids || []).filter(id => familia(id) === fam || new RegExp(fam, 'i').test(id));
  if (!daFam.length) return null;
  return daFam.map((id, i) => ({ id, i, v: versao(id).v })).sort((a, b) => ((b.v || 0) - (a.v || 0)) || (a.i - b.i))[0].id;
}

// ---------- tipo de pergunta ----------
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MESES = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro';
// análise grande: cruza muitas fontes, períodos longos ou a carteira inteira (vale 3 pontos)
const FORTE = [
  /\brelatori/, /\blevantamento/, /\banalise (completa|detalhada|geral|aprofundada|profunda|da carteira|de todos)/, /\bdiagnostic/, /\bcomparativ/,
  /\bestrategi/, /\bplano de acao/, /\bfechamento (do|de) mes/, /\btendencia/, /\bprojec/, /\bcarteira\b/, /\btodos os (clientes|produtos|vendedores|fornecedores)/,
  /\borc\w* e nao fech/, /\bnao fech(ou|am|aram|ando|a)\b/, /\bpor ?que\b.{0,40}\b(caiu|cairam|caem|caindo|diminu|baix|perd|nao (fech|compr|vend))/, /\boportunidade/,
  /\bonde (estamos |a gente esta )?perdendo/, /\bcurva abc/, /\bmes a mes/, /\bultimos (6|12|seis|doze|24) meses/, /\bano (todo|inteiro|passado)/, /\balternativa/,
  /\baprofund/
];
// pede raciocínio, mas nem sempre análise grande (vale 2 pontos)
const MEDIO = [
  /\banalis/, /\bavali/, /\bcompar/, /\bvender mais/, /\baumentar (as |o )?(vendas|faturamento|ticket)/, /\bcrescer/, /\bmelhorar (as |o )?(vendas|faturamento|margem)/,
  /\bsugestao de compra/, /\bo que (devo|devemos|preciso|precisamos) comprar/, /\branking/, /\btop \d+/, /\bmargem por/, /\bpor (vendedor|cliente|produto|fornecedor)\b/,
  /\bplanilha/, /\bo que oferecer/, /\bcomo (vender|aumentar|recuperar|reativar)/
];
// consulta direta: um número, um produto, um cliente, um pedido (vai no modelo barato)
const CONSULTA = [
  /\b(tem|temos|ha|existe|sobrou)\b.{0,60}\bestoque/, /\bestoque (d[eoa]s?|atual)\b/, /\bquanto tem (de|em|no)\b/, /\bpreco d/, /\bquanto (custa|ta|esta|sai)\b/,
  /\bvalor d[oa]\b/, /\bcodigo d/, /\btelefone/, /\bcontato d/, /\bendereco/, /\bcnpj d/, /\bultim[oa] (pedido|compra|orcamento)/,
  /\bpedido (n[ºo°.]*|numero)?\s*\d{3,}/, /\bstatus do pedido/, /\bquanto (vend|fatur)\w*\s+(hoje|ontem|ess[ea] (mes|semana)|est[ea] (mes|semana)|no mes|nesse mes)/,
  new RegExp(`\\bquanto (vend|fatur)\\w*.{0,12}\\b(${MESES})\\b`),/\bquem (esta |ta )?(me )?dev/, /\bo que vence (hoje|amanha|essa semana|esta semana)/,
  /\b(vai|vao) faltar\b/, /\bacabando\b/, /\bzerad/, /\bquem compra\b/, /\bqual o prazo\b/, /\bpararam de comprar/
];
const SAUDACAO = /^(oi+|ola|opa|bom dia|boa tarde|boa noite|obrigad\w*|valeu|vlw|ok|okay|blz|beleza|show|perfeito|certo|entendi|tudo bem|tudo certo|top|massa|otimo)\b[\s!.,?]*$/;
const CONFIRMA = /^(sim|pode|pode sim|pode fazer|faz|faca|faça|manda|quero|isso|isso mesmo|claro|bora|vai)\b[\s!.,]*$/;

function classificarPergunta(texto, { anexos = [], arquivos = [], anterior = null } = {}) {
  const t = semAcento(texto).replace(/\s+/g, ' ').trim();
  let pontos = 0; const porque = [];
  for (const r of FORTE) if (r.test(t)) { pontos += 3; porque.push('análise grande'); break; }
  for (const r of MEDIO) if (r.test(t)) { pontos += 2; porque.push('pede análise'); break; }
  if ((t.match(/\?/g) || []).length >= 2) { pontos += 1; porque.push('várias perguntas'); }
  if (t.length > 220) { pontos += 1; porque.push('pergunta longa'); }
  const pdf = (anexos || []).some(a => a && a.tipo === 'pdf');
  const img = (anexos || []).some(a => a && a.tipo === 'imagem');
  const doc = (arquivos || []).some(a => a && (a.tipo === 'planilha' || a.tipo === 'documento')) || (anexos || []).some(a => a && (a.tipo === 'planilha' || a.tipo === 'documento'));
  const docGrande = (arquivos || []).some(a => a && String(a.texto || '').length > 20000) || (anexos || []).some(a => a && (a.tipo === 'pdf' || a.tipo === 'planilha') && (a.tamanho || 0) > 600 * 1024);
  if (docGrande) { pontos += 2; porque.push('anexo grande'); }
  const consulta = CONSULTA.some(r => r.test(t));
  let nivel;
  if (pontos >= 3) nivel = 'completa';
  else if (pontos >= 1 || pdf || img || doc) nivel = 'normal';
  else if (SAUDACAO.test(t) && t.length <= 40) nivel = 'rapida';
  else if (CONFIRMA.test(t) && anterior) nivel = 'normal';            // "sim, pode" continua o assunto anterior
  else if (consulta && t.length <= 160) nivel = 'rapida';
  else nivel = 'normal';
  if (nivel === 'rapida' && anterior === 'completa' && !consulta && !SAUDACAO.test(t)) nivel = 'normal';   // "e da Capital?" depois de uma análise
  const motivo = nivel === 'completa' ? porque[0] || 'análise grande' : nivel === 'rapida' ? (SAUDACAO.test(t) ? 'conversa' : 'consulta direta') : porque[0] || (pdf || img || doc ? 'anexo' : 'pergunta do dia a dia');
  return { nivel, motivo, pontos };
}

// ---------- estimativa e teto do mês ----------
// custo médio por pergunta (US$) medido no modelo de custo com o cache ligado; é trocado pela média real assim que houver uso
const PADRAO_USD = { rapida: 0.003, normal: 0.07, completa: 0.19 };
const FATOR_FAMILIA = { sonnet: 1, opus: 2, fable: 4 };

function estimar(nivel, { familiaCompleta = 'sonnet', medias = {}, cotacao = 5.5 } = {}) {
  const real = medias && medias[nivel] && medias[nivel].n >= 5 ? medias[nivel].usd : null;
  let usd = real != null ? real : PADRAO_USD[nivel] * (nivel === 'completa' ? (FATOR_FAMILIA[familiaCompleta] || 1) : 1);
  const r = v => Math.max(0.01, Math.round(v * cotacao * 100) / 100);
  return { nivel, medio: r(usd), min: r(usd * 0.5), max: r(usd * 2), medido: real != null };
}

function faixa(gastoBRL, teto, alertaPct = 80) {
  if (!(teto > 0)) return 'ok';
  const pct = gastoBRL / teto * 100;
  return pct >= 100 ? 'estourado' : pct >= alertaPct ? 'alerta' : 'ok';
}

// O que cada perfil pode usar em cada faixa. A resposta nunca some: no pior caso, a equipe fica no modo rápido.
function politica({ papel, faixa: f, pedido }) {
  const dono = papel === 'dono';
  let nivel = ['rapida', 'normal', 'completa'].includes(pedido) ? pedido : 'normal';
  let aviso = null;
  const economia = f !== 'ok';
  if (!dono && f === 'alerta' && nivel === 'completa') { nivel = 'normal'; aviso = 'O gasto da IA está perto do limite do mês, então as análises completas estão pausadas. Esta resposta saiu resumida; o Danilo pode liberar.'; }
  if (!dono && f === 'estourado') { if (nivel !== 'rapida') aviso = 'O limite de gasto da IA deste mês foi atingido. O Adaptus continua respondendo no modo rápido; o Danilo pode aumentar o limite em Configurações.'; nivel = 'rapida'; }
  return { nivel, economia, aviso };
}

// ---------- registro do gasto do mês ----------
function mesDe(d) { return (d instanceof Date ? d : new Date(d || Date.now())).toISOString().slice(0, 7); }
function gastoVazio(mes) { return { mes, usd: 0, chamadas: 0, porUso: {}, porDia: {}, porNivel: {}, porPessoa: {}, amostras: {} }; }
function noMes(g, agora = new Date()) {
  const mes = mesDe(agora);
  if (!g || typeof g !== 'object' || g.mes !== mes) {
    const novo = gastoVazio(mes);
    if (g && g.mes && g.amostras) novo.amostras = g.amostras;       // as médias por tipo de pergunta continuam valendo no mês novo
    if (g && g.mes) novo.anterior = { mes: g.mes, usd: Math.round((g.usd || 0) * 10000) / 10000 };
    return novo;
  }
  return g;
}
// cada chamada à API (pergunta, triagem de segurança, leitura de print/nota)
function registrarChamada(g, { usd, uso = 'conversa' }, agora = new Date()) {
  g = noMes(g, agora);
  const dia = agora.toISOString().slice(8, 10);
  g.usd += usd; g.chamadas++;
  g.porUso[uso] = (g.porUso[uso] || 0) + usd;
  g.porDia[dia] = (g.porDia[dia] || 0) + usd;
  return g;
}
// cada pergunta completa (soma das voltas): alimenta a média usada na estimativa e o gasto por pessoa
function registrarPergunta(g, { usd, nivel, quem }, agora = new Date()) {
  g = noMes(g, agora);
  const n = g.porNivel[nivel] || (g.porNivel[nivel] = { n: 0, usd: 0 });
  n.n++; n.usd += usd;
  if (quem) g.porPessoa[quem] = (g.porPessoa[quem] || 0) + usd;
  const a = g.amostras[nivel] || (g.amostras[nivel] = []);
  if (usd > 0) { a.push(Math.round(usd * 1e5) / 1e5); if (a.length > 30) a.splice(0, a.length - 30); }
  return g;
}
function medias(g) {
  const out = {};
  for (const [k, a] of Object.entries((g && g.amostras) || {})) if (a.length) out[k] = { n: a.length, usd: a.reduce((x, y) => x + y, 0) / a.length };
  return out;
}
// resumo para a tela do Dono, em reais
function resumo(g, { teto = 500, cotacao = 5.5, alertaPct = 80 } = {}, agora = new Date()) {
  g = noMes(g, agora);
  const brl = v => Math.round((v || 0) * cotacao * 100) / 100;
  const gasto = brl(g.usd);
  const dia = agora.getUTCDate(), diasMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 0)).getUTCDate();
  const projecao = dia >= 3 ? Math.round(gasto / dia * diasMes * 100) / 100 : null;
  return {
    mes: g.mes, gasto, teto, pct: teto > 0 ? Math.round(gasto / teto * 1000) / 10 : 0, faixa: faixa(gasto, teto, alertaPct), projecao,
    perguntas: Object.fromEntries(['rapida', 'normal', 'completa'].map(k => [k, { n: (g.porNivel[k] || {}).n || 0, valor: brl((g.porNivel[k] || {}).usd) }])),
    porUso: Object.fromEntries(Object.entries(g.porUso).map(([k, v]) => [k, brl(v)])),
    porPessoa: Object.entries(g.porPessoa).map(([nome, v]) => ({ nome, valor: brl(v) })).sort((a, b) => b.valor - a.valor).slice(0, 8),
    porDia: Object.entries(g.porDia).sort().map(([d, v]) => ({ dia: d, valor: brl(v) })),
    anterior: g.anterior ? { mes: g.anterior.mes, valor: brl(g.anterior.usd) } : null,
    cotacao
  };
}

module.exports = { PRECOS, versao, familia, tabela, custoUSD, melhorDaFamilia, classificarPergunta, estimar, faixa, politica, noMes, registrarChamada, registrarPergunta, medias, resumo, PADRAO_USD, semAcento };
