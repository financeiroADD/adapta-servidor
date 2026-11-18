// Motor de cálculo da Adapta Inteligência Comercial.
// Recebe os dados do PedidoOK (arrays) e responde às perguntas do negócio.
'use strict';

const DIA = 86400000;
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const ymd = d => d.toISOString().slice(0, 10);
const parseD = s => { if (!s) return null; const d = new Date(String(s).slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? null : d; };
const diasEntre = (a, b) => Math.round((b - a) / DIA);

class Engine {
  constructor(data, cfg = {}) {
    this.cfg = Object.assign({ prazoPadrao: 15, diasSeguranca: 7, cicloCompra: 15, prazos: {}, perfilProduto: {} }, cfg);
    // Produto de estoque x sob encomenda: decide pela FREQUÊNCIA de venda (meses e pedidos), não pelo volume.
    this.cfg.reposicao = Object.assign({ recMeses: 3, recPedidos: 4 }, cfg.reposicao || {});
    this.hojeD = cfg.hoje ? parseD(cfg.hoje) : parseD(ymd(new Date()));
    this.hoje = ymd(this.hojeD);
    const ativos = a => (a || []).filter(x => x && !x.excluido);
    // vínculo produto -> fornecedor feito no sistema (quando o PedidoOK não tem o fornecedor do produto)
    const fp = this.cfg.fornecedorProduto || {};
    this.produtos = ativos(data.produtos).map(p => fp[String(p.id)] != null && String(fp[String(p.id)]) !== String(p.id_fornecedor) ? Object.assign({}, p, { id_fornecedor: Number(fp[String(p.id)]) || fp[String(p.id)], fornecedor_no_sistema: true }) : p);
    this.clientes = ativos(data.clientes);
    this.fornecedores = ativos(data.fornecedores);
    this.vendedores = ativos(data.vendedores);
    this.condicoes = ativos(data.condicoes_pagamento);
    this.titulos = ativos(data.cobrancas);
    this.pedidosTodos = ativos(data.pedidos);
    this.prodById = new Map(this.produtos.map(p => [p.id, p]));
    this.nomesProdutos = new Map((data.produtos || []).filter(p => p && p.id != null).map(p => [p.id, p.nome]));   // inclui inativos (para nomear o histórico)
    this.cliById = new Map(this.clientes.map(c => [c.id, c]));
    this.fornById = new Map(this.fornecedores.map(f => [f.id, f]));
    this.vendById = new Map(this.vendedores.map(v => [v.id, v]));
    this._preparar();
  }

  nomeCliente(id) { const c = this.cliById.get(id); return c ? (c.fantasia || c.razao_social || ('Cliente ' + id)) : ('Cliente ' + id); }
  nomeFornecedor(id) {
    const f = this.fornById.get(id); if (f) return f.fantasia || f.razao_social;
    if (id === 'varia') return 'Compra avulsa (menor preço do dia)';   // café, leite: compra onde estiver mais barato
    if (typeof id === 'string' && id.trim()) return id.trim().toUpperCase() + ' (fora do PedidoOK)';
    return 'Sem fornecedor cadastrado';
  }
  nomeVendedor(id) { const v = this.vendById.get(id); return v ? v.nome : ('Vendedor ' + id); }

  // Valor líquido do pedido igual ao do PedidoOK (relatório "Venda geral", coluna Líquido R$):
  // soma de quantidade x preço líquido dos itens + desconto/acréscimo em REAIS lançado no pedido.
  // O desconto em PERCENTUAL do pedido já vem embutido no preço líquido de cada item (não se aplica de novo).
  // O frete não entra no líquido (fica separado). Conferido pedido a pedido com o relatório de outubro/2026.
  static valorPedido(p) {
    let itens = 0, custo = 0;
    for (const it of (p.itens || [])) {
      if (it.excluido) continue;
      const q = Number(it.quantidade) || 0;
      itens += q * (Number(it.preco_liquido) || 0);
      custo += q * (Number(it.preco_custo) || 0);
    }
    const v = Number(p.valor_desconto_acrescimo) || 0;
    const ajuste = v && p.tipo_desconto_acrescimo !== 'percentual' ? v : 0;
    const total = itens + ajuste;
    return { itens, ajuste, total, custo, frete: Number(p.valor_frete) || 0, fator: itens ? total / itens : 1 };
  }

  _preparar() {
    this.vendas = [];
    this.orcamentos = [];
    this.faturados = [];       // qualquer status, pela data de faturamento (como o relatório "pedidos faturados entre")
    let maxData = null;
    for (const p of this.pedidosTodos) {
      const d = parseD(p.emissao);
      if (!d) continue;
      const val = Engine.valorPedido(p);
      const dfat = parseD(p.faturamento);
      const reg = { p, d, data: ymd(d), total: val.total, custo: val.custo, frete: val.frete, ajuste: val.ajuste, fator: val.fator, datafat: dfat ? ymd(dfat) : null };
      if (dfat) this.faturados.push(reg);
      if (p.status === 'orcamento') this.orcamentos.push(reg);
      else if (p.status === 'pedido') { this.vendas.push(reg); if (!maxData || d > maxData) maxData = d; }
    }
    this.ultimaVenda = maxData ? ymd(maxData) : null;

    // Estatísticas por produto
    const st = new Map();
    const get = id => { let s = st.get(id); if (!s) { s = { q30: 0, q90: 0, q180: 0, q365: 0, fat365: 0, cus365: 0, ult: null, meses: {}, ped90: 0, ped180: 0, cli180: new Set() }; st.set(id, s); } return s; };
    for (const v of this.vendas) {
      const idade = diasEntre(v.d, this.hojeD);
      if (idade < 0 || idade > 730) continue;
      const mes = v.data.slice(0, 7);
      const vistos = new Set();   // o mesmo produto duas vezes no pedido conta como um pedido só
      for (const it of (v.p.itens || [])) {
        if (it.excluido) continue;
        const s = get(it.id_produto);
        const q = Number(it.quantidade) || 0;
        if (!vistos.has(it.id_produto) && q > 0) {
          vistos.add(it.id_produto);
          if (idade <= 180) { s.ped180++; s.cli180.add(v.p.id_cliente); }
          if (idade <= 90) s.ped90++;
        }
        s.meses[mes] = (s.meses[mes] || 0) + q;
        if (!s.ult || v.data > s.ult) s.ult = v.data;
        if (idade <= 365) { s.q365 += q; s.fat365 += q * (Number(it.preco_liquido) || 0) * v.fator; s.cus365 += q * (Number(it.preco_custo) || 0); }
        if (idade <= 180) s.q180 += q;
        if (idade <= 90) s.q90 += q;
        if (idade <= 30) s.q30 += q;
      }
    }
    // Curva ABC por faturamento em 12 meses
    const ord = [...st.entries()].filter(([, s]) => s.fat365 > 0).sort((a, b) => b[1].fat365 - a[1].fat365);
    const tot = ord.reduce((a, [, s]) => a + s.fat365, 0) || 1;
    let acc = 0;
    for (const [, s] of ord) { acc += s.fat365; s.abc = acc / tot <= 0.8 ? 'A' : acc / tot <= 0.95 ? 'B' : 'C'; }
    // últimos 6 meses do calendário (o atual incluído) para medir a frequência de venda
    const m6 = []; { const d = new Date(this.hojeD.getFullYear(), this.hojeD.getMonth(), 1); for (let k = 0; k < 6; k++) { m6.push(ymd(d).slice(0, 7)); d.setMonth(d.getMonth() - 1); } }
    for (const [, s] of st) { const tem = m => (s.meses[m] || 0) > 0; s.mes6 = m6.filter(tem).length; s.mes3 = m6.slice(0, 3).filter(tem).length; s.mes3a = m6.slice(3).filter(tem).length; s.cli180 = s.cli180.size; }
    this.stats = st;
  }

  // Venda média diária: pesa mais o recente, mas não ignora o trimestre.
  taxa(id) {
    const s = this.stats.get(id);
    if (!s) return 0;
    const r30 = s.q30 / 30, r90 = s.q90 / 90, r180 = s.q180 / 180;
    if (s.q90 === 0) return 0; // sem venda nos últimos 90 dias: não entra em alerta
    return Math.max(0.5 * r30 + 0.5 * r90, 0.7 * r90 + 0.3 * r180);
  }
  prazo(fornId) { const p = this.cfg.prazos[String(fornId)]; return Number(p) > 0 ? Number(p) : this.cfg.prazoPadrao; }
  // dias de estoque de segurança: fornecedor demorado (prazo >= limiteDemorado) usa diasSegurancaDemorado; os outros, diasSeguranca
  segDias(prazo) {
    const d = Number(this.cfg.diasSegurancaDemorado);
    return this.cfg.diasSegurancaDemorado != null && Number.isFinite(d) && prazo >= (Number(this.cfg.limiteDemorado) || 20) ? d : this.cfg.diasSeguranca;
  }

  // Perfil de reposição. "estoque": vende com frequência, tem que ter na prateleira. "encomenda": venda esporádica,
  // a empresa vende primeiro e compra depois. Compras ou o Dono podem fixar o perfil de um produto; senão é automático.
  perfilAuto(id) {
    const s = this.stats.get(id) || {};
    const r = this.cfg.reposicao;
    return (s.mes6 || 0) >= r.recMeses && (s.ped180 || 0) >= r.recPedidos ? 'estoque' : 'encomenda';
  }
  perfil(id) {
    const s = this.stats.get(id) || {};
    const manual = this.cfg.perfilProduto[String(id)];
    const auto = this.perfilAuto(id);
    const perfil = manual === 'estoque' || manual === 'encomenda' ? manual : auto;
    return {
      perfil, origem: manual === 'estoque' || manual === 'encomenda' ? 'definido' : 'automatico', automatico: auto,
      meses_com_venda_6m: s.mes6 || 0, meses_recentes_3m: s.mes3 || 0, meses_anteriores_3m: s.mes3a || 0, pedidos_180d: s.ped180 || 0, clientes_180d: s.cli180 || 0,
      venda_mes: r2(this.taxa(id) * 30),
      recorrencia: `vendeu em ${s.mes6 || 0} dos últimos 6 meses, ${s.ped180 || 0} pedido(s) de ${s.cli180 || 0} cliente(s) em 180 dias`
    };
  }
  // perfil automático de quem vendeu nos últimos 180 dias (para o sistema perceber quando um produto vira recorrente)
  perfisAuto() {
    const out = [];
    for (const p of this.produtos) { const s = this.stats.get(p.id); if (!s || !s.ped180) continue; const pf = this.perfil(p.id); out.push(Object.assign({ id: p.id, codigo: p.codigo, nome: p.nome, id_fornecedor: p.id_fornecedor || null, estoque: Number(p.estoque) || 0 }, pf)); }
    return out;
  }

  infoProduto(p) {
    const s = this.stats.get(p.id) || {};
    const taxa = this.taxa(p.id);
    const est = Number(p.estoque) || 0;
    const cobertura = taxa > 0 ? est / taxa : null;
    const prazo = this.prazo(p.id_fornecedor);
    return {
      id: p.id, codigo: p.codigo, nome: p.nome, embalagem: p.embalagem, qtd_embalagem: p.qtd_embalagem || null,
      marca: p.marca || null, categoria: p.categoria || null,
      estoque: est, estoque_minimo: p.estoque_minimo || null,
      custo: r2(p.custo), venda: r2(p.venda), margem_pct: p.venda ? r2(100 * (p.venda - p.custo) / p.venda) : null,
      fornecedor: this.nomeFornecedor(p.id_fornecedor), id_fornecedor: p.id_fornecedor || null,
      venda_dia: r2(taxa), venda_30d: s.q30 || 0, venda_90d: s.q90 || 0, venda_12m: s.q365 || 0,
      faturamento_12m: r2(s.fat365 || 0), curva: s.abc || null, ultima_venda: s.ult || null,
      cobertura_dias: cobertura == null ? null : Math.floor(cobertura), prazo_fornecedor: prazo,
      ...(() => { const pf = this.perfil(p.id); return { perfil: pf.perfil, perfil_origem: pf.origem, recorrencia: pf.recorrencia }; })()
    };
  }

  buscarProdutos(texto, limite = 10) {
    const q = norm(texto);
    if (!q) return [];
    const toks = q.split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of this.produtos) {
      const cod = norm(p.codigo), nome = norm(p.nome), extra = norm((p.marca || '') + ' ' + (p.categoria || '') + ' ' + (p.referencia || ''));
      let score = 0;
      if (cod && cod === q) score += 100;
      if (nome === q) score += 60;
      let hits = 0;
      for (const t of toks) {
        if (nome.includes(t)) { hits++; score += t.length >= 3 ? 10 : 4; if (new RegExp('(^|\\W)' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(nome)) score += 3; }
        else if (cod.includes(t)) { hits++; score += 8; }
        else if (extra.includes(t)) { hits++; score += 3; }
      }
      if (!hits) continue;
      score += 15 * hits / toks.length;
      if (hits < toks.length) score -= 6 * (toks.length - hits);
      const s = this.stats.get(p.id);
      if (s) score += Math.min(5, Math.log10(1 + s.q365));
      out.push([score, p]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, limite).map(([sc, p]) => Object.assign(this.infoProduto(p), { relevancia: r2(sc) }));
  }

  produtosEmRisco({ fornecedor = null, limite = 50 } = {}) {
    const lista = [];
    let encomenda = 0;
    for (const p of this.produtos) {
      const taxa = this.taxa(p.id);
      if (taxa <= 0) continue;
      if (fornecedor && !this._fornecedorBate(p.id_fornecedor, fornecedor)) continue;
      const i = this.infoProduto(p);
      const lim = i.prazo_fornecedor + this.segDias(i.prazo_fornecedor);
      let nivel = null;
      // sob encomenda: estoque zerado é normal; só alerta se foi vendido sem ter (estoque negativo)
      if (i.perfil === 'encomenda') { if (i.estoque < 0) { i.nivel = 'zerado'; i.sob_encomenda = true; i.comprar_ate = this.hoje; lista.push(i); } else encomenda++; continue; }
      if (i.estoque <= 0) nivel = 'zerado';
      else if (i.cobertura_dias < i.prazo_fornecedor) nivel = 'critico';
      else if (i.cobertura_dias < lim) nivel = 'atencao';
      if (!nivel) continue;
      i.nivel = nivel;
      i.comprar_ate = i.estoque <= 0 ? this.hoje : ymd(new Date(this.hojeD.getTime() + Math.max(0, i.cobertura_dias - i.prazo_fornecedor) * DIA));
      lista.push(i);
    }
    const peso = { zerado: 0, critico: 1, atencao: 2 }, pc = { A: 0, B: 1, C: 2 };
    lista.sort((a, b) => peso[a.nivel] - peso[b.nivel] || (pc[a.curva] ?? 3) - (pc[b.curva] ?? 3) || b.faturamento_12m - a.faturamento_12m);
    const cont = { zerado: 0, critico: 0, atencao: 0 };
    lista.forEach(i => cont[i.nivel]++);
    return { total: lista.length, por_nivel: cont, fora_sob_encomenda: encomenda, criterio_estoque: `produto de estoque = vende em ${this.cfg.reposicao.recMeses}+ dos últimos 6 meses e em ${this.cfg.reposicao.recPedidos}+ pedidos em 180 dias (ou definido por Compras); os outros são sob encomenda e só aparecem se ficarem negativos`, itens: lista.slice(0, limite) };
  }

  _fornecedorBate(id, texto) {
    if (String(id) === String(texto)) return true;
    const n = norm(this.nomeFornecedor(id)), t = norm(texto);
    return !!t && n.includes(t);
  }

  // ---------- Fornecedores ----------
  resolverFornecedor(texto) {
    const t = norm(texto); if (!t) return { fornecedor: null, alternativas: [] };
    const dig = t.replace(/\D/g, '');
    const out = [];
    for (const f of this.fornecedores) {
      const nome = norm((f.fantasia || '') + ' ' + (f.razao_social || ''));
      let sc = 0;
      if (String(f.id) === String(texto)) sc = 1000;
      else if (dig.length >= 8 && String(f.cnpj_cpf || '').replace(/\D/g, '') === dig) sc = 900;
      else if (norm(f.fantasia) === t || norm(f.razao_social) === t) sc = 500;
      else { const toks = t.split(/\s+/).filter(Boolean); const hits = toks.filter(x => nome.includes(x)).length; if (hits) sc = 100 * hits / toks.length - (toks.length - hits) * 20; }
      if (sc > 0) out.push([sc + Math.min(20, this.produtos.filter(p => p.id_fornecedor === f.id).length / 10), f]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return { fornecedor: out.length ? out[0][1] : null, alternativas: out.slice(1, 4).map(([, f]) => ({ id: f.id, nome: f.fantasia || f.razao_social })) };
  }

  listaFornecedores() {
    const por = new Map();
    const d365 = ymd(new Date(this.hojeD.getTime() - 365 * DIA));
    for (const p of this.produtos) { const k = p.id_fornecedor || 0; let g = por.get(k); if (!g) { g = { produtos: 0, estoque_valor: 0, risco: 0 }; por.set(k, g); } g.produtos++; g.estoque_valor += Math.max(0, Number(p.estoque) || 0) * (Number(p.custo) || 0); }
    const fat = new Map();
    for (const v of this.vendas) { if (v.data < d365) continue; for (const it of (v.p.itens || [])) { if (it.excluido) continue; const pr = this.prodById.get(it.id_produto); const k = pr ? (pr.id_fornecedor || 0) : 0; fat.set(k, (fat.get(k) || 0) + (Number(it.quantidade) || 0) * (Number(it.preco_liquido) || 0) * v.fator); } }
    const risco = new Map(); for (const i of this.produtosEmRisco({ limite: 5000 }).itens || []) { const k = i.id_fornecedor || 0; risco.set(k, (risco.get(k) || 0) + 1); }
    const lista = this.fornecedores.map(f => { const g = por.get(f.id) || { produtos: 0, estoque_valor: 0 }; return { id: f.id, nome: f.fantasia || f.razao_social, razao_social: f.razao_social, produtos: g.produtos, estoque_valor: r2(g.estoque_valor), vendas_12m: r2(fat.get(f.id) || 0), em_risco: risco.get(f.id) || 0, prazo: this.prazo(f.id), prazo_cadastrado: Number(this.cfg.prazos[String(f.id)]) > 0, telefone: f.celular || f.telefone || '' }; });
    lista.sort((a, b) => b.vendas_12m - a.vendas_12m || b.produtos - a.produtos);
    const sem = por.get(0);
    return { total: lista.length, sem_fornecedor: sem ? { produtos: sem.produtos, vendas_12m: r2(fat.get(0) || 0) } : null, fornecedores: lista };
  }

  // Histórico de um fornecedor: o PedidoOK não tem as compras (entradas), então o histórico é montado com
  // as vendas dos produtos dele mês a mês, os produtos que mais saem e o estoque atual. As compras e as
  // entradas detectadas ficam no sistema (pedidos de compra aprovados e aumentos de estoque entre sincronizações).
  historicoFornecedor({ texto = '', meses = 12 } = {}) {
    const rf = this.resolverFornecedor(texto);
    const f = rf.fornecedor;
    if (!f) return { encontrado: false, alternativas: rf.alternativas, dica: 'Não achei esse fornecedor. Tente parte do nome ou o CNPJ.' };
    const n = Math.min(Math.max(Number(meses) || 12, 1), 24);
    const prods = this.produtos.filter(p => p.id_fornecedor === f.id);
    const ids = new Set(prods.map(p => p.id));
    const inicio = ymd(new Date(this.hojeD.getFullYear(), this.hojeD.getMonth() - (n - 1), 1));
    const mesesM = new Map(), porProd = new Map();
    for (const v of this.vendas) {
      if (v.data < inicio) continue;
      for (const it of (v.p.itens || [])) {
        if (it.excluido || !ids.has(it.id_produto)) continue;
        const q = Number(it.quantidade) || 0, val = q * (Number(it.preco_liquido) || 0) * v.fator, cus = q * (Number(it.preco_custo) || 0);
        const mes = v.data.slice(0, 7);
        const g = mesesM.get(mes) || { mes, quantidade: 0, faturamento: 0, custo: 0, pedidos: new Set() }; g.quantidade += q; g.faturamento += val; g.custo += cus; g.pedidos.add(v.p.id); mesesM.set(mes, g);
        const h = porProd.get(it.id_produto) || { quantidade: 0, faturamento: 0, ultima: null }; h.quantidade += q; h.faturamento += val; if (!h.ultima || v.data > h.ultima) h.ultima = v.data; porProd.set(it.id_produto, h);
      }
    }
    const serie = [...mesesM.values()].sort((a, b) => a.mes < b.mes ? -1 : 1).map(g => ({ mes: g.mes, quantidade: r2(g.quantidade), faturamento: r2(g.faturamento), margem_pct: g.faturamento ? r2(100 * (g.faturamento - g.custo) / g.faturamento) : null, pedidos: g.pedidos.size }));
    const top = [...porProd.entries()].sort((a, b) => b[1].faturamento - a[1].faturamento).slice(0, 15).map(([id, h]) => { const p = this.prodById.get(id) || {}; const info = this.infoProduto(p); return { codigo: p.codigo, nome: p.nome, quantidade: r2(h.quantidade), faturamento: r2(h.faturamento), ultima_venda: h.ultima, estoque: info.estoque, cobertura_dias: info.cobertura_dias, custo: info.custo }; });
    const risco = (this.produtosEmRisco({ fornecedor: String(f.id), limite: 50 }).itens || []).map(i => ({ codigo: i.codigo, nome: i.nome, estoque: i.estoque, nivel: i.nivel, comprar_ate: i.comprar_ate }));
    const tot = serie.reduce((a, g) => ({ q: a.q + g.quantidade, f: a.f + g.faturamento }), { q: 0, f: 0 });
    return {
      encontrado: true,
      fornecedor: { id: f.id, nome: f.fantasia || f.razao_social, razao_social: f.razao_social, cnpj: f.cnpj_cpf || null, contato: f.contato || null, telefone: f.telefone || null, celular: f.celular || null, email: f.email || null, cidade: f.endereco && f.endereco.cidade ? f.endereco.cidade + (f.endereco.uf ? '/' + f.endereco.uf : '') : null },
      alternativas: rf.alternativas,
      prazo_entrega_dias: this.prazo(f.id), prazo_cadastrado: Number(this.cfg.prazos[String(f.id)]) > 0,
      produtos: prods.length, produtos_com_estoque: prods.filter(p => (Number(p.estoque) || 0) > 0).length,
      estoque_valor_custo: r2(prods.reduce((a, p) => a + Math.max(0, Number(p.estoque) || 0) * (Number(p.custo) || 0), 0)),
      periodo: { inicio, fim: this.hoje }, vendas_periodo: { quantidade: r2(tot.q), faturamento: r2(tot.f) },
      vendas_por_mes: serie, mais_vendidos: top, em_risco: risco,
      observacao: 'O PedidoOK não envia as compras feitas ao fornecedor. As compras aparecem aqui pelos pedidos de compra feitos no sistema e pelas entradas de estoque detectadas entre uma sincronização e outra.'
    };
  }

  sugestaoCompra({ fornecedor = null } = {}) {
    const grupos = new Map();
    let encomendaFora = 0;
    for (const p of this.produtos) {
      const taxa = this.taxa(p.id);
      if (taxa <= 0 && !(Number(p.estoque) < 0)) continue;
      if (fornecedor && !this._fornecedorBate(p.id_fornecedor, fornecedor)) continue;
      const i = this.infoProduto(p);
      const seg = this.segDias(i.prazo_fornecedor), alvoExtra = seg + this.cfg.cicloCompra;
      const alvoDias = i.prazo_fornecedor + alvoExtra;
      let necessario, tipo = 'estoque';
      if (i.perfil === 'encomenda') {
        // vende primeiro, compra depois: só o que já foi vendido sem estoque, nada para "formar estoque"
        if (!(i.estoque < 0)) { if (taxa > 0) encomendaFora++; continue; }
        necessario = -i.estoque; tipo = 'encomenda';
      } else {
        if (taxa <= 0) continue;
        necessario = taxa * alvoDias - Math.max(0, i.estoque);
        if (i.cobertura_dias != null && i.cobertura_dias >= i.prazo_fornecedor + seg) continue;
      }
      if (necessario <= 0) continue;
      let qtd = Math.ceil(necessario);
      const cx = Number(p.qtd_embalagem) > 1 ? Number(p.qtd_embalagem) : 1;
      if (cx > 1) qtd = Math.ceil(qtd / cx) * cx;
      const item = {
        id: i.id, codigo: i.codigo, nome: i.nome, embalagem: i.embalagem, curva: i.curva,
        estoque: i.estoque, venda_dia: i.venda_dia, cobertura_dias: i.cobertura_dias,
        quantidade: qtd, multiplo: cx, custo_unit: i.custo, valor: r2(qtd * (Number(p.custo) || 0)),
        tipo, perfil_origem: i.perfil_origem, recorrencia: i.recorrencia,
        motivo: tipo === 'encomenda'
          ? `sob encomenda: foi vendido sem estoque (${i.estoque}); comprar só o que falta, ${i.recorrencia}`
          : `vende ~${r2(taxa * 30)} ${i.embalagem || 'un'}/mês, estoque ${i.estoque}, prazo ${i.prazo_fornecedor}d + ${seg}d de segurança${this.cfg.cicloCompra ? ' + ' + this.cfg.cicloCompra + 'd de ciclo' : ''}; ${i.recorrencia}`
      };
      const k = p.id_fornecedor || 0;
      if (!grupos.has(k)) grupos.set(k, { id_fornecedor: p.id_fornecedor || null, fornecedor: this.nomeFornecedor(p.id_fornecedor), prazo: i.prazo_fornecedor, itens: [], valor: 0 });
      const g = grupos.get(k);
      g.itens.push(item); g.valor += item.valor;
    }
    const pc = { A: 0, B: 1, C: 2 };
    const lista = [...grupos.values()].map(g => {
      g.itens.sort((a, b) => (pc[a.curva] ?? 3) - (pc[b.curva] ?? 3) || b.valor - a.valor);
      g.valor = r2(g.valor); return g;
    }).sort((a, b) => (a.id_fornecedor ? 0 : 1) - (b.id_fornecedor ? 0 : 1) || b.valor - a.valor);
    return { fornecedores: lista.length, valor_total: r2(lista.reduce((a, g) => a + g.valor, 0)), sob_encomenda_fora: encomendaFora,
      criterio: this.cfg.diasSegurancaDemorado != null
        ? `estoque: venda média x (prazo do fornecedor + segurança + ${this.cfg.cicloCompra} dia(s) de ciclo); segurança de ${this.cfg.diasSegurancaDemorado} dias para fornecedor com prazo de ${this.cfg.limiteDemorado || 20} dias ou mais e de ${this.cfg.diasSeguranca} dias para os outros; sob encomenda (venda esporádica): só o que ficou negativo`
        : `estoque: venda média x (prazo + ${this.cfg.diasSeguranca + this.cfg.cicloCompra} dias); sob encomenda (venda esporádica): só o que ficou negativo`, grupos: lista };
  }

  _periodo(inicio, fim) {
    const f = fim || this.hoje;
    const i = inicio || ymd(new Date(parseD(f).getTime() - 29 * DIA));
    return [i, f];
  }

  resumoVendas({ inicio = null, fim = null, agrupar = 'total', limite = 15, incluir_orcamentos = false, base: criterio = 'emissao' } = {}) {
    const [i, f] = this._periodo(inicio, fim);
    const porFat = criterio === 'faturamento' && !incluir_orcamentos;
    const base = incluir_orcamentos ? this.orcamentos : porFat ? this.faturados : this.vendas;
    const sel = porFat ? base.filter(v => v.datafat >= i && v.datafat <= f) : base.filter(v => v.data >= i && v.data <= f);
    const tot = { pedidos: sel.length, faturamento: 0, custo: 0, frete: 0, descontos_reais: 0 };
    sel.forEach(v => { tot.faturamento += v.total; tot.custo += v.custo; tot.frete += v.frete || 0; tot.descontos_reais += v.ajuste || 0; });
    const res = {
      periodo: { inicio: i, fim: f }, tipo: incluir_orcamentos ? 'orcamentos' : porFat ? 'faturado' : 'vendido',
      criterio: incluir_orcamentos ? 'Orçamentos (status orçamento) emitidos no período.'
        : porFat ? 'FATURADO: pedidos com data de faturamento no período, de qualquer status (igual ao relatório Venda geral do PedidoOK filtrado por faturamento). Inclui pedidos emitidos antes e orçamentos marcados como faturados.'
        : 'VENDIDO: pedidos com status Pedido emitidos no período (igual ao relatório Venda geral do PedidoOK filtrado por emissão e status Pedido).',
      regra_valor: 'Valor líquido do PedidoOK: itens com desconto já aplicado + desconto/acréscimo em reais do pedido. Frete fora.',
      pedidos: tot.pedidos, faturamento: r2(tot.faturamento), frete: r2(tot.frete), descontos_em_reais_no_pedido: r2(tot.descontos_reais),
      margem_bruta: r2(tot.faturamento - tot.custo),
      margem_pct: tot.faturamento ? r2(100 * (tot.faturamento - tot.custo) / tot.faturamento) : null,
      ticket_medio: tot.pedidos ? r2(tot.faturamento / tot.pedidos) : 0
    };
    if (porFat) {
      const por = {};
      for (const v of sel) { const k = v.p.status || 'outro'; por[k] = por[k] || { pedidos: 0, valor: 0 }; por[k].pedidos++; por[k].valor += v.total; }
      res.por_status = Object.fromEntries(Object.entries(por).map(([k, x]) => [k, { pedidos: x.pedidos, valor: r2(x.valor) }]));
      res.emitidos_antes_do_periodo = (() => { const a = sel.filter(v => v.data < i); return { pedidos: a.length, valor: r2(a.reduce((s, v) => s + v.total, 0)) }; })();
    }
    if (agrupar && agrupar !== 'total') {
      const m = new Map();
      const add = (k, nome, fat, cus, qtd) => { let g = m.get(k); if (!g) { g = { chave: k, nome, pedidos: 0, quantidade: 0, faturamento: 0, custo: 0 }; m.set(k, g); } g.faturamento += fat; g.custo += cus; g.quantidade += qtd; return g; };
      for (const v of sel) {
        if (agrupar === 'produto') {
          for (const it of (v.p.itens || [])) {
            if (it.excluido) continue;
            const q = Number(it.quantidade) || 0;
            const pr = this.prodById.get(it.id_produto);
            add(it.id_produto, pr ? pr.nome : ('Produto ' + it.id_produto), q * (+it.preco_liquido || 0) * v.fator, q * (+it.preco_custo || 0), q).pedidos++;
          }
          continue;
        }
        let k, nome;
        if (agrupar === 'dia') { k = v.data; nome = v.data; }
        else if (agrupar === 'mes') { k = v.data.slice(0, 7); nome = k; }
        else if (agrupar === 'vendedor') { k = v.p.id_vendedor; nome = this.nomeVendedor(k); }
        else if (agrupar === 'cliente') { k = v.p.id_cliente; nome = this.nomeCliente(k); }
        else if (agrupar === 'fornecedor') {
          for (const it of (v.p.itens || [])) {
            if (it.excluido) continue;
            const pr = this.prodById.get(it.id_produto); const fid = pr ? pr.id_fornecedor : null;
            const q = Number(it.quantidade) || 0;
            add(fid || 0, this.nomeFornecedor(fid), q * (+it.preco_liquido || 0) * v.fator, q * (+it.preco_custo || 0), q).pedidos++;
          }
          continue;
        } else { k = 'total'; nome = 'total'; }
        add(k, nome, v.total, v.custo, 0).pedidos++;
      }
      let grupos = [...m.values()].map(g => ({ nome: g.nome, pedidos: g.pedidos, quantidade: r2(g.quantidade) || undefined, faturamento: r2(g.faturamento), margem_pct: g.faturamento ? r2(100 * (g.faturamento - g.custo) / g.faturamento) : null }));
      if (agrupar === 'dia' || agrupar === 'mes') grupos.sort((a, b) => a.nome < b.nome ? -1 : 1);
      else grupos.sort((a, b) => b.faturamento - a.faturamento);
      res.grupos_total = grupos.length;
      res.grupos = (agrupar === 'dia' || agrupar === 'mes') ? grupos.slice(-Math.max(limite, 1)) : grupos.slice(0, limite);
    }
    return res;
  }

  // Conferência com o PedidoOK: para cada mês, o VENDIDO (emissão, status pedido) e o FATURADO (data de faturamento, todos os status).
  conferenciaMeses({ meses = 6, ate = null } = {}) {
    const fim = ate || this.hoje.slice(0, 7);
    const lista = [];
    let [a, m] = fim.split('-').map(Number);
    for (let k = 0; k < Math.min(Math.max(meses, 1), 24); k++) {
      const mes = `${a}-${String(m).padStart(2, '0')}`;
      const vend = this.vendas.filter(v => v.data.slice(0, 7) === mes);
      const fat = this.faturados.filter(v => v.datafat.slice(0, 7) === mes);
      const soma = l => r2(l.reduce((s, v) => s + v.total, 0));
      lista.push({ mes, vendido: soma(vend), pedidos_vendidos: vend.length, faturado: soma(fat), pedidos_faturados: fat.length,
        orcamentos_faturados: soma(fat.filter(v => v.p.status === 'orcamento')), frete: r2(vend.reduce((s, v) => s + v.frete, 0)), descontos_em_reais: r2(vend.reduce((s, v) => s + v.ajuste, 0)) });
      m--; if (!m) { m = 12; a--; }
    }
    return { regra: 'Vendido = emitidos no mês com status Pedido. Faturado = data de faturamento no mês, todos os status. Valores líquidos como no PedidoOK (sem frete).', meses: lista };
  }

  // Acha o cliente pelo nome, código ou CNPJ. Exige que a maior parte das palavras bata: um texto que não
  // é nome de ninguém ("empresa que não existe") tem que devolver nada, e não o primeiro parecido qualquer,
  // senão o Adaptus analisaria o cliente errado.
  _buscarCliente(texto) {
    const q = norm(texto); if (!q) return [];
    const dig = q.replace(/\D/g, '');
    const toks = q.split(/\s+/).filter(Boolean);
    const fortes = toks.filter(t => t.length >= 3 && !Engine.PARADAS_NOME.has(t));
    const precisa = fortes.length ? Math.max(1, Math.ceil(fortes.length * 0.5)) : 0;
    const out = [];
    for (const c of this.clientes) {
      const nome = norm((c.fantasia || '') + ' ' + c.razao_social);
      let sc = 0;
      const exato = norm(c.codigo) === q || (dig.length >= 8 && String(c.cnpj_cpf || '').replace(/\D/g, '').includes(dig));
      if (norm(c.codigo) === q) sc += 100;
      if (dig.length >= 8 && String(c.cnpj_cpf || '').replace(/\D/g, '').includes(dig)) sc += 100;
      let hits = 0;
      toks.forEach(t => { if (nome.includes(t)) { hits++; sc += 10; } });
      if (hits === toks.length) sc += 20;
      const bateuForte = fortes.filter(t => nome.includes(t)).length;
      if (!exato && precisa && bateuForte < precisa) continue;       // parecido demais de leve: não é este cliente
      if (!exato && !precisa && !hits) continue;
      if (sc > 0) out.push([sc, c]);
    }
    return out.sort((a, b) => b[0] - a[0]).map(x => x[1]);
  }

  buscarClientes(texto, limite = 10) {
    return this._buscarCliente(texto).slice(0, limite).map(c => ({ id: c.id, codigo: c.codigo, nome: c.fantasia || c.razao_social, razao_social: c.razao_social, cnpj_cpf: c.cnpj_cpf || '', telefone: c.telefone || '', cidade: c.endereco && c.endereco.cidade || '' }));
  }

  infoCliente(texto) {
    const cands = this._buscarCliente(texto);
    if (!cands.length) return { encontrado: false, mensagem: 'Nenhum cliente encontrado com esse nome/código.',
      parecidos: this._parecidosCliente(texto),
      o_que_fazer: 'Se houver parecidos, pergunte ao usuário qual é o certo em vez de escolher sozinho.' };
    const c = cands[0];
    const parcial = this._confiancaCliente(texto, c) === 'parcial';
    const vs = this.vendas.filter(v => v.p.id_cliente === c.id).sort((a, b) => a.data < b.data ? 1 : -1);
    const d365 = ymd(new Date(this.hojeD - 365 * DIA));
    const ult12 = vs.filter(v => v.data >= d365);
    const fat12 = ult12.reduce((a, v) => a + v.total, 0), cus12 = ult12.reduce((a, v) => a + v.custo, 0);
    const prod = new Map();
    ult12.forEach(v => (v.p.itens || []).forEach(it => { if (!it.excluido) prod.set(it.id_produto, (prod.get(it.id_produto) || 0) + (+it.quantidade || 0) * (+it.preco_liquido || 0) * v.fator); }));
    const top = [...prod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, val]) => ({ produto: (this.prodById.get(id) || {}).nome || ('Produto ' + id), valor_12m: r2(val) }));
    const abertas = this._cobrancasAbertas().filter(x => x.id_cliente === c.id);
    return {
      encontrado: true, outros_parecidos: cands.slice(1, 4).map(x => x.fantasia || x.razao_social),
      ...(parcial ? { atencao_cliente: `O nome bateu só em parte com ${c.fantasia || c.razao_social}. Confirme com o usuário se é este cliente antes de aprofundar.` } : {}),
      cliente: { id: c.id, codigo: c.codigo, nome: c.fantasia || c.razao_social, razao_social: c.razao_social, cidade: c.endereco && c.endereco.cidade, telefone: c.telefone || '' },
      ultima_compra: vs[0] ? vs[0].data : null, dias_sem_comprar: vs[0] ? diasEntre(vs[0].d, this.hojeD) : null,
      pedidos_total: vs.length, pedidos_12m: ult12.length, faturamento_12m: r2(fat12),
      margem_12m_pct: fat12 ? r2(100 * (fat12 - cus12) / fat12) : null, ticket_medio_12m: ult12.length ? r2(fat12 / ult12.length) : 0,
      vendedor: vs[0] ? this.nomeVendedor(vs[0].p.id_vendedor) : null,
      produtos_mais_comprados_12m: top,
      cobrancas_em_aberto: abertas.length, valor_em_aberto: r2(abertas.reduce((a, x) => a + x.saldo, 0)),
      valor_vencido: r2(abertas.filter(x => x.vencido).reduce((a, x) => a + x.saldo, 0)),
      ultimos_pedidos: vs.slice(0, 5).map(v => ({ numero: v.p.numero, data: v.data, valor: r2(v.total), situacao: v.p.situacao }))
    };
  }

  // Para o fluxo de caixa: recebido registrado no PedidoOK desde uma data (não é extrato do banco) e títulos a vencer.
  recebiveis({ de = null } = {}) {
    const ini = de || this.hoje;
    const realizados = [], previstos = []; let vencQtd = 0, vencValor = 0, cartaoValor = 0;
    for (const c of this.titulos) {
      const valor = Number(c.valor) || 0, pago = Number(c.valor_pago) || 0;
      const pag = c.pagamento ? String(c.pagamento).slice(0, 10) : null;
      if (pag && pago > 0 && pag >= ini && pag < this.hoje) realizados.push({ data: pag, valor: pago, tipo: 'recebido (registrado no PedidoOK)', realizado: true });
      const saldo = valor - pago;
      if (saldo <= 0.01 || (pag && pago >= valor - 0.01)) continue;
      const v = String(c.vencimento || '').slice(0, 10);
      if (v < this.hoje) { vencQtd++; vencValor += saldo; continue; }
      if (/cart/i.test(c.forma_pagamento || '')) cartaoValor += saldo;
      previstos.push({ data: v, valor: saldo, tipo: 'a receber (títulos)', forma: c.forma_pagamento || '' });
    }
    return { realizados, previstos, vencidos: { titulos: vencQtd, valor: r2(vencValor) }, a_receber_em_cartao: r2(cartaoValor) };
  }

  _cobrancasAbertas() {
    const out = [];
    for (const c of this.titulos) {
      const valor = Number(c.valor) || 0, pago = Number(c.valor_pago) || 0;
      const saldo = valor - pago;
      if (saldo <= 0.01) continue;
      if (c.pagamento && pago >= valor - 0.01) continue;
      out.push({ id: c.id, id_cliente: c.id_cliente, id_pedido: c.id_pedido, vencimento: String(c.vencimento || '').slice(0, 10), saldo, vencido: String(c.vencimento || '').slice(0, 10) < this.hoje, forma: c.forma_pagamento || '' });
    }
    return out;
  }

  cobrancas({ tipo = 'vencidas', dias = 7, limite = 20 } = {}) {
    const ab = this._cobrancasAbertas();
    const lim = ymd(new Date(this.hojeD.getTime() + dias * DIA));
    let sel;
    if (tipo === 'vencidas') sel = ab.filter(x => x.vencido);
    else if (tipo === 'a_vencer') sel = ab.filter(x => !x.vencido && x.vencimento <= lim);
    else sel = ab;
    const porCli = new Map();
    sel.forEach(x => { const g = porCli.get(x.id_cliente) || { cliente: this.nomeCliente(x.id_cliente), titulos: 0, valor: 0, vencimento_mais_antigo: x.vencimento }; g.titulos++; g.valor += x.saldo; if (x.vencimento < g.vencimento_mais_antigo) g.vencimento_mais_antigo = x.vencimento; porCli.set(x.id_cliente, g); });
    const clientes = [...porCli.values()].map(g => (g.valor = r2(g.valor), g.dias_atraso = tipo === 'vencidas' ? diasEntre(parseD(g.vencimento_mais_antigo), this.hojeD) : undefined, g)).sort((a, b) => b.valor - a.valor);
    return {
      tipo, titulos: sel.length, valor_total: r2(sel.reduce((a, x) => a + x.saldo, 0)), clientes_total: clientes.length,
      total_em_aberto_geral: r2(ab.reduce((a, x) => a + x.saldo, 0)), clientes: clientes.slice(0, limite)
    };
  }

  // Orçamento que virou pedido. Regra confirmada pelo Danilo (validação de 15/11/2026): quando o orçamento vira pedido,
  // o orçamento é fechado. No PedidoOK, porém, ele costuma continuar "Pendente" depois da compra, e o cliente às vezes
  // compra em vários pedidos (ex.: orçamento 537509 virou os pedidos 538302, 538303, 538304 e 538307). O sistema reconhece:
  // pedidos da mesma empresa (mesmo CNPJ raiz), do dia do orçamento até 60 dias depois, com pelo menos 30% dos produtos.
  // Pedido feito a partir do orçamento (o PedidoOK copia os itens e a vendedora marca como excluído o que o cliente tirou,
  // ex.: orçamento 538517 -> pedido 538626) também conta, e os itens excluídos viram "retirados do pedido".
  _conversoes() {
    if (this._conv) return this._conv;
    const raiz = id => { const c = this.cliById.get(id) || {}; const d = String(c.cnpj_cpf || '').replace(/\D/g, ''); return d.length === 14 ? d.slice(0, 8) : 'id' + id; };
    const idx = new Map();
    for (const v of this.vendas) { const k = raiz(v.p.id_cliente); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(v); }
    const conv = new Map();
    for (const o of this.orcamentos) {
      const prods = new Set((o.p.itens || []).filter(i => !i.excluido).map(i => i.id_produto));
      if (!prods.size) continue;
      const lim = ymd(new Date(o.d.getTime() + 60 * DIA));
      const peds = (idx.get(raiz(o.p.id_cliente)) || []).filter(v => v.data >= o.data && v.data <= lim);
      if (!peds.length) continue;
      const fechados = new Set(), retirados = new Map(), porPed = [];
      let derivado = false;
      for (const v of peds) {
        let k = 0, kTodos = 0;
        for (const it of (v.p.itens || [])) {
          if (!prods.has(it.id_produto)) continue;
          kTodos++;
          if (it.excluido) { if (!retirados.has(it.id_produto)) retirados.set(it.id_produto, v.p.numero); } else { fechados.add(it.id_produto); k++; }
        }
        if (kTodos / prods.size >= 0.6 && k) derivado = true;
        if (k) porPed.push({ numero: v.p.numero, data: v.data, itens_do_orcamento: k, valor: r2(v.total) });
      }
      for (const id of fechados) retirados.delete(id);
      if (!fechados.size || (fechados.size / prods.size < 0.3 && !derivado)) continue;
      porPed.sort((a, b) => b.itens_do_orcamento - a.itens_do_orcamento || a.data.localeCompare(b.data));
      conv.set(o, { pedidos: porPed.slice(0, 5), itens_fechados: fechados.size, itens_orcados: prods.size, total: fechados.size / prods.size >= 0.9, feito_a_partir_do_orcamento: derivado, _fechados: fechados, _retirados: retirados });
    }
    return (this._conv = conv);
  }
  virouPedido(o) { return this._conversoes().get(o) || null; }
  _resumoConversao(c) { return c ? Object.assign({ pedidos: c.pedidos.map(x => x.numero).join(', '), itens: `${c.itens_fechados} de ${c.itens_orcados}`, completo: c.total }, c._retirados.size ? { itens_retirados_do_pedido: c._retirados.size } : {}) : null; }

  resumoOrcamentos({ inicio = null, fim = null, limite = 10 } = {}) {
    const [i, f] = this._periodo(inicio, fim);
    const sel = this.orcamentos.filter(o => o.data >= i && o.data <= f).sort((a, b) => a.data < b.data ? 1 : -1);
    const viraram = sel.filter(o => this.virouPedido(o)), sem = sel.filter(o => !this.virouPedido(o));
    const soma = l => r2(l.reduce((a, o) => a + o.total, 0));
    return {
      periodo: { inicio: i, fim: f }, orcamentos_em_aberto: sel.length, valor: soma(sel),
      viraram_pedido: { orcamentos: viraram.length, valor_orcado: soma(viraram) }, sem_pedido: { orcamentos: sem.length, valor_orcado: soma(sem) },
      observacao: 'orcamentos_em_aberto e valor: orçamentos emitidos no período com status "orçamento" no PedidoOK (igual ao relatório Venda geral). Pela regra da empresa, orçamento que virou pedido está fechado, mesmo que o PedidoOK ainda mostre "Pendente": viraram_pedido conta os que tiveram pedido da mesma empresa com pelo menos 30% dos produtos em até 60 dias; sem_pedido é o que ainda está de fato em aberto.',
      mais_recentes: sel.slice(0, limite).map(o => Object.assign({ numero: o.p.numero, data: o.data, cliente: this.nomeCliente(o.p.id_cliente), vendedor: this.nomeVendedor(o.p.id_vendedor), valor: r2(o.total) }, this.virouPedido(o) ? { virou_pedido: this._resumoConversao(this.virouPedido(o)) } : {}))
    };
  }

  clientesInativos({ dias = 60, limite = 20 } = {}) {
    const ult = new Map();
    const d365 = ymd(new Date(this.hojeD - 365 * DIA));
    for (const v of this.vendas) {
      const g = ult.get(v.p.id_cliente) || { ult: v.data, fat12: 0, pedidos12: 0 };
      if (v.data > g.ult) g.ult = v.data;
      if (v.data >= d365) { g.fat12 += v.total; g.pedidos12++; }
      ult.set(v.p.id_cliente, g);
    }
    const lista = [];
    for (const [id, g] of ult) {
      const ds = diasEntre(parseD(g.ult), this.hojeD);
      if (ds >= dias && g.fat12 > 0) lista.push({ cliente: this.nomeCliente(id), telefone: (this.cliById.get(id) || {}).telefone || '', ultima_compra: g.ult, dias_sem_comprar: ds, faturamento_12m: r2(g.fat12), pedidos_12m: g.pedidos12 });
    }
    lista.sort((a, b) => b.faturamento_12m - a.faturamento_12m);
    return { criterio: `compraram nos últimos 12 meses e estão há ${dias}+ dias sem comprar`, total: lista.length, valor_12m_em_risco: r2(lista.reduce((a, x) => a + x.faturamento_12m, 0)), clientes: lista.slice(0, limite) };
  }

  resumoHoje() {
    const h = this.hojeD;
    const mesAtual = this.hoje.slice(0, 7);
    const ini = mesAtual + '-01';
    const dAnt = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - 1, 1));
    const iniAnt = ymd(dAnt);
    const diaN = h.getUTCDate();
    const fimAntMesmoDia = ymd(new Date(Date.UTC(dAnt.getUTCFullYear(), dAnt.getUTCMonth(), Math.min(diaN, new Date(Date.UTC(dAnt.getUTCFullYear(), dAnt.getUTCMonth() + 1, 0)).getUTCDate()))));
    const ontem = ymd(new Date(h - DIA));
    const risco = this.produtosEmRisco({ limite: 8 });
    const venc = this.cobrancas({ tipo: 'vencidas', limite: 5 });
    const ina = this.clientesInativos({ dias: 45, limite: 5 });
    return {
      hoje: this.hoje, ultima_venda_registrada: this.ultimaVenda,
      vendas_hoje: this.resumoVendas({ inicio: this.hoje, fim: this.hoje }),
      vendas_ontem: this.resumoVendas({ inicio: ontem, fim: ontem }),
      mes_atual: this.resumoVendas({ inicio: ini, fim: this.hoje }),
      mes_anterior_mesmo_periodo: this.resumoVendas({ inicio: iniAnt, fim: fimAntMesmoDia }),
      orcamentos_30d: this.resumoOrcamentos({ limite: 5 }),
      risco, cobrancas_vencidas: venc, inativos: ina,
      compra: (() => { const s = this.sugestaoCompra(); return { valor_total: s.valor_total, fornecedores: s.fornecedores }; })()
    };
  }

  qualidadeDados() {
    const n = this.produtos.length || 1;
    const c = f => this.produtos.filter(f).length;
    const vendidos = this.produtos.filter(p => (this.stats.get(p.id) || {}).q365 > 0);
    const topA = vendidos.filter(p => (this.stats.get(p.id) || {}).abc === 'A');
    return {
      produtos: this.produtos.length, produtos_com_venda_12m: vendidos.length, curva_A: topA.length,
      com_fornecedor_pct: Math.round(100 * c(p => p.id_fornecedor) / n),
      curva_A_sem_fornecedor: topA.filter(p => !p.id_fornecedor).length,
      com_estoque_minimo_pct: Math.round(100 * c(p => p.estoque_minimo > 0) / n),
      com_qtd_caixa_pct: Math.round(100 * c(p => p.qtd_embalagem > 1) / n),
      vendidos_12m_com_estoque_zero: vendidos.filter(p => !(p.estoque > 0)).length,
      pedidos: this.vendas.length, orcamentos: this.orcamentos.length, clientes: this.clientes.length,
      primeira_venda: this.vendas.reduce((a, v) => !a || v.data < a ? v.data : a, null), ultima_venda: this.ultimaVenda
    };
  }

  // ---------- orçamento automático ----------
  // Cliente pelo nome/código/CNPJ, com pontuação para saber se a escolha é segura.
  resolverCliente(texto) {
    const q = norm(texto); if (!q) return { cliente: null, alternativas: [], certeza: 'nenhuma' };
    const dig = q.replace(/\D/g, '');
    const toks = q.split(/\s+/).filter(t => t.length > 1 && !['ltda', 'me', 'eireli', 'de', 'da', 'do', 'e'].includes(t));
    const out = [];
    for (const c of this.clientes) {
      const fant = norm(c.fantasia), raz = norm(c.razao_social), nome = fant + ' ' + raz;
      let sc = 0;
      if (norm(c.codigo) === q) sc += 100;
      if (dig.length >= 8 && String(c.cnpj_cpf || '').replace(/\D/g, '').includes(dig)) sc += 100;
      if (fant === q || raz === q) sc += 60;
      let hits = 0;
      toks.forEach(t => { if (new RegExp('(^|\\W)' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(nome)) { hits++; sc += 12; } else if (nome.includes(t)) { hits++; sc += 6; } });
      if (toks.length && hits === toks.length) sc += 20;
      if (!sc) continue;
      const vs = this._comprasPorCliente().get(c.id);
      if (vs) sc += Math.min(6, vs.length / 5);           // desempate: cliente que compra mais
      out.push([sc, c]);
    }
    out.sort((a, b) => b[0] - a[0]);
    const fmt = c => ({ id: c.id, codigo: c.codigo, nome: c.fantasia || c.razao_social, razao_social: c.razao_social, cnpj_cpf: c.cnpj_cpf || '', telefone: c.telefone || '', cidade: c.endereco && c.endereco.cidade || '' });
    if (!out.length) return { cliente: null, alternativas: [], certeza: 'nenhuma' };
    const [a, b] = out;
    const certeza = a[0] >= 60 && (!b || a[0] - b[0] >= 15) ? 'alta' : (!b || a[0] - b[0] >= 8 ? 'media' : 'baixa');
    return { cliente: fmt(a[1]), alternativas: out.slice(1, 6).map(x => fmt(x[1])), certeza };
  }

  _comprasPorCliente() {
    if (!this._cpc) {
      this._cpc = new Map();
      for (const v of this.vendas) { const id = v.p.id_cliente; if (!this._cpc.has(id)) this._cpc.set(id, []); this._cpc.get(id).push(v); }
      for (const arr of this._cpc.values()) arr.sort((x, y) => x.data < y.data ? 1 : -1);
    }
    return this._cpc;
  }

  _orcamentosPorCliente() {
    if (!this._opc) {
      this._opc = new Map();
      for (const v of this.orcamentos) { const id = v.p.id_cliente; if (!this._opc.has(id)) this._opc.set(id, []); this._opc.get(id).push(v); }
      for (const arr of this._opc.values()) arr.sort((x, y) => x.data < y.data ? 1 : -1);
    }
    return this._opc;
  }

  // O que o cliente costuma comprar: produto -> vezes, último preço, última quantidade.
  historicoCliente(idCliente, dias = 540) {
    const vs = this._comprasPorCliente().get(idCliente) || [];
    const lim = ymd(new Date(this.hojeD - dias * DIA));
    const prod = new Map();
    for (const v of vs) {
      if (v.data < lim) break;
      for (const it of (v.p.itens || [])) {
        if (it.excluido) continue;
        let h = prod.get(it.id_produto);
        if (!h) { h = { vezes: 0, qtd_total: 0, ultima_data: v.data, ultimo_preco: r2(it.preco_liquido), ultima_qtd: Number(it.quantidade) || 0, embalagem: it.embalagem || null }; prod.set(it.id_produto, h); }
        h.vezes++; h.qtd_total += Number(it.quantidade) || 0;
      }
    }
    // orçamentos do cliente também mostram o que ele costuma pedir (sem usar o preço)
    const orcs = this._orcamentosPorCliente().get(idCliente) || [];
    for (const o of orcs) {
      if (o.data < lim) break;
      for (const it of (o.p.itens || [])) {
        if (it.excluido) continue;
        let h = prod.get(it.id_produto);
        if (!h) { h = { vezes: 0, qtd_total: 0, ultima_data: null, ultimo_preco: null, ultima_qtd: Number(it.quantidade) || 0, embalagem: it.embalagem || null, orcado: 0 }; prod.set(it.id_produto, h); }
        h.orcado = (h.orcado || 0) + 1;
      }
    }
    const ult = vs[0] ? vs[0].p : null;
    return { produtos: prod, ultimoPedido: ult, pedidos: vs.length };
  }

  // Padrões do cliente para preencher o orçamento sozinho (vendedor, condição e forma de pagamento).
  padroesCliente(idCliente) {
    const h = this.historicoCliente(idCliente);
    const ult = h.ultimoPedido || {};
    const out = { vendedor: null, condicao: null, forma: null };
    if (ult.id_vendedor != null) out.vendedor = this.nomeVendedor(ult.id_vendedor);
    // condição: id da condição no pedido -> prazos
    const idCond = Object.entries(ult).find(([k, v]) => /condic/i.test(k) && /^id|_id$/i.test(k) && v != null);
    if (idCond) {
      const c = this.condicoes.find(x => String(x.id) === String(idCond[1]));
      if (c) out.condicao = c.descricao || c.nome || ((c.prazos || []).length && !(c.prazos.length === 1 && +c.prazos[0] === 0) ? c.prazos.join('/') + ' dias' : 'À vista');
    }
    if (!out.condicao && Array.isArray(ult.condicao_pagamento) && ult.condicao_pagamento.length) {
      const pz = ult.condicao_pagamento.map(Number).filter(n => !isNaN(n));
      out.condicao = pz.length === 1 && pz[0] === 0 ? 'À vista' : pz.join('/') + ' dias';
    }
    if (!out.condicao) { const t = Object.entries(ult).find(([k, v]) => /condic/i.test(k) && typeof v === 'string' && v.trim()); if (t) out.condicao = t[1].trim(); }
    const fp = Object.entries(ult).find(([k, v]) => /forma/i.test(k) && typeof v === 'string' && v.trim());
    if (fp) out.forma = fp[1].trim();
    if (!out.forma) {
      const tits = this.titulos.filter(t => t.id_cliente === idCliente && t.forma_pagamento).sort((a, b) => String(a.vencimento) < String(b.vencimento) ? 1 : -1);
      if (tits[0]) out.forma = String(tits[0].forma_pagamento);
    }
    return out;
  }

  // Medidas (5 litros = 5L = 5000ml) e tamanhos (P, M, G) para não trocar 5L por 500ml nem luva P por G.
  // Parecidos para sugerir quando a busca não acha: tolera erro de digitação comparando o começo das palavras.
  _parecidos(lista, nomeDe, texto, n = 5) {
    const pref = norm(texto).split(/\s+/).filter(t => t.length >= 4 && !Engine.PARADAS_NOME.has(t)).map(t => t.slice(0, 4));
    if (!pref.length) return [];
    const out = [];
    for (const x of lista) {
      const ws = norm(nomeDe(x)).split(/\s+/);
      const sc = pref.filter(p => ws.some(w => w.startsWith(p))).length;
      if (sc) out.push([sc, x]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, n).map(([, x]) => x);
  }
  // a palavra-chave bateu só em parte do nome? então o Adaptus confirma com a pessoa antes de analisar
  _confiancaCliente(texto, c) {
    const q = norm(texto), dig = q.replace(/\D/g, '');
    if (norm(c.codigo) === q || (dig.length >= 8 && String(c.cnpj_cpf || '').replace(/\D/g, '').includes(dig))) return 'exata';
    const nome = norm((c.fantasia || '') + ' ' + c.razao_social);
    const fortes = q.split(/\s+/).filter(t => t.length >= 3 && !Engine.PARADAS_NOME.has(t));
    return fortes.every(t => nome.includes(t)) ? 'exata' : 'parcial';
  }
  _parecidosCliente(texto) {
    const diretos = this.buscarClientes(texto, 5);
    const lista = diretos.length ? diretos : this._parecidos(this.clientes, c => (c.fantasia || '') + ' ' + c.razao_social, texto).map(c => ({ nome: c.fantasia || c.razao_social, codigo: c.codigo, cidade: c.endereco && c.endereco.cidade }));
    return lista.map(c => ({ nome: c.nome, codigo: c.codigo, cidade: c.cidade }));
  }
  _parecidosProduto(texto) {
    return this._parecidos(this.produtos, p => p.nome, texto).map(p => ({ codigo: p.codigo, nome: p.nome, estoque: Number(p.estoque) || 0 }));
  }

  // palavras que não identificam um cliente sozinhas
  static get PARADAS_NOME() { return new Set(['ltda', 'eireli', 'epp', 'cia', 'empresa', 'cliente', 'comercio', 'servicos', 'servico', 'industria', 'distribuidora', 'representacoes', 'que', 'nao', 'sim', 'com', 'sem', 'para', 'por', 'dos', 'das', 'uma', 'uns', 'existe', 'aqui', 'esse', 'essa', 'este', 'esta', 'qual', 'nome']); }

  static medidas(txt) {
    const t = norm(txt).replace(/,/g, '.');
    const out = { vol: [], peso: [], tam: [], comp: [] };
    const re = /(\d+(?:\.\d+)?)\s*(ml|mls|litros?|lts?|l|kg|kgs|quilos?|gr|g|grs|gramas?)(?![a-z])/g;
    let m;
    while ((m = re.exec(t))) {
      const n = parseFloat(m[1]), u = m[2];
      if (/^ml/.test(u)) out.vol.push(n); else if (/^(l|lt|lts|litro|litros)$/.test(u)) out.vol.push(n * 1000);
      else if (/^(kg|kgs|quilo|quilos)$/.test(u)) out.peso.push(n * 1000); else out.peso.push(n);
    }
    // comprimento (rodo 35cm, disco 510mm, mangueira 15 metros), em mm; "30x30cm" vale pelo número junto da unidade
    const rc = /(\d+(?:\.\d+)?)\s*(cm|mm|metros?|mts?)(?![a-z])/g;
    while ((m = rc.exec(t))) { const n = parseFloat(m[1]), u = m[2]; out.comp.push(u === 'mm' ? n : u === 'cm' ? n * 10 : n * 1000); }
    const tm = t.match(/(?:^|\s)(?:tam\.?|tamanho)?\s*(pp|p|m|g|gg|xg|xgg|eg)(?=\s|$)/g);
    if (tm) tm.forEach(x => out.tam.push(x.trim().replace(/^(tam\.?|tamanho)\s*/, '')));
    return out;
  }

  // Candidatos para cada linha do pedido, priorizando o que o cliente já compra.
  candidatosOrcamento(itens, idCliente = null, limite = 8) {
    const hist = idCliente != null ? this.historicoCliente(idCliente).produtos : new Map();
    return (itens || []).map(it => {
      const desc = String(it.descricao || '').trim();
      const mapa = new Map();
      const add = (p, bonus) => { const atual = mapa.get(p.id); const sc = (p.relevancia || 0) + bonus; if (!atual || atual.sc < sc) mapa.set(p.id, Object.assign({}, p, { sc })); };
      if (it.codigo) this.buscarProdutos(String(it.codigo), 5).filter(c => norm(c.codigo) === norm(it.codigo)).forEach(c => add(c, 200));
      this.buscarProdutos(desc, 15).forEach(c => add(c, 0));
      // mesma busca escrevendo a medida como no cadastro (5 litros -> 5L, 500 ml -> 500ML) e o tamanho como "TAM M"
      const descCad = norm(desc).replace(/(\d+(?:[.,]\d+)?)\s*(litros?|lts?)(?![a-z])/g, '$1l').replace(/(\d+)\s+(ml|kg|g)(?![a-z])/g, '$1$2');
      if (descCad !== norm(desc)) this.buscarProdutos(descCad, 15).forEach(c => add(c, 0));
      const medPed = Engine.medidas(desc);
      if (medPed.tam.length) this.buscarProdutos(descCad.replace(/(?:^|\s)(pp|p|m|g|gg|xg)(?=\s|$)/, ' tam $1'), 15).forEach(c => add(c, 0));
      // palavras mais fortes da descrição: tenta também sem números/medidas para não perder o produto que o cliente compra
      const semMedidas = desc.replace(/\b\d+[.,]?\d*\s*(ml|l|lt|litros?|kg|g|gr|un|m|cm|mm)\b/gi, ' ').replace(/\s+/g, ' ').trim();
      if (semMedidas && semMedidas !== desc) this.buscarProdutos(semMedidas, 10).forEach(c => add(c, -3));
      // aderência: quantas palavras importantes do pedido aparecem no nome; tipo_ok: a 1ª palavra (o tipo do produto) aparece
      const PARADAS = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'para', 'pra', 'e', 'cx', 'caixa', 'caixas', 'fardo', 'fardos', 'pct', 'pacote', 'pacotes', 'un', 'und', 'unid', 'unidades', 'gl', 'galao', 'galoes', 'rolo', 'rolos', 'kit']);
      // a 1ª palavra pode ser curta e ainda ser o tipo do produto ("pá de lixo"); palavra curta só bate inteira
      const toks = norm(desc).split(/[^a-z0-9]+/).filter(Boolean);
      const sig = toks.filter((t, i) => (t.length >= 3 || (i === 0 && t.length === 2 && /^[a-z]+$/.test(t))) && !PARADAS.has(t) && !/^\d+$/.test(t));
      const dobra = x => x.replace(/([a-z])\1+/g, '$1');   // aerossol = aerosol, alcool = alcol
      const casa = (t, nome) => { const td = dobra(t); return nome.split(/[^a-z0-9]+/).some(w0 => { const w = dobra(w0); return td.length <= 2 ? w === td : (w.startsWith(td.slice(0, Math.max(4, Math.min(td.length, 6)))) || (td.length >= 4 && td.startsWith(w) && w.length >= 4)); }); };
      const cands = [...mapa.values()].map(c => {
        const h = hist.get(c.id);
        const nome = norm(c.nome + ' ' + (c.marca || ''));
        const hits = sig.filter(t => casa(t, nome)).length;
        const aderencia = sig.length ? hits / sig.length : 0;
        const tipo_ok = sig.length ? casa(sig[0], nome) : false;
        // medida e tamanho: igual soma, diferente tira
        const mc = Engine.medidas(c.nome);
        let medida_bate = null;
        const comparar = (a, b) => { if (!a.length) return; if (!b.length) { if (medida_bate === null) medida_bate = 'sem medida no cadastro'; return; } const ok = a.some(x => b.some(y => Math.abs(x - y) < 0.001 || x === y)); medida_bate = ok ? (medida_bate === false ? false : true) : false; };
        comparar(medPed.vol, mc.vol); comparar(medPed.peso, mc.peso); comparar(medPed.comp, mc.comp);
        if (medPed.tam.length) { if (!mc.tam.length) { if (medida_bate === null) medida_bate = 'sem tamanho no cadastro'; } else medida_bate = medPed.tam.some(x => mc.tam.includes(x)) ? (medida_bate === false ? false : true) : false; }
        const bonusMed = medida_bate === true ? 30 : medida_bate === false ? -45 : (typeof medida_bate === 'string' ? -5 : 0);
        const comprou = h && h.vezes > 0;
        // histórico do cliente (regra do Danilo: sem marca no pedido, oferecer o que o cliente já usa), mas só vale cheio
        // quando o produto é mesmo o que foi pedido: "cabo euro" não vira o cabo de alumínio só porque ele já comprou
        const fH = aderencia >= 0.99 ? 1 : aderencia >= 0.6 ? 0.5 : 0.2;
        // quem compra mais vezes e mais recente pesa mais (o cliente pode ter trocado de marca há pouco)
        const diasUlt = comprou && h.ultima_data ? Math.round((this.hojeD - parseD(h.ultima_data)) / DIA) : null;
        const recencia = diasUlt == null ? 0 : diasUlt <= 30 ? 15 : diasUlt <= 60 ? 10 : diasUlt <= 120 ? 5 : 0;
        const bonusHist = ((comprou ? 25 + Math.min(18, h.vezes * 3) + recencia : 0) + (h && h.orcado ? Math.min(12, 6 + h.orcado * 2) : 0)) * fH;
        // desempate quando o cliente nunca comprou: o que a empresa mais vende
        const taxaP = this.taxa(c.id), bonusGiro = tipo_ok && taxaP > 0 ? Math.min(8, Math.log10(1 + taxaP * 30) * 3) : 0;
        const bonus = bonusHist + bonusGiro + aderencia * 20 + (tipo_ok ? 10 : -15) + bonusMed;
        return Object.assign(c, { sc: c.sc + bonus, aderencia: r2(aderencia), tipo_ok, medida_bate, cliente_orcou: h && h.orcado ? h.orcado : 0, cliente_compra: comprou ? { vezes: h.vezes, ultima_data: h.ultima_data, ultimo_preco: h.ultimo_preco, ultima_qtd: h.ultima_qtd } : null });
      }).filter(c => c.sc >= 200 || c.aderencia > 0).sort((a, b) => b.sc - a.sc).slice(0, limite);
      return { descricao: desc, codigo: it.codigo || null, quantidade: Number(it.quantidade) || 1, unidade: it.unidade || null, preco_informado: it.preco_unitario == null || it.preco_unitario === '' ? null : Number(it.preco_unitario), candidatos: cands };
    });
  }


  // ---------- consultas detalhadas (para o agente ir atrás da resposta) ----------
  // Itens do pedido: todos (sem corte), em linhas compactas "código | produto | qtd emb | preço | total" para caber pedidos grandes.
  _linhaItem(i) { const pr = this.prodById.get(i.id_produto) || {}; const q = Number(i.quantidade) || 0; return `${pr.codigo || '-'} | ${pr.nome || ('Produto ' + i.id_produto)} | ${q} ${i.embalagem || pr.embalagem || ''} | ${r2(i.preco_liquido)} | ${r2(q * (Number(i.preco_liquido) || 0))}`; }
  _resumoItens(p, max = 500) {
    const its = (p.itens || []).filter(i => !i.excluido);
    return Object.assign({ itens_total: its.length, itens_formato: 'código | produto | quantidade e embalagem | preço unitário líquido | total', itens: its.slice(0, max).map(i => this._linhaItem(i)) }, its.length > max ? { aviso_itens: `Mostrando ${max} de ${its.length} itens. Para achar um produto neste pedido, use também o filtro produto.` } : {});
  }
  // Produtos que batem com o texto: todas as variações (Baygon 300ml, 395ml, aerossol...), não só a primeira
  _produtosQueBatem(texto) {
    const q = norm(texto); if (!q) return [];
    const cod = this.produtos.filter(p => norm(p.codigo) === q);
    if (cod.length) return cod;
    const toks = q.split(/\s+/).filter(t => t.length >= 2);
    const todos = this.produtos.filter(p => { const n = norm(p.nome + ' ' + (p.marca || '') + ' ' + (p.codigo || '')); return toks.every(t => n.includes(t)); });
    if (todos.length) return todos.slice(0, 60);
    const ps = this.buscarProdutos(texto, 5);
    return ps.length ? [this.prodById.get(ps[0].id)].filter(Boolean) : [];
  }

  // Clientes da mesma empresa (mesma raiz de CNPJ: os 8 primeiros dígitos), ex.: matriz e filial com cadastros separados.
  _mesmaEmpresa(c) {
    const d = String(c.cnpj_cpf || '').replace(/\D/g, '');
    if (d.length !== 14) return [c];
    const raiz = d.slice(0, 8);
    return this.clientes.filter(x => String(x.cnpj_cpf || '').replace(/\D/g, '').slice(0, 8) === raiz && String(x.cnpj_cpf || '').replace(/\D/g, '').length === 14);
  }

  // O que o cliente orçou e não fechou, o que ele compra, o que deixou de comprar, alternativas do catálogo
  // e o que outros clientes que compram as mesmas coisas também levam. Tudo numa consulta, sem abrir pedido por pedido.
  oportunidadesCliente({ texto, meses = 6, unidades = 'todas' } = {}) {
    const cands = this._buscarCliente(texto);
    if (!cands.length) return { encontrado: false, mensagem: `Nenhum cliente com esse nome, código ou CNPJ ("${String(texto).slice(0, 60)}").`,
      parecidos: this._parecidosCliente(texto),
      o_que_fazer: 'Pergunte ao usuário de qual cliente se trata, mostrando os parecidos (nome, código e cidade). Não analise outro cliente por conta própria.' };
    const c = cands[0];
    const raiz = x => { const d = String(x.cnpj_cpf || '').replace(/\D/g, ''); return d.length === 14 ? d.slice(0, 8) : 'id' + x.id; };
    const outrasEmpresas = []; const vistas = new Set([raiz(c)]);
    for (const x of cands.slice(1, 12)) { if (vistas.has(raiz(x))) continue; vistas.add(raiz(x)); outrasEmpresas.push({ nome: x.fantasia || x.razao_social, codigo: x.codigo, cidade: x.endereco && x.endereco.cidade }); if (outrasEmpresas.length >= 4) break; }
    const grupo = unidades === 'so_esta' ? [c] : this._mesmaEmpresa(c);
    const ids = new Set(grupo.map(x => x.id));
    const ini = ymd(new Date(this.hojeD - Math.min(Math.max(meses, 1), 24) * 30 * DIA));
    const ini12 = ymd(new Date(this.hojeD - 365 * DIA));
    const FECHADO = /faturad|pago|conclu|entreg/i;
    const orcs = this.orcamentos.filter(o => ids.has(o.p.id_cliente) && o.data >= ini);
    const doPeriodo = orcs.filter(o => !FECHADO.test(o.p.situacao || ''));          // base da análise item a item
    const viraram = doPeriodo.filter(o => this.virouPedido(o));                       // fechados pela regra: viraram pedido
    const abertos = doPeriodo.filter(o => !this.virouPedido(o));                      // de fato em aberto
    const faturados = orcs.filter(o => FECHADO.test(o.p.situacao || ''));
    const vend12 = this.vendas.filter(v => ids.has(v.p.id_cliente) && v.data >= ini12);
    const vendPer = vend12.filter(v => v.data >= ini);
    // o que ele compra (12 meses), por produto
    const compra = new Map();
    for (const v of vend12) for (const it of (v.p.itens || [])) {
      if (it.excluido) continue;
      const q = Number(it.quantidade) || 0, val = q * (Number(it.preco_liquido) || 0) * v.fator;
      const x = compra.get(it.id_produto) || { qtd: 0, valor: 0, ultima: null, preco: null, pedidos: 0, recente: 0 };
      x.qtd += q; x.valor += val; x.pedidos++;
      if (!x.ultima || v.data > x.ultima) { x.ultima = v.data; x.preco = r2(Number(it.preco_liquido) * v.fator); }
      if (diasEntre(v.d, this.hojeD) <= 90) x.recente += q;
      compra.set(it.id_produto, x);
    }
    // o que ele orçou e não fechou, por produto
    const orc = new Map();
    for (const o of doPeriodo) for (const it of (o.p.itens || [])) {
      if (it.excluido) continue;
      const q = Number(it.quantidade) || 0, preco = r2((Number(it.preco_liquido) || 0) * o.fator);
      const x = orc.get(it.id_produto) || { vezes: 0, qtd: 0, valor: 0, orcamentos: [] };
      x.vezes++; x.qtd += q; x.valor += q * preco;
      x.orcamentos.push({ numero: o.p.numero, data: o.data, qtd: q, preco });
      orc.set(it.id_produto, x);
    }
    const info = id => { const p = this.prodById.get(id); return p ? this.infoProduto(p) : { nome: (this.nomesProdutos.get(id) || ('Produto ' + id)) + ' (inativo no cadastro)', estoque: null }; };
    const palavras = nome => norm(nome).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(w => w.length >= 3 && !/^\d/.test(w) && !/^(com|para|pct|cx|und|unid|fardo|pacote|caixa|lt|ml|kg|gr)$/.test(w));
    // alternativas: mesmo tipo de produto (palavras principais), mesma medida quando houver e preço na mesma faixa
    // (preço muito diferente quase sempre é outra embalagem: pacote x caixa)
    const alternativas = (id, precoRef) => {
      const p = this.prodById.get(id); if (!p) return [];
      const w = palavras(p.nome).slice(0, 2); if (!w.length) return [];
      const mp = Engine.medidas(p.nome);
      const bate = (a, b) => !a.length || (b.length > 0 && a.some(x => b.some(y => Math.abs(x - y) < 0.001)));
      const ref = precoRef || Number(p.venda) || 0;
      return this.produtos.filter(x => x.id !== id && (Number(x.estoque) || 0) > 0 && norm(x.nome).startsWith(w[0]) && w.every(t => norm(x.nome).includes(t)))
        .map(x => { const m = Engine.medidas(x.nome); const i = this.infoProduto(x); return { codigo: i.codigo, nome: i.nome, estoque: i.estoque, preco: i.venda, custo: i.custo, margem_pct: i.margem_pct, vende_90d: i.venda_90d,
          mesma_medida: bate(mp.vol, m.vol) && bate(mp.peso, m.peso) && (!mp.tam.length || mp.tam.some(t => m.tam.includes(t))), diferenca_preco_pct: ref ? r2(100 * (i.venda - ref) / ref) : null }; })
        .filter(a => a.mesma_medida && (!ref || (a.preco >= ref * 0.5 && a.preco <= ref * 1.5)))
        .sort((a, b) => (b.vende_90d > 0) - (a.vende_90d > 0) || (a.preco || 0) - (b.preco || 0)).slice(0, 3).map(({ mesma_medida, ...a }) => a);
    };
    const retiradosDe = new Map();   // produto -> pedido de onde o cliente tirou o item
    for (const o of viraram) for (const [id, num] of this.virouPedido(o)._retirados) if (!retiradosDe.has(id) || Number(num) > Number(retiradosDe.get(id))) retiradosDe.set(id, num);   // o pedido mais recente
    const naoFechados = [...orc.entries()].map(([id, x]) => {
      const i = info(id) || { nome: 'Produto ' + id };
      const cp = compra.get(id);
      const ult = x.orcamentos.sort((a, b) => b.data.localeCompare(a.data))[0];
      const comprouDepois = cp && cp.ultima >= ult.data;
      const sit = !cp ? 'orçou e não comprou em 12 meses' : comprouDepois ? 'orçou e comprou depois (talvez em outro pedido)' : 'já comprou antes, mas não fechou o último orçamento';
      return { codigo: i.codigo, produto: i.nome, situacao: sit, ...(retiradosDe.has(id) && !comprouDepois ? { retirado_do_pedido: retiradosDe.get(id) } : {}), vezes_orcado: x.vezes, qtd_orcada: r2(x.qtd), valor_orcado: r2(x.valor), ultimo_orcamento: ult,
        preco_orcado: ult.preco, preco_tabela: i.venda, custo: i.custo, margem_pct: i.margem_pct, estoque: i.estoque, comprou_12m: cp ? { qtd: r2(cp.qtd), ultima: cp.ultima, preco: cp.preco } : null,
        _sem: !comprouDepois, _id: id };
    }).sort((a, b) => b._sem - a._sem || b.valor_orcado - a.valor_orcado);
    for (const n of naoFechados.slice(0, 12)) if (n._sem) n.alternativas = alternativas(n._id, n.preco_orcado);
    // deixou de comprar: comprou nos 12 meses, mas nada nos últimos 90 dias
    const deixou = [...compra.entries()].filter(([, x]) => x.recente === 0 && x.pedidos >= 2).sort((a, b) => b[1].valor - a[1].valor).slice(0, 10)
      .map(([id, x]) => { const i = info(id) || { nome: 'Produto ' + id }; return { codigo: i.codigo, produto: i.nome, comprou_12m: r2(x.qtd), valor_12m: r2(x.valor), ultima_compra: x.ultima, pedidos: x.pedidos, estoque: i.estoque }; });
    // quem compra o mesmo que ele também leva... (só o que ele não compra nem orçou, com estoque)
    const top = [...compra.entries()].sort((a, b) => b[1].valor - a[1].valor).slice(0, 6).map(([id]) => id);
    const topSet = new Set(top), conta = new Map();
    if (top.length) for (const v of this.vendas) {
      if (v.data < ini12 || ids.has(v.p.id_cliente)) continue;
      const its = (v.p.itens || []).filter(i => !i.excluido);
      if (!its.some(i => topSet.has(i.id_produto))) continue;
      const vistos = new Set();
      for (const i of its) { if (topSet.has(i.id_produto) || compra.has(i.id_produto) || orc.has(i.id_produto) || vistos.has(i.id_produto)) continue; vistos.add(i.id_produto); const x = conta.get(i.id_produto) || { clientes: new Set(), pedidos: 0 }; x.clientes.add(v.p.id_cliente); x.pedidos++; conta.set(i.id_produto, x); }
    }
    const junto = [...conta.entries()].filter(([id, x]) => x.clientes.size >= 3 && (Number((this.prodById.get(id) || {}).estoque) || 0) > 0).sort((a, b) => b[1].clientes.size - a[1].clientes.size).slice(0, 8)
      .map(([id, x]) => { const i = info(id); return { codigo: i.codigo, produto: i.nome, clientes_que_levam: x.clientes.size, estoque: i.estoque, preco: i.venda }; });
    const mais = top.map(id => { const i = info(id) || { nome: 'Produto ' + id }; const x = compra.get(id); return { codigo: i.codigo, produto: i.nome, qtd_12m: r2(x.qtd), valor_12m: r2(x.valor), ultima_compra: x.ultima, ultimo_preco: x.preco }; });
    return {
      encontrado: true,
      cliente: { nome: c.fantasia || c.razao_social, codigo: c.codigo, cnpj: c.cnpj_cpf },
      unidades: grupo.map(x => ({ nome: x.fantasia || x.razao_social, codigo: x.codigo, cnpj: x.cnpj_cpf, cidade: x.endereco && x.endereco.cidade })),
      ...(grupo.length > 1 ? { observacao_unidades: `Somei as ${grupo.length} unidades com o mesmo CNPJ raiz. Para ver só uma, use unidades="so_esta" com o código dela.` } : {}),
      ...(outrasEmpresas.length ? { outras_empresas_parecidas: outrasEmpresas } : {}),
      ...(this._confiancaCliente(texto, c) === 'parcial'
        ? { atencao_cliente: `O nome "${String(texto).slice(0, 60)}" bateu só em parte com ${c.fantasia || c.razao_social}. Antes de aprofundar, confirme com o usuário se é este cliente${outrasEmpresas.length ? ' ou um dos parecidos' : ''}.` }
        : outrasEmpresas.length ? { atencao_cliente: 'Há outras empresas (CNPJ diferente) com nome parecido. Se não tiver certeza de que é este cliente, pergunte ao usuário mostrando as opções.' } : {}),
      periodo_orcamentos: { inicio: ini, fim: this.hoje },
      resumo: {
        orcamentos_em_aberto: abertos.length, valor_em_aberto: r2(abertos.reduce((a, o) => a + o.total, 0)),
        orcamentos_que_viraram_pedido: viraram.length, valor_dos_que_viraram_pedido: r2(viraram.reduce((a, o) => a + o.total, 0)),
        orcamentos_faturados_como_orcamento: faturados.length,
        pedidos_no_periodo: vendPer.length, comprado_no_periodo: r2(vendPer.reduce((a, v) => a + v.total, 0)),
        pedidos_12m: vend12.length, comprado_12m: r2(vend12.reduce((a, v) => a + v.total, 0)),
        ultima_compra: vend12.length ? vend12.map(v => v.data).sort().pop() : null,
        produtos_orcados_sem_fechar: naoFechados.filter(n => n._sem).length
      },
      orcamentos_em_aberto: abertos.sort((a, b) => b.data.localeCompare(a.data)).slice(0, 15).map(o => ({ numero: o.p.numero, data: o.data, valor: r2(o.total), itens: (o.p.itens || []).filter(i => !i.excluido).length, vendedor: this.nomeVendedor(o.p.id_vendedor) })),
      ...(viraram.length ? { orcamentos_que_viraram_pedido: viraram.sort((a, b) => b.data.localeCompare(a.data)).slice(0, 10).map(o => { const c = this.virouPedido(o); return Object.assign({ numero: o.p.numero, data: o.data, valor_orcado: r2(o.total), pedidos: c.pedidos.map(x => x.numero).join(', '), itens_fechados: `${c.itens_fechados} de ${c.itens_orcados}`, completo: c.total }, c._retirados.size ? { itens_que_o_cliente_tirou_do_pedido: c._retirados.size } : {}); }),
        regra_orcamento_fechado: 'Orçamento que virou pedido está fechado (regra da empresa), mesmo que o PedidoOK ainda mostre Pendente. Os itens dele que o cliente não levou aparecem em orcado_sem_fechar (retirado_do_pedido = o cliente tirou do pedido): é a venda a recuperar.' } : {}),
      orcado_sem_fechar: naoFechados.slice(0, 25).map(({ _sem, _id, ...r }) => r),
      ...(naoFechados.length > 25 ? { aviso_orcado: `Mostrando 25 de ${naoFechados.length} produtos orçados.` } : {}),
      mais_comprados_12m: mais,
      deixou_de_comprar: deixou,
      clientes_parecidos_tambem_levam: junto,
      criterio: `Orçamentos com status orçamento e situação diferente de faturado/pago/concluído, de ${ini} até hoje; compras = pedidos dos últimos 12 meses. Alternativas: produtos do catálogo com as mesmas palavras principais no nome e estoque disponível (confira se servem). "Clientes parecidos" = outros clientes que compraram os principais produtos deste cliente nos últimos 12 meses.`
    };
  }

  // Visão da carteira inteira: o que os clientes orçam e não fecham. Um item de orçamento conta como fechado
  // se o mesmo cliente (ou outra unidade da mesma empresa) comprou o mesmo produto até 60 dias depois.
  orcamentosNaoFechados({ meses = 6, vendedor = null, limite = 25 } = {}) {
    const ini = ymd(new Date(this.hojeD - Math.min(Math.max(meses, 1), 24) * 30 * DIA));
    const ini90 = ymd(new Date(this.hojeD - 90 * DIA)), ini12 = ymd(new Date(this.hojeD - 365 * DIA));
    const FECHADO = /faturad|pago|conclu|entreg/i;
    const raizDe = new Map();
    for (const c of this.clientes) { const d = String(c.cnpj_cpf || '').replace(/\D/g, ''); raizDe.set(c.id, d.length === 14 ? d.slice(0, 8) : 'id' + c.id); }
    const emp = id => raizDe.get(id) || 'id' + id;
    let vendIds = null;
    if (vendedor) { const q = norm(vendedor); vendIds = new Set(this.vendedores.filter(v => norm(v.nome).includes(q)).map(v => v.id)); }
    // compras por empresa+produto (datas) e preço médio praticado nos últimos 90 dias
    const compras = new Map(), precoVenda = new Map(), vendido12 = new Set();
    for (const v of this.vendas) {
      if (v.data < ini12 && v.data < ini) continue;
      for (const it of (v.p.itens || [])) {
        if (it.excluido) continue;
        const k = emp(v.p.id_cliente) + '|' + it.id_produto;
        (compras.get(k) || compras.set(k, []).get(k)).push(v.data);
        if (v.data >= ini12) vendido12.add(it.id_produto);
        if (v.data >= ini90) { const pv = precoVenda.get(it.id_produto) || { q: 0, v: 0 }; const q = Number(it.quantidade) || 0; pv.q += q; pv.v += q * (Number(it.preco_liquido) || 0) * v.fator; precoVenda.set(it.id_produto, pv); }
      }
    }
    const orcs = this.orcamentos.filter(o => o.data >= ini && !FECHADO.test(o.p.situacao || '') && (!vendIds || vendIds.has(o.p.id_vendedor)));
    const viraramN = orcs.filter(o => this.virouPedido(o));
    const porProd = new Map(), porEmp = new Map(), porVend = new Map();
    let itens = 0, fechados = 0, valorTot = 0, valorNao = 0;
    for (const o of orcs) {
      const e = emp(o.p.id_cliente);
      const lim = ymd(new Date(o.d.getTime() + 60 * DIA));
      const ce = porEmp.get(e) || { id: o.p.id_cliente, orcamentos: new Set(), itens: 0, fechados: 0, valor_nao_fechado: 0, valor_orcado: 0, vendedor: o.p.id_vendedor };
      ce.orcamentos.add(o.p.numero);
      const cv = porVend.get(o.p.id_vendedor) || { itens: 0, fechados: 0, valor_orcado: 0, valor_nao_fechado: 0, orcamentos: new Set(), viraram: 0 };
      cv.orcamentos.add(o.p.numero); if (this.virouPedido(o)) cv.viraram++;
      for (const it of (o.p.itens || [])) {
        if (it.excluido) continue;
        const q = Number(it.quantidade) || 0, preco = (Number(it.preco_liquido) || 0) * o.fator, val = q * preco;
        const ds = compras.get(e + '|' + it.id_produto) || [];
        const ok = ds.some(d => d >= o.data && d <= lim);
        itens++; valorTot += val; ce.itens++; ce.valor_orcado += val; cv.itens++; cv.valor_orcado += val;
        if (ok) { fechados++; ce.fechados++; cv.fechados++; }
        else {
          valorNao += val; ce.valor_nao_fechado += val; cv.valor_nao_fechado += val;
          const x = porProd.get(it.id_produto) || { empresas: new Set(), vezes: 0, qtd: 0, valor: 0, somaPreco: 0, orcadoTotal: 0, fechadoTotal: 0 };
          x.empresas.add(e); x.vezes++; x.qtd += q; x.valor += val; x.somaPreco += preco;
          porProd.set(it.id_produto, x);
        }
        const xt = porProd.get(it.id_produto); if (xt) { xt.orcadoTotal++; if (ok) xt.fechadoTotal++; }
      }
      porEmp.set(e, ce); porVend.set(o.p.id_vendedor, cv);
    }
    const pct = (a, b) => b ? r2(100 * a / b) : null;
    const produtos = [...porProd.entries()].sort((a, b) => b[1].valor - a[1].valor).slice(0, Math.min(limite, 60)).map(([id, x]) => {
      const p = this.prodById.get(id); const i = p ? this.infoProduto(p) : { nome: (this.nomesProdutos.get(id) || 'Produto ' + id) + ' (inativo)', estoque: null };
      const pv = precoVenda.get(id); const praticado = pv && pv.q ? r2(pv.v / pv.q) : null;
      const orcadoMedio = r2(x.somaPreco / x.vezes);
      let diagnostico;
      if (!p) diagnostico = 'produto inativo no cadastro: oferecer substituto';
      else if (!vendido12.has(id)) diagnostico = 'ninguém comprou em 12 meses: avaliar substituto ou outro fornecedor';
      else if (praticado && orcadoMedio > praticado * 1.05) diagnostico = `orçado ${r2(100 * (orcadoMedio / praticado - 1))}% acima do preço que outros clientes pagam: rever preço`;
      else if ((i.estoque || 0) <= 0) diagnostico = 'sem estoque: o cliente pode ter comprado de quem tinha pronta entrega';
      else diagnostico = 'preço e estoque ok: cobrar retorno do cliente';
      return { codigo: i.codigo, produto: i.nome, empresas_que_orcaram: x.empresas.size, vezes_orcado_sem_fechar: x.vezes, qtd_sem_fechar: r2(x.qtd), valor_sem_fechar: r2(x.valor),
        fechamento_do_produto_pct: pct(x.fechadoTotal, x.orcadoTotal), preco_orcado_medio: orcadoMedio, preco_praticado_90d: praticado, preco_tabela: i.venda, custo: i.custo, margem_pct: i.margem_pct, estoque: i.estoque, diagnostico };
    });
    // atípico: cadastro genérico ("CLIENTE", "CONSUMIDOR") ou um cliente só com mais de 15% de tudo (licitação, cotação gigante)
    const atipico = x => /^(cliente|consumidor)\b/i.test(this.nomeCliente(x.id)) || x.valor_nao_fechado > valorNao * 0.15;
    const atipicos = [...porEmp.values()].filter(atipico);
    const clientes = [...porEmp.values()].sort((a, b) => b.valor_nao_fechado - a.valor_nao_fechado).slice(0, Math.min(limite, 40)).map(x => ({
      cliente: this.nomeCliente(x.id), orcamentos: x.orcamentos.size, valor_orcado: r2(x.valor_orcado), valor_nao_fechado: r2(x.valor_nao_fechado), itens_fechados_pct: pct(x.fechados, x.itens), vendedor: this.nomeVendedor(x.vendedor), ...(atipico(x) ? { atipico: true } : {}) }));
    const vendedores = [...porVend.entries()].map(([id, x]) => ({ vendedor: this.nomeVendedor(id), orcamentos: x.orcamentos.size, viraram_pedido_pct: pct(x.viraram, x.orcamentos.size), valor_orcado: r2(x.valor_orcado), valor_nao_fechado: r2(x.valor_nao_fechado), itens_fechados_pct: pct(x.fechados, x.itens) })).sort((a, b) => b.valor_nao_fechado - a.valor_nao_fechado).slice(0, 15);
    return {
      periodo: { inicio: ini, fim: this.hoje }, ...(vendedor ? { vendedor } : {}),
      resumo: { orcamentos_em_aberto: orcs.length - viraramN.length, orcamentos_no_periodo: orcs.length, viraram_pedido: viraramN.length, viraram_pedido_pct: pct(viraramN.length, orcs.length), empresas: porEmp.size, itens_orcados: itens, itens_fechados_pct: pct(fechados, itens), valor_orcado: r2(valorTot), valor_nao_fechado: r2(valorNao),
        valor_nao_fechado_sem_atipicos: r2(valorNao - atipicos.reduce((a, x) => a + x.valor_nao_fechado, 0)), clientes_atipicos: atipicos.map(x => this.nomeCliente(x.id)) },
      produtos_mais_orcados_sem_fechar: produtos, clientes_com_mais_orcado_sem_fechar: clientes, por_vendedor: vendedores,
      criterio: `Orçamentos com status orçamento (situação diferente de faturado/pago/concluído) emitidos de ${ini} até hoje. Um item conta como fechado se a mesma empresa (mesmo CNPJ raiz) comprou o mesmo produto em até 60 dias. Valores somam todas as versões de orçamento (a mesma oportunidade pode aparecer mais de uma vez). Preço praticado = média paga pelos clientes nos últimos 90 dias.`
    };
  }

  // Pedidos e orçamentos com filtros: número, cliente, produto, vendedor, período, status, situação.
  consultarPedidos({ numero = null, cliente = null, produto = null, vendedor = null, inicio = null, fim = null, status = 'pedido', situacao = null, limite = 15 } = {}) {
    let base = status === 'orcamento' ? this.orcamentos : status === 'todos' ? this.vendas.concat(this.orcamentos) : this.vendas;
    const filtros = [];
    let prodIds = null;
    if (numero != null && String(numero).trim()) {
      const n = String(numero).replace(/\D/g, '');
      base = this.vendas.concat(this.orcamentos).filter(v => String(v.p.numero) === n);
      filtros.push('número ' + n);
      if (produto) { const ps = this._produtosQueBatem(produto); prodIds = new Set(ps.map(p => p.id)); filtros.push('procurando ' + produto); }
    } else {
      if (inicio || fim) { const [i, f] = [inicio || '2000-01-01', fim || this.hoje]; base = base.filter(v => v.data >= i && v.data <= f); filtros.push(`de ${i} a ${f}`); }
      if (cliente) {
        const cs = this._buscarCliente(cliente).slice(0, 3);
        if (!cs.length) return { encontrado: false, mensagem: `Nenhum cliente encontrado para "${cliente}".`, parecidos: this._parecidosCliente(cliente), o_que_fazer: 'Pergunte ao usuário qual é o cliente, mostrando os parecidos.' };
        const ids = new Set([cs[0].id]); base = base.filter(v => ids.has(v.p.id_cliente)); filtros.push('cliente ' + this.nomeCliente(cs[0].id));
        const outras = this._mesmaEmpresa(cs[0]).filter(x => x.id !== cs[0].id);
        if (outras.length) filtros.push(`atenção: há outra(s) unidade(s) com o mesmo CNPJ raiz: ${outras.map(x => (x.fantasia || x.razao_social) + ' (código ' + x.codigo + ')').join(', ')}; consulte pelo código para incluir`);
      }
      if (vendedor) { const q = norm(vendedor); const ids = new Set(this.vendedores.filter(v => norm(v.nome).includes(q)).map(v => v.id)); base = base.filter(v => ids.has(v.p.id_vendedor)); filtros.push('vendedor ' + vendedor); }
      if (produto) {
        const ps = this._produtosQueBatem(produto);
        if (!ps.length) return { encontrado: false, mensagem: `Nenhum produto encontrado para "${produto}".`, parecidos_produto: this._parecidosProduto(produto), o_que_fazer: 'Mostre os parecidos e pergunte qual é, ou peça o código do produto.' };
        prodIds = new Set(ps.map(p => p.id));
        base = base.filter(v => (v.p.itens || []).some(i => !i.excluido && prodIds.has(i.id_produto)));
        filtros.push('produto ' + (ps.length === 1 ? ps[0].nome : `"${produto}" (${ps.length} produtos: ${ps.slice(0, 8).map(p => p.nome).join('; ')}${ps.length > 8 ? '...' : ''})`));
      }
      if (situacao) { const q = norm(situacao); base = base.filter(v => norm(v.p.situacao).includes(q)); filtros.push('situação ' + situacao); }
    }
    const lista = base.slice().sort((a, b) => a.data < b.data ? 1 : a.data > b.data ? -1 : (b.p.numero || 0) - (a.p.numero || 0));
    const detalhar = lista.length <= 3;
    // com filtro de produto: as linhas desse produto em cada pedido e o total de TODOS os pedidos encontrados
    const linhasDoProduto = v => prodIds ? (v.p.itens || []).filter(i => !i.excluido && prodIds.has(i.id_produto)) : [];
    let somaProd = null;
    if (prodIds) {
      somaProd = { quantidade: 0, valor: 0, pedidos_com_o_produto: 0, por_produto: {} };
      for (const v of lista) { const ls = linhasDoProduto(v); if (ls.length) somaProd.pedidos_com_o_produto++; for (const i of ls) { const q = Number(i.quantidade) || 0, val = q * (Number(i.preco_liquido) || 0) * v.fator; somaProd.quantidade += q; somaProd.valor += val; const pr = this.prodById.get(i.id_produto) || {}; const k = pr.nome || String(i.id_produto); somaProd.por_produto[k] = r2((somaProd.por_produto[k] || 0) + q); } }
      somaProd.quantidade = r2(somaProd.quantidade); somaProd.valor = r2(somaProd.valor);
    }
    return {
      encontrado: lista.length > 0, filtros, total: lista.length, valor_total: r2(lista.reduce((a, v) => a + v.total, 0)),
      ...(somaProd ? { produto_nos_pedidos: Object.assign({ observacao: 'Somado em todos os pedidos encontrados (não só nos listados).' }, somaProd) } : {}),
      ...(lista.length > Math.min(limite, 40) ? { aviso: `Mostrando ${Math.min(limite, 40)} de ${lista.length}. Peça um período menor ou outro filtro para ver os demais.` } : {}),
      pedidos: lista.slice(0, Math.min(limite, 40)).map(v => Object.assign({ numero: v.p.numero, data: v.data, status: v.p.status, situacao: v.p.situacao || null, cliente: this.nomeCliente(v.p.id_cliente), vendedor: this.nomeVendedor(v.p.id_vendedor), valor: r2(v.total), forma_pagamento: v.p.forma_pagamento || null, condicao: Array.isArray(v.p.condicao_pagamento) && v.p.condicao_pagamento.length ? (v.p.condicao_pagamento.length === 1 && +v.p.condicao_pagamento[0] === 0 ? 'À vista' : v.p.condicao_pagamento.join('/') + ' dias') : null, previsao_entrega: v.p.previsao_entrega || null, observacao: v.p.observacao_cliente || null },
        prodIds ? { itens_do_produto: linhasDoProduto(v).map(i => this._linhaItem(i)) } : {},
        detalhar && !(prodIds && numero) ? this._resumoItens(v.p) : { itens_total: (v.p.itens || []).filter(i => !i.excluido).length }))
    };
  }

  // Quem compra um produto, quanto, por quanto, mês a mês.
  vendasProduto({ texto, inicio = null, fim = null, agrupar = 'cliente', limite = 10 } = {}) {
    const ps = this.buscarProdutos(texto || '', 5);
    if (!ps.length) return { encontrado: false, mensagem: `Nenhum produto encontrado para "${texto}".`, parecidos_produto: this._parecidosProduto(texto), o_que_fazer: 'Mostre os parecidos e pergunte qual é, ou peça o código do produto.' };
    const p = ps[0];
    const [i, f] = [inicio || ymd(new Date(this.hojeD - 364 * DIA)), fim || this.hoje];
    const grupos = new Map(); let q = 0, fat = 0, ped = 0, ult = null;
    for (const v of this.vendas) {
      if (v.data < i || v.data > f) continue;
      let achou = false;
      for (const it of (v.p.itens || [])) {
        if (it.excluido || it.id_produto !== p.id) continue;
        achou = true; const qt = Number(it.quantidade) || 0, val = qt * (Number(it.preco_liquido) || 0) * v.fator;
        q += qt; fat += val; if (!ult || v.data > ult.data) ult = { data: v.data, preco: r2(it.preco_liquido), cliente: this.nomeCliente(v.p.id_cliente) };
        const k = agrupar === 'mes' ? v.data.slice(0, 7) : agrupar === 'vendedor' ? this.nomeVendedor(v.p.id_vendedor) : this.nomeCliente(v.p.id_cliente);
        const g = grupos.get(k) || { nome: k, quantidade: 0, faturamento: 0, pedidos: 0, ultima: null }; g.quantidade += qt; g.faturamento += val; g.pedidos++; if (!g.ultima || v.data > g.ultima) g.ultima = v.data; grupos.set(k, g);
      }
      if (achou) ped++;
    }
    let gs = [...grupos.values()].map(g => Object.assign(g, { faturamento: r2(g.faturamento) }));
    gs = agrupar === 'mes' ? gs.sort((a, b) => a.nome < b.nome ? -1 : 1) : gs.sort((a, b) => b.faturamento - a.faturamento);
    return { encontrado: true, produto: { codigo: p.codigo, nome: p.nome, estoque: p.estoque, preco_tabela: p.venda }, outros_parecidos: ps.slice(1, 4).map(x => x.nome), periodo: { inicio: i, fim: f }, quantidade: q, faturamento: r2(fat), pedidos: ped, preco_medio: q ? r2(fat / q) : null, ultima_venda: ult, agrupado_por: agrupar, grupos_total: gs.length, grupos: gs.slice(0, Math.min(limite, 30)) };
  }

  // Títulos de um cliente: em aberto (com atraso) e os últimos pagos.
  titulosCliente(texto) {
    const cs = this._buscarCliente(texto || '');
    if (!cs.length) return { encontrado: false, mensagem: `Nenhum cliente encontrado para "${texto}".` };
    const c = cs[0];
    const numPed = new Map(this.pedidosTodos.map(p => [p.id, p.numero]));
    const abertos = this._cobrancasAbertas().filter(x => x.id_cliente === c.id).sort((a, b) => a.vencimento < b.vencimento ? -1 : 1)
      .map(x => ({ vencimento: x.vencimento, saldo: r2(x.saldo), vencido: x.vencido, dias_atraso: x.vencido ? diasEntre(parseD(x.vencimento), this.hojeD) : 0, forma: x.forma || null, pedido: numPed.get(x.id_pedido) || null }));
    const pagos = this.titulos.filter(t => t.id_cliente === c.id && t.pagamento).sort((a, b) => String(a.pagamento) < String(b.pagamento) ? 1 : -1).slice(0, 5)
      .map(t => ({ vencimento: String(t.vencimento || '').slice(0, 10), pago_em: String(t.pagamento).slice(0, 10), valor: r2(t.valor), valor_pago: r2(t.valor_pago), dias_atraso_pagamento: t.vencimento ? Math.max(0, diasEntre(parseD(t.vencimento), parseD(t.pagamento))) : null }));
    return { encontrado: true, cliente: this.nomeCliente(c.id), outros_parecidos: cs.slice(1, 4).map(x => this.nomeCliente(x.id)), em_aberto: r2(abertos.reduce((a, x) => a + x.saldo, 0)), vencido: r2(abertos.filter(x => x.vencido).reduce((a, x) => a + x.saldo, 0)), titulos_abertos: abertos.slice(0, 30), titulos_abertos_total: abertos.length, ultimos_pagos: pagos };
  }

}

module.exports = { Engine, norm, r2, ymd };
