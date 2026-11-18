// Segurança do Adaptus no WhatsApp: ocorrências, pessoas bloqueadas e reincidência.
// Fica em DATA_DIR/seguranca.json (só o dono do processo lê e escreve: permissão 600).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const ARQ = path.join(cfg.DATA_DIR, 'seguranca.json');
const MAX_OCORRENCIAS = 1000;
let estado = null;

function carregar() {
  if (estado) return estado;
  try { estado = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { estado = null; }
  if (!estado || typeof estado !== 'object') estado = {};
  estado.bloqueados = estado.bloqueados && typeof estado.bloqueados === 'object' ? estado.bloqueados : {};
  estado.ocorrencias = Array.isArray(estado.ocorrencias) ? estado.ocorrencias : [];
  return estado;
}
function salvar() {
  const e = carregar();
  e.ocorrencias = e.ocorrencias.slice(-MAX_OCORRENCIAS);
  const tmp = ARQ + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(e), { mode: 0o600 });
  fs.renameSync(tmp, ARQ);
}
const agora = () => new Date().toISOString();

function registrar(o) {
  const e = carregar();
  const oc = Object.assign({ id: 'oc' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), em: agora(), canal: 'whatsapp' }, o, { mensagem: String(o.mensagem || '').slice(0, 2000) });
  e.ocorrencias.push(oc); salvar();
  return oc;
}
function reincidencias(chave, dias = 7) {
  const lim = Date.now() - dias * 864e5;
  return carregar().ocorrencias.filter(o => o.usuarioId === chave && o.acao !== 'permitir' && o.gravidade >= 2 && !o.perdoada && new Date(o.em).getTime() >= lim).length;
}
function bloquear(chave, nome, motivo, ocorrenciaId) {
  carregar().bloqueados[chave] = { nome, em: agora(), motivo, ocorrenciaId, avisadoEm: agora() };
  salvar();
}
function bloqueado(chave) { return carregar().bloqueados[chave] || null; }
// quem está bloqueado recebe o aviso no máximo uma vez por dia (não gasta IA nem mensagens)
function deveAvisarBloqueado(chave) {
  const b = bloqueado(chave); if (!b) return false;
  if (b.avisadoEm && Date.now() - new Date(b.avisadoEm).getTime() < 864e5) return false;
  b.avisadoEm = agora(); salvar(); return true;
}
function liberar(chave, quem) {
  const e = carregar(); const b = e.bloqueados[chave]; if (!b) return null;
  delete e.bloqueados[chave];
  e.ocorrencias.forEach(o => { if (o.usuarioId === chave) o.perdoada = true; });
  e.ocorrencias.push({ id: 'oc' + Date.now().toString(36), em: agora(), canal: 'whatsapp', usuarioId: chave, nome: b.nome, categoria: 'liberacao', gravidade: 0, acao: 'liberado', motivo: 'acesso liberado por ' + (quem || 'Dono'), mensagem: '' });
  salvar(); return b;
}
function listarBloqueados() { return Object.entries(carregar().bloqueados).map(([chave, b]) => Object.assign({ chave }, b)); }
function ultimas(n = 10) { return carregar().ocorrencias.filter(o => o.gravidade >= 1).slice(-n).reverse(); }

module.exports = { registrar, reincidencias, bloquear, bloqueado, deveAvisarBloqueado, liberar, listarBloqueados, ultimas, _recarregar: () => { estado = null; } };
