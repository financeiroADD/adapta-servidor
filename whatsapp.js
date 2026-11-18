// Conversa com a API oficial do WhatsApp (Meta Cloud API): validar, ler e enviar mensagens.
'use strict';
const crypto = require('crypto');
const cfg = require('./config');
const W = cfg.WHATSAPP;
const base = () => `${W.graphBase}/${W.graphVersion}`;

// A Meta assina cada mensagem com o segredo do app (HMAC-SHA256 sobre o corpo cru).
function assinaturaValida(corpoCru, cabecalho) {
  if (!W.appSecret || !cabecalho || !cabecalho.startsWith('sha256=')) return false;
  const esperado = crypto.createHmac('sha256', W.appSecret).update(corpoCru).digest('hex');
  const recebido = cabecalho.slice(7);
  if (recebido.length !== esperado.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(recebido, 'hex'), Buffer.from(esperado, 'hex')); } catch { return false; }
}

// Tira do JSON da Meta só o que importa: quem mandou, o que mandou.
function lerMensagens(payload) {
  const out = [], falhas = [];
  for (const e of (payload && payload.entry) || []) for (const c of e.changes || []) {
    if (c.field !== 'messages' || !c.value) continue;
    const v = c.value, phoneId = v.metadata && v.metadata.phone_number_id;
    const nomes = new Map((v.contacts || []).map(x => [x.wa_id, x.profile && x.profile.name]));
    for (const m of v.messages || []) {
      const o = { id: m.id, de: m.from, nome: nomes.get(m.from) || null, tipo: m.type, ts: Number(m.timestamp) || 0, phoneId, texto: null, midiaId: null, mime: null, legenda: null };
      if (m.type === 'text') o.texto = m.text && m.text.body;
      else if (m.type === 'image') { o.midiaId = m.image && m.image.id; o.mime = m.image && m.image.mime_type; o.legenda = m.image && m.image.caption; }
      else if (m.type === 'audio') { o.midiaId = m.audio && m.audio.id; o.mime = m.audio && m.audio.mime_type; }
      else if (m.type === 'button') o.texto = m.button && m.button.text;
      else if (m.type === 'interactive') { const i = m.interactive || {}; o.texto = (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || null; }
      out.push(o);
    }
    for (const s of v.statuses || []) if (s.status === 'failed') falhas.push({ id: s.id, para: s.recipient_id, erros: (s.errors || []).map(x => `${x.code} ${x.title || x.message || ''}`.trim()) });
  }
  return { mensagens: out, falhas };
}

async function chamar(rota, corpo, metodo = 'POST') {
  // sem seguir redirecionamento: o token da Meta nunca vai para outro endereço
  const r = await fetch(base() + rota, { method: metodo, headers: { Authorization: 'Bearer ' + W.token, 'Content-Type': 'application/json' }, body: metodo === 'POST' ? JSON.stringify(corpo) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) { const e = new Error('WhatsApp ' + r.status + ': ' + ((j && j.error && (j.error.message || j.error.code)) || txt.slice(0, 200))); e.status = r.status; throw e; }
  return j;
}

// Mensagens do WhatsApp aceitam até 4096 caracteres: quebra em parágrafos.
function partir(texto, max = 3800) {
  const partes = []; let atual = '';
  for (const par of String(texto).split(/\n{2,}/)) {
    if ((atual + '\n\n' + par).length > max && atual) { partes.push(atual); atual = par; } else atual = atual ? atual + '\n\n' + par : par;
    while (atual.length > max) { partes.push(atual.slice(0, max)); atual = atual.slice(max); }
  }
  if (atual) partes.push(atual);
  return partes.length ? partes : ['(vazio)'];
}
async function enviarTexto(para, texto) {
  for (const p of partir(texto)) await chamar(`/${W.phoneId}/messages`, { messaging_product: 'whatsapp', to: para, type: 'text', text: { body: p, preview_url: false } });
}
// Modelo (template) aprovado na Meta: é o único tipo de mensagem aceito fora da janela de 24 horas.
// Os parâmetros não podem ter quebra de linha nem espaços repetidos.
async function enviarModelo(para, nome, idioma, parametros = []) {
  const limpo = t => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 60) || '-';
  await chamar(`/${W.phoneId}/messages`, { messaging_product: 'whatsapp', to: para, type: 'template', template: { name: nome, language: { code: idioma }, components: [{ type: 'body', parameters: parametros.map(t => ({ type: 'text', text: limpo(t) })) }] } });
}
async function enviarDocumento(para, { id, link, nome, legenda }) {
  await chamar(`/${W.phoneId}/messages`, { messaging_product: 'whatsapp', to: para, type: 'document', document: Object.assign(id ? { id } : { link }, { filename: nome, caption: legenda }) });
}
async function marcarComoLida(id) { try { await chamar(`/${W.phoneId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: id }); } catch {} }
// A mídia só é baixada de servidores da própria Meta (o token vai junto), por HTTPS e com limite de tamanho.
const HOSTS_MIDIA = /(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/i;
const MAX_MIDIA = 16 * 1024 * 1024;
function urlMidiaSegura(url) {
  try { const u = new URL(url); return (u.protocol === 'https:' && HOSTS_MIDIA.test(u.hostname)) || (!cfg.PRODUCAO && u.protocol === 'http:' && u.hostname === '127.0.0.1'); } catch { return false; }
}
async function baixarMidia(id) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(id || ''))) throw new Error('Identificador de mídia inválido');
  const meta = await chamar('/' + id, null, 'GET');
  if (!meta || !urlMidiaSegura(meta.url)) throw new Error('Endereço de mídia fora da Meta, ignorado');
  if (Number(meta.file_size) > MAX_MIDIA) throw new Error('Arquivo grande demais');
  const r = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + W.token }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Falha ao baixar a mídia (' + r.status + ')');
  const partes = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > MAX_MIDIA) throw new Error('Arquivo grande demais'); partes.push(c); }
  return { buffer: Buffer.concat(partes), mime: meta.mime_type };
}

// WhatsApp usa *negrito* com um asterisco; a IA escreve **negrito** e às vezes tabelas/títulos.
function paraWhatsApp(t) {
  return String(t)
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/^\|?\s*[-:| ]{3,}\|?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
module.exports = { assinaturaValida, lerMensagens, enviarTexto, enviarModelo, enviarDocumento, marcarComoLida, baixarMidia, paraWhatsApp, partir, urlMidiaSegura };
