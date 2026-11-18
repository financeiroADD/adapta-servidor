// Dados do PedidoOK: baixa só o que mudou, guarda em disco e monta o motor de cálculo.
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
let Engine; try { ({ Engine } = require('./engine')); } catch { ({ Engine } = require('../app/engine')); }
let V; try { V = require('./validacao1511'); } catch { V = require('../app/validacao1511'); }

const RECURSOS = ['produtos', 'fornecedores', 'vendedores', 'condicoes_pagamento', 'clientes', 'pedidos', 'cobrancas'];
const arq = n => path.join(cfg.DATA_DIR, n);
const ler = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const gravar = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const log = (...a) => console.log(new Date().toISOString(), ...a);

const hojeManaus = () => new Date().toLocaleDateString('en-CA', { timeZone: cfg.FUSO });

class Dados {
  constructor() {
    this.store = {}; for (const r of RECURSOS) this.store[r] = new Map((ler(arq(r + '.json'), [])).map(x => [x.id, x]));
    this.meta = ler(arq('_meta.json'), {});
    this.config = ler(arq('config.json'), {});          // modeloIA, parametros, prazos
    this.config.parametros = Object.assign({ prazoPadrao: 15, diasSeguranca: 7, cicloCompra: 15 }, this.config.parametros || {});
    this.config.prazos = this.config.prazos || {};
    this.config.fornecedorProduto = this.config.fornecedorProduto || {};   // produto sem fornecedor no PedidoOK -> fornecedor
    this.ultimoSync = this.meta._ultimoSync || null;
    this.sincronizando = false; this.ultimoErro = null;
    this._eng = null; this._hoje = null; this._sujo = true;
  }
  salvarConfig() { gravar(arq('config.json'), this.config); }
  contagem() { return Object.fromEntries(RECURSOS.map(r => [r, this.store[r].size])); }
  temTokens() { return !!(cfg.PEDIDOOK.tokenParceiro && cfg.PEDIDOOK.token); }

  // As respostas da validação de 15/11 (checklist do Danilo) entram uma única vez, quando já há fornecedores e produtos:
  // prazos dos fornecedores, compra diária, segurança de 90/45 dias e produtos sem fornecedor. Mudanças depois disso
  // ficam no config.json da pasta de dados e não são sobrescritas.
  aplicarValidacao() {
    const c = this.config;
    if (c.validacao1511 || !this.store.fornecedores.size || !this.store.produtos.size) return false;
    const f = V.aplicarNoServidor({ fornecedores: [...this.store.fornecedores.values()], produtos: [...this.store.produtos.values()], config: c });
    c.validacao1511 = new Date().toISOString(); this.salvarConfig(); this._sujo = true;
    log(`validação de 15/11 aplicada: ${f.prazos} prazos de fornecedor, compra diária com segurança de 90/45 dias, ${f.vinculos} produtos ligados ao fornecedor`);
    return true;
  }

  engine() {
    try { this.aplicarValidacao(); } catch (e) { log('validação de 15/11 não aplicada:', e && e.message); }
    const h = hojeManaus();
    if (!this._eng || this._sujo || this._hoje !== h) {
      const data = {}; for (const r of RECURSOS) data[r] = [...this.store[r].values()];
      this._eng = new Engine(data, Object.assign({}, this.config.parametros, { prazos: this.config.prazos, fornecedorProduto: this.config.fornecedorProduto, hoje: h }));
      this._hoje = h; this._sujo = false;
    }
    return this._eng;
  }

