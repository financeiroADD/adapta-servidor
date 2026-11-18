// Quem pode falar com o agente e o que cada perfil enxerga.
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

// Perfis. A lista de ferramentas é o que a IA consegue consultar para aquela pessoa;
// "esconder" tira campos sensíveis das respostas antes de a IA ver.
let ACESSO; try { ACESSO = require('./acesso'); } catch { ACESSO = require('../app/acesso'); }
const PAPEIS = ACESSO.PAPEIS;   // os mesmos níveis de acesso do programa

// Telefones brasileiros chegam ora com o 9 extra, ora sem. A chave ignora essa diferença.
function chaveTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length === 11 || d.length === 10) d = '55' + d;
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') d = d.slice(0, 4) + d.slice(5);
  return d;
}

function carregar() {
  let lista = [];
  try { if (cfg.USUARIOS_JSON) lista = JSON.parse(cfg.USUARIOS_JSON); } catch (e) { console.error('USUARIOS inválido:', e.message); }
  if (!lista.length) { try { lista = JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'usuarios.json'), 'utf8')); } catch {} }
  const mapa = new Map();
  for (const u of lista) {
    if (!u || !u.telefone) continue;
    const papel = PAPEIS[u.papel] ? u.papel : 'vendas';   // papel desconhecido = o mais restrito
    mapa.set(chaveTelefone(u.telefone), { nome: u.nome || 'Equipe', telefone: u.telefone, papel });
  }
  return mapa;
}

function filtrador(papel) {
  const esconder = new Set((PAPEIS[papel] || PAPEIS.vendas).esconder);
  if (!esconder.size) return null;
  const limpar = v => {
    if (Array.isArray(v)) return v.map(limpar);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (!esconder.has(k)) o[k] = limpar(x); return o; }
    return v;
  };
  return (_nome, resultado) => limpar(resultado);
}

module.exports = { PAPEIS, chaveTelefone, carregar, filtrador };