  // ---------- ações no PedidoOK (só depois do "confirmar" da pessoa; quem decide é o agente) ----------
  todos(r) { return this.store[r] ? [...this.store[r].values()] : []; }
  excluidos(r) { return (this.config.excluidosAdaptus || []).filter(x => x.recurso === r).map(x => x.registro); }
  lembrarExcluido(plano) {
    const m = String(plano.rota).match(/^\/(\w+)\/(\d+)$/);
    const reg = m && this.store[m[1]] ? this.store[m[1]].get(Number(m[2])) : null;
    if (!reg) return;
    const { itens, contatos, ...leve } = reg;
    this.config.excluidosAdaptus = (this.config.excluidosAdaptus || []).filter(x => !(x.recurso === m[1] && x.registro.id === reg.id)).concat([{ recurso: m[1], registro: Object.assign(leve, { excluido: true }), em: new Date().toISOString() }]).slice(-200);
    this.salvarConfig();
  }
  esquecerExcluido(plano) {
    const m = String(plano.rota).match(/^\/(\w+)\/(\d+)\/undelete$/);
    if (!m) return;
    this.config.excluidosAdaptus = (this.config.excluidosAdaptus || []).filter(x => !(x.recurso === m[1] && String(x.registro.id) === m[2]));
    this.salvarConfig();
  }
  // trilha das gravações (quem, o quê, quando, se gravou), as 500 últimas
  registrarAcao(e) { try { const f = arq('acoes.json'); const l = ler(f, []); l.push(Object.assign({ em: new Date().toISOString() }, e)); gravar(f, l.slice(-500)); } catch {} }
  async requisitar(metodo, rota, corpo) {
    if (!['POST', 'PATCH', 'DELETE'].includes(metodo)) throw new Error('Método não permitido.');
    if (!/^\/(pedidos|clientes|produtos|fornecedores|cobrancas)\/(\d{1,12}(\/(undelete|cabecalho|itens|contatos)(\/\d{1,12})?)?)?$/.test(String(rota))) throw new Error('Rota fora do catálogo de ações.');
    if (!this.temTokens()) throw new Error('Tokens do PedidoOK não configurados.');
    const url = cfg.PEDIDOOK.base + rota;
    if (!this.urlSegura(url)) throw new Error('Endereço fora do PedidoOK, ignorado.');
    const headers = { token_parceiro: cfg.PEDIDOOK.tokenParceiro, token_pedidook: cfg.PEDIDOOK.token, 'Content-Type': 'application/json' };
    const r = await fetch(url, { method: metodo, headers, body: corpo == null ? undefined : JSON.stringify(corpo), redirect: 'error', signal: AbortSignal.timeout(60000) });
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!r.ok) { let msg = 'HTTP ' + r.status; if (j && j.erros) msg = j.erros.map(e => e.codigo + ' - ' + e.mensagem).join('; '); const e = new Error(msg); e.status = r.status; throw e; }
    return j || {};
  }

  // Só o próprio PedidoOK: compara a origem inteira (protocolo + host + porta), nunca um prefixo de texto.
  urlSegura(url) { try { return new URL(url).origin === new URL(cfg.PEDIDOOK.base).origin; } catch { return false; } }
  async _get(url) {
    if (!this.urlSegura(url)) throw new Error('Endereço fora do PedidoOK, ignorado.');
    const headers = { token_parceiro: cfg.PEDIDOOK.tokenParceiro, token_pedidook: cfg.PEDIDOOK.token, 'Content-Type': 'application/json' };
    let ultimo;
    for (let t = 1; t <= 4; t++) {
      let r;
      // só leitura (GET) e sem seguir redirecionamento: os tokens nunca vão para outro endereço
      try { r = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(120000) }); }
      catch (e) { ultimo = e; await new Promise(ok => setTimeout(ok, 3000 * t)); continue; }
      const txt = await r.text();
      if (r.ok) return JSON.parse(txt);
      let msg = 'HTTP ' + r.status;
      try { const j = JSON.parse(txt); if (j.erros) msg = j.erros.map(e => e.codigo + ' - ' + e.mensagem).join('; '); } catch {}
      if ((r.status === 429 || r.status >= 500) && t < 4) { ultimo = new Error(msg); await new Promise(ok => setTimeout(ok, 5000 * t)); continue; }
      throw new Error(msg);
    }
    throw ultimo || new Error('Falha de conexão');
  }

  async sincronizar(origem = 'automatica') {
    if (this.sincronizando) return { ok: false, erro: 'Já existe uma sincronização em andamento.' };
    if (!this.temTokens()) return { ok: false, erro: 'Tokens do PedidoOK não configurados.' };
    this.sincronizando = true; let req = 0;
    try {
      for (const r of RECURSOS) {
        const desde = this.meta[r] ? new Date(new Date(String(this.meta[r]).slice(0, 19) + 'Z').getTime() - 60000).toISOString().slice(0, 19) : null;
        let url = cfg.PEDIDOOK.base + '/' + r + '/?' + (desde ? 'alterado_apos=' + encodeURIComponent(desde) : 'excluido=false');
        let pag = 0, maxAlt = this.meta[r] || '';
        while (url && pag < 5000) {
          pag++; req++;
          const j = await this._get(url);
          let lista = []; for (const k of Object.keys(j)) if (k !== 'href_proxima_pagina' && Array.isArray(j[k])) { lista = j[k]; break; }
          for (const x of lista) {
            if (x.excluido) this.store[r].delete(x.id); else this.store[r].set(x.id, x);
            if (x.ultima_alteracao && String(x.ultima_alteracao) > maxAlt) maxAlt = String(x.ultima_alteracao);
          }
          url = j.href_proxima_pagina || null;
          if (url && !this.urlSegura(url)) { log('SEGURANÇA: próxima página apontava para fora do PedidoOK, ignorada'); url = null; }
        }
        if (maxAlt) this.meta[r] = maxAlt;
        gravar(arq(r + '.json'), [...this.store[r].values()]);
      }
      this.ultimoSync = new Date().toISOString(); this.meta._ultimoSync = this.ultimoSync; this.ultimoErro = null;
      gravar(arq('_meta.json'), this.meta); this._sujo = true;
      log('sync ok', origem, 'requisicoes=' + req, JSON.stringify(this.contagem()));
      return { ok: true, requisicoes: req };
    } catch (e) {
      this.ultimoErro = e.message; gravar(arq('_meta.json'), this.meta); this._sujo = true;
      log('sync ERRO', origem, e.message);
      return { ok: false, erro: e.message };
    } finally { this.sincronizando = false; }
  }

  agendar() {
    if (!this.temTokens()) { log('PedidoOK sem tokens: o servidor responde com os dados que já tiver em disco.'); return; }
    setTimeout(() => this.sincronizar('inicial').catch(() => {}), 2000);
    setInterval(() => this.sincronizar('automatica').catch(() => {}), cfg.SYNC_HORAS * 3600 * 1000);
  }
}
module.exports = { Dados, hojeManaus, RECURSOS };
