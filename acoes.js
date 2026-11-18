// Ações do Adaptus no PedidoOK (programa e WhatsApp).
// Catálogo fechado, permissão por perfil e campos conforme a API oficial (docs.api.pedidook.com.br, lida em 16/11/2026).
// Nada aqui grava sozinho: preparar() monta o plano e o resumo; executar() só roda depois que a pessoa confirma
// (botão Confirmar no programa, ou "confirmar" no WhatsApp). Sem PUT (zera campos omitidos): só POST, PATCH e DELETE.
// Excluir no PedidoOK é reversível ("reativar"), e só o Dono exclui ou reativa.
'use strict';
const crypto = require('crypto');

// ---------- utilidades ----------
class ErroAcao extends Error {}
const erro = m => new ErroAcao(m);
const LIM = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n);
const vazio = v => v == null || (typeof v === 'string' && !v.trim());
function numero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v == null ? '' : v).trim().replace(/[R$\s%]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s); return Number.isFinite(n) ? n : NaN;
}
const r2 = n => Math.round(n * 100) / 100;
const brl = n => 'R$ ' + r2(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => String(Math.round(n * 10) / 10).replace('.', ',') + '%';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const soNum = (s, n) => String(s == null ? '' : s).replace(/\D/g, '').slice(0, n);
function dataISO(v, nome) {
  if (vazio(v)) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) { const b = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (b) m = [null, b[3].length === 2 ? '20' + b[3] : b[3], b[2].padStart(2, '0'), b[1].padStart(2, '0')]; }
  if (!m) throw erro(`Data inválida em ${nome}: use dia/mês/ano.`);
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  if (isNaN(d) || d.getUTCDate() !== Number(m[3])) throw erro(`Data inválida em ${nome}.`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}
const dataBR = s => s ? String(s).slice(0, 10).split('-').reverse().join('/') : '(vazio)';
const idParceiro = () => 'ADAPTA-' + crypto.randomBytes(9).toString('hex');   // 25 caracteres (limite 36)
function positivo(v, nome, { zero = false, max = 1e9 } = {}) {
  const n = numero(v);
  if (!Number.isFinite(n) || n < 0 || (!zero && n === 0) || n > max) throw erro(`Valor inválido em ${nome}.`);
  return r2(n);
}

// valores aceitos pela API (documentação); o texto da pessoa é traduzido para eles
const FORMAS = [[/pix/, 'pix'], [/boleto/, 'boleto'], [/cr[eé]dito/, 'cartao credito'], [/d[eé]bito/, 'cartao debito'], [/dinheiro|esp[eé]cie/, 'dinheiro'], [/dep[oó]sito|transfer[eê]ncia|ted|doc\b/, 'deposito em conta'], [/cheque/, 'cheque'], [/voucher|vale/, 'voucher']];
function formaPagamento(v) {
  if (vazio(v)) return null;
  const t = norm(v);
  for (const [re, val] of FORMAS) if (re.test(t)) return val;
  throw erro(`Forma de pagamento "${LIM(v, 30)}" não existe no PedidoOK. Use boleto, PIX, cartão de crédito, cartão de débito, dinheiro, depósito em conta, cheque ou voucher.`);
}
const SITUACOES = { entregue: 'entregue', separado: 'separado', concluido: 'concluido', pago: 'pago', faturado: 'faturado', pendente: 'pendente' };
function situacao(v) {
  const t = norm(v).replace(/[^a-z]/g, '');
  if (!SITUACOES[t]) throw erro('Situação inválida. Use entregue, separado, concluído, pago, faturado ou pendente.');
  return SITUACOES[t];
}
function tipoFrete(v) {
  const t = norm(v).toUpperCase();
  if (!t || t === 'SEM' || t === 'NENHUM') return '';
  if (t === 'FOB' || t === 'CIF') return t;
  throw erro('Tipo de frete inválido. Use CIF, FOB ou vazio.');
}
// prazos: [28,35,42], "28/35/42", "28 35 42 dias", "à vista"
function prazos(v) {
  if (vazio(v)) return null;
  if (Array.isArray(v)) { const a = v.map(Number); if (!a.length || a.some(n => !Number.isInteger(n) || n < 0 || n > 365)) throw erro('Prazos de pagamento inválidos.'); return a.slice(0, 12); }
  const t = norm(v);
  if (/vista|avista|antecipad/.test(t)) return [0];
  const a = (t.match(/\d+/g) || []).map(Number).filter(n => n >= 0 && n <= 365).slice(0, 12);
  if (!a.length) throw erro('Diga os prazos de pagamento em dias (ex.: 28/35/42) ou "à vista".');
  return a;
}
const nomePrazos = a => a ? (a.length === 1 && a[0] === 0 ? 'à vista' : a.join('/') + ' dias') : '(sem prazo)';

// ---------- quem é quem nos dados ----------
function acharCliente(E, ref) {
  if (vazio(ref)) throw erro('Diga qual cliente (código, CNPJ ou nome).');
  const s = String(ref).trim();
  if (/^\d+$/.test(s) && E.cliById.has(Number(s))) return E.cliById.get(Number(s));
  const porCodigo = E.clientes.find(c => String(c.codigo).trim() === s);
  if (porCodigo) return porCodigo;
  const dig = s.replace(/\D/g, '');
  if (dig.length === 11 || dig.length === 14) { const c = E.clientes.find(x => String(x.cnpj_cpf || '').replace(/\D/g, '') === dig); if (c) return c; }
  const l = (E.buscarClientes(s, 4) || []).map(x => E.cliById.get(x.id)).filter(Boolean);
  const exato = l.filter(c => norm(c.fantasia) === norm(s) || norm(c.razao_social) === norm(s));
  if (exato.length === 1) return exato[0];
  if (l.length === 1) return l[0];
  if (!l.length) throw erro(`Não achei o cliente "${LIM(s, 40)}".`);
  throw erro(`Achei mais de um cliente para "${LIM(s, 40)}": ${l.slice(0, 4).map(c => `${c.fantasia || c.razao_social} (cód ${c.codigo})`).join('; ')}. Diga o código.`);
}
function acharProduto(E, ref) {
  if (vazio(ref)) throw erro('Diga qual produto (código ou nome).');
  const s = String(ref).trim();
  if (/^\d{5,}$/.test(s) && E.prodById.has(Number(s)) && !E.produtos.some(p => String(p.codigo) === s)) return E.prodById.get(Number(s));
  const cod = E.produtos.find(p => String(p.codigo).trim() === s) || (/^\d+$/.test(s) ? E.produtos.find(p => /^\d+$/.test(String(p.codigo)) && Number(p.codigo) === Number(s)) : null);
  if (cod) return cod;
  const l = (E.buscarProdutos(s, 4) || []).map(x => E.prodById.get(x.id) || E.produtos.find(p => p.codigo === x.codigo)).filter(Boolean);
  const exato = l.filter(p => norm(p.nome) === norm(s));
  if (exato.length === 1) return exato[0];
  if (l.length === 1) return l[0];
  if (!l.length) throw erro(`Não achei o produto "${LIM(s, 40)}".`);
  throw erro(`Achei mais de um produto para "${LIM(s, 40)}": ${l.slice(0, 4).map(p => `${p.nome} (cód ${p.codigo})`).join('; ')}. Diga o código.`);
}
function acharPedido(E, ref, { excluido } = {}) {
  if (vazio(ref)) throw erro('Diga o número do pedido ou orçamento.');
  const n = Number(String(ref).replace(/\D/g, ''));
  if (!n) throw erro('Número de pedido inválido.');
  const lista = excluido || E.pedidosTodos;
  const p = lista.find(x => Number(x.numero) === n) || lista.find(x => Number(x.id) === n);
  if (!p) throw erro(`Não achei o pedido ou orçamento nº ${n}${excluido ? ' entre os excluídos' : ''}.`);
  return p;
}
function acharFornecedor(E, ref) {
  if (vazio(ref)) throw erro('Diga qual fornecedor.');
  const s = String(ref).trim();
  if (/^\d+$/.test(s) && E.fornById.has(Number(s))) return E.fornById.get(Number(s));
  const n = norm(s);
  const l = E.fornecedores.filter(f => norm(f.fantasia) === n || norm(f.razao_social) === n);
  if (l.length === 1) return l[0];
  const p = E.fornecedores.filter(f => norm(f.fantasia).includes(n) || norm(f.razao_social).includes(n));
  if (p.length === 1) return p[0];
  if (!p.length) throw erro(`Não achei o fornecedor "${LIM(s, 40)}".`);
  throw erro(`Achei mais de um fornecedor para "${LIM(s, 40)}": ${p.slice(0, 4).map(f => f.fantasia || f.razao_social).join('; ')}.`);
}
function acharCobranca(E, ref, { excluido } = {}) {
  const n = Number(String(ref == null ? '' : ref).replace(/\D/g, ''));
  if (!n) throw erro('Diga qual cobrança (o id que aparece nos títulos do cliente).');
  const c = (excluido || E.titulos).find(t => Number(t.id) === n);
  if (!c) throw erro(`Não achei a cobrança ${n}${excluido ? ' entre as excluídas' : ''}.`);
  return c;
}
function acharVendedor(E, ref, ctx, cli) {
  if (!vazio(ref)) {
    const s = String(ref).trim(), n = norm(s);
    if (/^\d+$/.test(s) && E.vendById.has(Number(s))) return E.vendById.get(Number(s));
    const l = E.vendedores.filter(v => norm(v.nome) === n || norm(v.nome).startsWith(n) || n.startsWith(norm(v.nome)));
    if (l.length === 1) return l[0];
    throw erro(`Vendedor "${LIM(s, 30)}" não encontrado. Vendedores: ${E.vendedores.map(v => v.nome).join(', ')}.`);
  }
  // quem pede é vendedor(a)? usa o próprio nome
  const eu = norm(ctx.usuarioNome);
  if (eu) { const l = E.vendedores.filter(v => { const vn = norm(v.nome); return vn === eu || vn.startsWith(eu + ' ') || eu.startsWith(vn + ' ') || vn.split(' ')[0] === eu.split(' ')[0]; }); if (l.length === 1) return l[0]; }
  // senão, o vendedor do último pedido do cliente
  if (cli) { const ult = ultimoPedido(E, cli.id); if (ult && E.vendById.has(ult.id_vendedor)) return E.vendById.get(ult.id_vendedor); }
  throw erro(`Diga qual vendedor: ${E.vendedores.map(v => v.nome).join(', ')}.`);
}
function ultimoPedido(E, idCliente) {
  let u = null;
  for (const p of E.pedidosTodos) if (p.id_cliente === idCliente && p.status === 'pedido' && (!u || String(p.emissao) > String(u.emissao))) u = p;
  return u;
}
function condicao(E, v, cli) {
  let a = prazos(v);
  if (!a && cli) { const u = ultimoPedido(E, cli.id); if (u) { if (u.id_cond_pagto && E.condicoes.some(c => c.id === u.id_cond_pagto)) return { id_cond_pagto: u.id_cond_pagto, texto: nomePrazos((E.condicoes.find(c => c.id === u.id_cond_pagto) || {}).prazos) + ' (o mesmo do último pedido)' }; if (Array.isArray(u.condicao_pagamento) && u.condicao_pagamento.length) a = u.condicao_pagamento.map(Number); } }
  if (!a) return { condicao_pagamento: [0], texto: 'à vista (o cliente não tem pedido anterior; diga o prazo se for outro)' };
  const c = E.condicoes.find(x => JSON.stringify((x.prazos || []).map(Number)) === JSON.stringify(a));
  return c ? { id_cond_pagto: c.id, texto: nomePrazos(a) } : { condicao_pagamento: a, texto: nomePrazos(a) };
}
// preço de referência: último que o cliente pagou (até 180 dias); senão, a tabela. É a mesma regra do desconto do orçamento.
function precoReferencia(E, cli, p) {
  let ref = Number(p.venda) || 0, origem = 'tabela';
  if (cli) {
    const h = E.historicoCliente(cli.id).produtos.get(p.id);
    if (h && h.ultimo_preco > 0 && h.ultima_data && (E.hojeD - new Date(h.ultima_data + 'T12:00:00Z')) / 864e5 <= 180) { ref = h.ultimo_preco; origem = 'último preço do cliente'; }
  }
  return { ref: r2(ref), origem };
}
const nomeCli = c => `${c.fantasia || c.razao_social} (cód ${c.codigo})`;
const nomeProd = p => `${p.nome} (cód ${p.codigo})`;

// ---------- itens ----------
function montarItem(E, cli, it, ctx) {
  const p = acharProduto(E, it.produto != null ? it.produto : (it.codigo != null ? it.codigo : it.id_produto));
  const q = numero(it.quantidade);
  if (!Number.isFinite(q) || q <= 0 || q > 1e6) throw erro(`Quantidade inválida para ${p.nome}.`);
  const { ref, origem } = precoReferencia(E, cli, p);
  let bruto, liquido, perc;
  if (!vazio(it.preco)) {
    liquido = positivo(it.preco, 'preço de ' + p.nome);
    bruto = ref > 0 ? ref : liquido;
    perc = bruto > 0 ? r2((liquido / bruto - 1) * 100) : 0;
  } else {
    if (!(ref > 0)) throw erro(`${p.nome} não tem preço de tabela no PedidoOK. Diga o preço.`);
    const d = vazio(it.desconto_pct) ? 0 : numero(it.desconto_pct);
    if (!Number.isFinite(d) || d < 0 || d >= 100) throw erro(`Desconto inválido para ${p.nome}.`);
    bruto = ref; perc = r2(-d); liquido = r2(ref * (1 - d / 100));
  }
  const descEf = ref > 0 ? (1 - liquido / ref) * 100 : 0;
  const lim = Number(ctx.descontoMaximo);
  if (ctx.papel !== 'dono' && !ctx.descontoAprovado && Number.isFinite(lim) && descEf > lim + 0.05) {
    throw erro(`${p.nome}: ${pct(descEf)} abaixo da referência (${brl(ref)}, ${origem}) passa do limite de ${pct(lim)}. Desconto acima do limite só o Danilo aprova.`);
  }
  const item = { id_produto: p.id, quantidade: q, embalagem: LIM(p.embalagem || 'UN', 4) || 'UN', preco_bruto: r2(bruto), preco_liquido: r2(liquido), percentual_desconto_acrescimo: perc };
  if (Number(p.qtd_embalagem) > 0) item.qtd_embalagem = Number(p.qtd_embalagem);
  if (Number(p.custo) > 0) item.preco_custo = r2(Number(p.custo));
  if (!vazio(it.observacao)) item.observacao = LIM(it.observacao, 100);
  const linha = `${String(q).replace('.', ',')} ${item.embalagem} ${nomeProd(p)} a ${brl(liquido)}${descEf > 0.05 ? ` (${pct(descEf)} abaixo de ${brl(ref)})` : ''} = ${brl(q * liquido)}`;
  return { item, linha, total: q * liquido, p };
}

// ---------- endereço e campos simples ----------
const CAMPOS_END = { logradouro: 50, numero: 20, complemento: 30, bairro: 40, cidade: 50, uf: 2, cep: 8 };
function endereco(v, nome) {
  if (v == null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw erro(`Endereço inválido em ${nome}: informe logradouro, número, bairro, cidade, UF e CEP.`);
  const o = {};
  for (const [k, n] of Object.entries(CAMPOS_END)) if (v[k] != null) o[k] = k === 'cep' ? soNum(v[k], 8) : k === 'uf' ? LIM(v[k], 2).toUpperCase() : LIM(v[k], n);
  if (!Object.keys(o).length) throw erro(`Endereço vazio em ${nome}.`);
  return o;
}
const fmtEnd = e => e ? [e.logradouro, e.numero, e.complemento, e.bairro, e.cidade && e.uf ? e.cidade + '/' + e.uf : e.cidade || e.uf, e.cep].filter(x => !vazio(x)).join(', ') : '(vazio)';
// tipos: t = texto(n), d = documento (só números, 11 ou 14), n = número >= 0, dt = data, e = endereço, int = inteiro
function campo(tipo, v, nome) {
  if (tipo === 'e') return endereco(v, nome);
  if (v === null || (typeof v === 'string' && !v.trim() && tipo.t != null)) return tipo.t != null ? '' : null;
  if (tipo.t != null) return LIM(v, tipo.t);
  if (tipo === 'd') { const d = soNum(v, 14); if (d && d.length !== 11 && d.length !== 14) throw erro(`${nome} deve ter 11 (CPF) ou 14 (CNPJ) números.`); return d; }
  if (tipo === 'ncm') { const d = soNum(v, 8); if (d && d.length !== 8) throw erro('NCM deve ter 8 números.'); return d; }
  if (tipo === 'n') return positivo(v, nome, { zero: true });
  if (tipo === 'int') { const n = numero(v); if (!Number.isInteger(n) || n < 0 || n > 99999) throw erro(`Valor inválido em ${nome}.`); return n; }
  if (tipo === 'dt') return dataISO(v, nome);
  throw erro('campo desconhecido');
}
const T = n => ({ t: n });
const ROTULO = {
  razao_social: 'razão social', fantasia: 'nome fantasia', cnpj_cpf: 'CNPJ/CPF', telefone: 'telefone', celular: 'celular', ie_rg: 'IE/RG', email_copia_pedido: 'e-mail (cópia do pedido)', email_xml_nfe: 'e-mail da NF-e',
  endereco: 'endereço', endereco_cobranca: 'endereço de cobrança', endereco_entrega: 'endereço de entrega', ponto_de_referencia: 'ponto de referência', segmento: 'segmento', observacao: 'observação', limite_credito: 'limite de crédito',
  nome: 'nome', embalagem: 'embalagem', qtd_embalagem: 'quantidade na embalagem', venda: 'preço de venda', custo: 'custo', estoque: 'estoque', estoque_minimo: 'estoque mínimo', ncm: 'NCM', codigo_barra: 'código de barras',
  referencia: 'referência', marca: 'marca', categoria: 'categoria', peso: 'peso (kg)', validade: 'validade', ipi: 'IPI (%)', comissao: 'comissão (%)', id_fornecedor: 'fornecedor', contato: 'contato', site: 'site',
  vencimento: 'vencimento', valor: 'valor', referente: 'referente a', forma_pagamento: 'forma de pagamento', detalhe_forma_pagamento: 'detalhe do pagamento', desconto: 'desconto (R$)', acrescimo: 'acréscimo (R$)',
  percentual_multa: 'multa (%)', valor_multa: 'multa (R$)', percentual_juros_mensal: 'juros ao mês (%)', valor_juros: 'juros (R$)', pagamento: 'data do pagamento', valor_pago: 'valor pago',
  observacao_cliente: 'observação para o cliente', observacao_representada: 'observação interna', previsao_entrega: 'previsão de entrega', valor_frete: 'frete', tipo_frete: 'tipo de frete', transportadora: 'transportadora',
  transportadora_contato: 'contato da transportadora', ordem_compra: 'ordem de compra', id_vendedor: 'vendedor', situacao: 'situação', status: 'tipo', emissao: 'emissão', id_cond_pagto: 'condição de pagamento', condicao_pagamento: 'prazos'
};
const CLIENTE = { razao_social: T(50), fantasia: T(50), cnpj_cpf: 'd', telefone: T(70), ie_rg: T(20), email_copia_pedido: T(100), email_xml_nfe: T(100), endereco: 'e', endereco_cobranca: 'e', endereco_entrega: 'e', ponto_de_referencia: T(70), segmento: T(40), observacao: T(2000), limite_credito: 'n' };
const PRODUTO = { nome: T(100), embalagem: T(4), qtd_embalagem: 'int', venda: 'n', custo: 'n', estoque: 'n', estoque_minimo: 'n', validade: 'dt', comissao: 'n', ipi: 'n', peso: 'n', codigo_barra: T(15), referencia: T(20), ncm: 'ncm', marca: T(100), observacao: T(2000), categoria: T(40) };
const FORNECEDOR = { razao_social: T(50), fantasia: T(50), cnpj_cpf: 'd', ie_rg: T(20), endereco: 'e', ponto_de_referencia: T(70), contato: T(100), telefone: T(70), celular: T(50), site: T(150), observacao: T(2000) };
const COBRANCA = { vencimento: 'dt', valor: 'n', referente: T(100), pagamento: 'dt', valor_pago: 'n', desconto: 'n', acrescimo: 'n', percentual_multa: 'n', valor_multa: 'n', percentual_juros_mensal: 'n', valor_juros: 'n', forma_pagamento: T(50), detalhe_forma_pagamento: T(100), observacao: T(2000) };
const CONTATO = { nome: T(50), departamento: T(50), telefone1: T(70), telefone2: T(70), email: T(100), dia_aniversario: 'int', mes_aniversario: 'int' };
// apelidos que a IA ou a pessoa costumam usar
const APELIDOS = { email: 'email_copia_pedido', cnpj: 'cnpj_cpf', cpf: 'cnpj_cpf', nome_fantasia: 'fantasia', preco_venda: 'venda', preco: 'venda', preco_custo: 'custo', codigo_barras: 'codigo_barra', ean: 'codigo_barra', obs: 'observacao', limite: 'limite_credito', data_pagamento: 'pagamento', valor_recebido: 'valor_pago' };

function campos(def, entrada, { soDono = [], ctx, nomeEntidade, atual }) {
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) throw erro('Diga quais campos mudar.');
  const corpo = {}, linhas = [];
  for (let [k, v] of Object.entries(entrada)) {
    k = APELIDOS[k] || k;
    const tipo = def[k];
    if (!tipo) throw erro(`O campo "${LIM(k, 30)}" não existe em ${nomeEntidade} no PedidoOK.`);
    if (soDono.includes(k) && ctx.papel !== 'dono') throw erro(`Mudar ${ROTULO[k] || k} é só com o Danilo (Dono).`);
    const val = campo(tipo, v, ROTULO[k] || k);
    if (val === undefined) continue;
    corpo[k] = val;
    const antes = atual ? atual[k] : undefined;
    const fmt = x => tipo === 'e' ? fmtEnd(x) : tipo === 'dt' ? dataBR(x) : (['venda', 'custo', 'limite_credito', 'valor', 'valor_pago', 'desconto', 'acrescimo', 'valor_multa', 'valor_juros'].includes(k) ? (x == null || x === '' ? '(vazio)' : brl(Number(x))) : (vazio(x) ? '(vazio)' : String(x)));
    linhas.push(atual ? `${ROTULO[k] || k}: ${fmt(antes)} → ${fmt(tipo === 'e' ? Object.assign({}, antes || {}, val) : val)}` : `${ROTULO[k] || k}: ${fmt(val)}`);
  }
  if (!Object.keys(corpo).length) throw erro('Nenhum campo para mudar.');
  return { corpo, linhas };
}
// próximo código livre no padrão que a empresa já usa (clientes "2908"; produtos "000860")
function proximoCodigo(lista, todos) {
  const cods = (todos || lista).map(x => String(x.codigo || '').trim()).filter(c => /^\d+$/.test(c));
  if (!cods.length) return '1';
  const freq = {}; for (const c of cods) freq[c.length] = (freq[c.length] || 0) + 1;
  const L = Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
  const max = Math.max(...cods.filter(c => c.length === L).map(Number));
  return String(max + 1).padStart(L, '0');
}

// ---------- catálogo ----------
// perfis: quem pode pedir a ação. Excluir, reativar, remover item, preço de venda e limite de crédito: só o Dono.
const V = ['dono', 'vendas'], C = ['dono', 'compras'], F = ['dono', 'financeiro'], D = ['dono'];
const ACOES = {
  criar_orcamento: { perfis: V, grupo: 'pedidos', resumo: 'cria um orçamento', preparar: (d, x) => criarPedido(d, x, 'orcamento') },
  criar_pedido: { perfis: V, grupo: 'pedidos', resumo: 'cria um pedido', preparar: (d, x) => criarPedido(d, x, 'pedido') },
  converter_orcamento_em_pedido: { perfis: V, grupo: 'pedidos', resumo: 'transforma um orçamento em pedido', preparar(d, x) {
    const E = x.engine, p = acharPedido(E, d.pedido);
    if (p.status !== 'orcamento') throw erro(`O nº ${p.numero} já é ${p.status === 'pedido' ? 'pedido' : p.status}, não orçamento.`);
    const manter = d.manter_data === true;
    const corpo = { status: 'pedido' }; if (!manter) corpo.emissao = x.hoje;
    return { metodo: 'PATCH', rota: `/pedidos/${p.id}/cabecalho`, corpo, recurso: 'pedidos', titulo: `Transformar o orçamento nº ${p.numero} em pedido`,
      linhas: [`Cliente: ${E.nomeCliente(p.id_cliente)}`, `Valor: ${brl(totalPedido(p))} (${(p.itens || []).filter(i => !i.excluido).length} itens)`, manter ? `Emissão continua ${dataBR(p.emissao)}` : `Emissão passa de ${dataBR(p.emissao)} para hoje (${dataBR(x.hoje)})`], alvo: { tipo: 'pedido', id: p.id, numero: p.numero } };
  } },
  alterar_pedido: { perfis: ['dono', 'vendas', 'financeiro'], grupo: 'pedidos', resumo: 'muda o cabeçalho de um pedido ou orçamento', preparar(d, x) {
    const E = x.engine, p = acharPedido(E, d.pedido), c = d.campos || {};
    if (!c || typeof c !== 'object' || !Object.keys(c).length) throw erro('Diga o que mudar no pedido.');
    const corpo = {}, linhas = [];
    const so = (perfis, nome) => { if (!perfis.includes(x.papel)) throw erro(`Mudar ${nome} do pedido não é do perfil ${x.papel}.`); };
    const VEND = ['dono', 'vendas'];
    for (const [k0, v] of Object.entries(c)) {
      const k = { observacao: 'observacao_cliente', obs: 'observacao_cliente', observacao_interna: 'observacao_representada', frete: 'valor_frete', pagamento: 'prazos', condicao: 'prazos', vendedor: 'id_vendedor' }[k0] || k0;
      if (k === 'observacao_cliente' || k === 'observacao_representada') { so(VEND, ROTULO[k]); corpo[k] = LIM(v, 100); linhas.push(`${ROTULO[k]}: ${vazio(p[k]) ? '(vazio)' : p[k]} → ${corpo[k] || '(vazio)'}`); }
      else if (k === 'previsao_entrega') { so(VEND, ROTULO[k]); corpo[k] = dataISO(v, ROTULO[k]); linhas.push(`${ROTULO[k]}: ${dataBR(p[k])} → ${dataBR(corpo[k])}`); }
      else if (k === 'forma_pagamento') { so(['dono', 'vendas', 'financeiro'], ROTULO[k]); corpo[k] = formaPagamento(v); linhas.push(`${ROTULO[k]}: ${p[k] || '(vazio)'} → ${corpo[k]}`); }
      else if (k === 'prazos') { so(VEND, 'os prazos'); const cd = condicao(E, v, null); Object.assign(corpo, cd.id_cond_pagto ? { id_cond_pagto: cd.id_cond_pagto } : { id_cond_pagto: null, condicao_pagamento: cd.condicao_pagamento }); linhas.push(`prazos: ${nomePrazos(p.condicao_pagamento)} → ${cd.texto}`); }
      else if (k === 'valor_frete') { so(VEND, 'o frete'); corpo[k] = positivo(v, 'frete', { zero: true }); linhas.push(`frete: ${brl(Number(p.valor_frete) || 0)} → ${brl(corpo[k])}`); }
      else if (k === 'tipo_frete') { so(VEND, 'o tipo de frete'); corpo[k] = tipoFrete(v); linhas.push(`tipo de frete: ${p[k] || '(vazio)'} → ${corpo[k] || '(vazio)'}`); }
      else if (['transportadora', 'transportadora_contato', 'ordem_compra'].includes(k)) { so(VEND, ROTULO[k]); corpo[k] = LIM(v, { transportadora: 50, transportadora_contato: 100, ordem_compra: 40 }[k]); linhas.push(`${ROTULO[k]}: ${p[k] || '(vazio)'} → ${corpo[k] || '(vazio)'}`); }
      else if (k === 'id_vendedor') { so(VEND, 'o vendedor'); const vd = acharVendedor(E, v, x, null); corpo.id_vendedor = vd.id; linhas.push(`vendedor: ${E.nomeVendedor(p.id_vendedor)} → ${vd.nome}`); }
      else if (k === 'situacao') {
        const s = situacao(v);
        // regra da empresa (RN-002): pago e faturado são do financeiro e do Dono
        so(['pago', 'faturado'].includes(s) ? ['dono', 'financeiro'] : ['dono', 'vendas', 'financeiro'], `a situação para "${s}"`);
        corpo.situacao = s; linhas.push(`situação: ${p.situacao || '(vazio)'} → ${s}`);
      }
      else if (k === 'status') { so(D, 'o tipo (pedido, orçamento, troca, bonificação)'); const s = norm(v).replace(/[^a-z]/g, ''); if (!['pedido', 'orcamento', 'troca', 'bonificacao'].includes(s)) throw erro('Tipo inválido: pedido, orçamento, troca ou bonificação.'); corpo.status = s; linhas.push(`tipo: ${p.status} → ${s}`); }
      else if (k === 'emissao') { so(D, 'a data de emissão'); corpo.emissao = dataISO(v, 'emissão'); linhas.push(`emissão: ${dataBR(p.emissao)} → ${dataBR(corpo.emissao)}`); }
      else throw erro(`"${LIM(k0, 30)}" não pode ser mudado aqui. Dá para mudar observação, previsão de entrega, forma de pagamento, prazos, frete, transportadora, ordem de compra, vendedor e situação. Preço e quantidade são por item.`);
    }
    return { metodo: 'PATCH', rota: `/pedidos/${p.id}/cabecalho`, corpo, recurso: 'pedidos', titulo: `Alterar o ${p.status === 'orcamento' ? 'orçamento' : 'pedido'} nº ${p.numero} (${E.nomeCliente(p.id_cliente)})`, linhas, alvo: { tipo: 'pedido', id: p.id, numero: p.numero } };
  } },
  adicionar_item_pedido: { perfis: V, grupo: 'pedidos', resumo: 'inclui itens num pedido ou orçamento', preparar(d, x) {
    const E = x.engine, p = acharPedido(E, d.pedido), cli = E.cliById.get(p.id_cliente) || null;
    const lista = Array.isArray(d.itens) ? d.itens : (d.produto != null ? [d] : []);
    if (!lista.length || lista.length > 100) throw erro('Diga os itens (produto e quantidade), até 100.');
    const ja = new Set((p.itens || []).filter(i => !i.excluido).map(i => i.id_produto));
    const its = lista.map(it => montarItem(E, cli, it, x));
    const dup = its.find(i => ja.has(i.item.id_produto)); if (dup) throw erro(`${dup.p.nome} já está no nº ${p.numero}. Para mudar a quantidade ou o preço, use alterar o item.`);
    if (new Set(its.map(i => i.item.id_produto)).size !== its.length) throw erro('Há produto repetido na lista.');
    return { metodo: 'POST', rota: `/pedidos/${p.id}/itens`, corpo: { itens: its.map(i => i.item) }, recurso: 'pedidos', titulo: `Incluir ${its.length} item(ns) no nº ${p.numero} (${E.nomeCliente(p.id_cliente)})`,
      linhas: its.map(i => i.linha).concat([`Soma dos itens novos: ${brl(its.reduce((a, i) => a + i.total, 0))}`]), alvo: { tipo: 'pedido', id: p.id, numero: p.numero } };
  } },
  alterar_item_pedido: { perfis: V, grupo: 'pedidos', resumo: 'muda quantidade, preço ou observação de um item', preparar(d, x) {
    const E = x.engine, p = acharPedido(E, d.pedido), cli = E.cliById.get(p.id_cliente) || null, prod = acharProduto(E, d.produto);
    const atual = (p.itens || []).find(i => !i.excluido && i.id_produto === prod.id);
    if (!atual) throw erro(`${prod.nome} não está no nº ${p.numero}. Para incluir, use incluir item.`);
    const mudaPreco = !vazio(d.preco) || !vazio(d.desconto_pct);
    const corpo = {}, linhas = [];
    let qNova = Number(atual.quantidade) || 0, liqNovo = Number(atual.preco_liquido) || 0;
    if (!vazio(d.quantidade)) {
      const q = numero(d.quantidade);
      if (!Number.isFinite(q) || q <= 0 || q > 1e6) throw erro(`Quantidade inválida para ${prod.nome}. Para tirar o item, peça para remover.`);
      if (q !== Number(atual.quantidade)) { corpo.quantidade = q; qNova = q; linhas.push(`quantidade: ${atual.quantidade} → ${q}`); }
    }
    if (mudaPreco) {
      const novo = montarItem(E, cli, { produto: prod.id, quantidade: qNova, preco: d.preco, desconto_pct: d.desconto_pct }, x);
      Object.assign(corpo, { preco_bruto: novo.item.preco_bruto, preco_liquido: novo.item.preco_liquido, percentual_desconto_acrescimo: novo.item.percentual_desconto_acrescimo });
      liqNovo = novo.item.preco_liquido; linhas.push(`preço: ${brl(Number(atual.preco_liquido) || 0)} → ${brl(liqNovo)}`);
    }
    if (!vazio(d.observacao)) { corpo.observacao = LIM(d.observacao, 100); linhas.push(`observação do item: ${atual.observacao || '(vazio)'} → ${corpo.observacao}`); }
    if (!Object.keys(corpo).length) throw erro('Nada muda nesse item.');
    linhas.push(`Total do item: ${brl((Number(atual.quantidade) || 0) * (Number(atual.preco_liquido) || 0))} → ${brl(qNova * liqNovo)}`);
    return { metodo: 'PATCH', rota: `/pedidos/${p.id}/itens/${prod.id}`, corpo, recurso: 'pedidos', titulo: `Alterar ${nomeProd(prod)} no nº ${p.numero}`, linhas, alvo: { tipo: 'pedido', id: p.id, numero: p.numero } };
  } },
  remover_item_pedido: { perfis: D, grupo: 'pedidos', perigo: true, resumo: 'tira um item de um pedido ou orçamento', preparar(d, x) {
    const E = x.engine, p = acharPedido(E, d.pedido), prod = acharProduto(E, d.produto);
    const atual = (p.itens || []).find(i => !i.excluido && i.id_produto === prod.id);
    if (!atual) throw erro(`${prod.nome} não está no nº ${p.numero}.`);
    return { metodo: 'DELETE', rota: `/pedidos/${p.id}/itens/${prod.id}`, corpo: null, recurso: 'pedidos', titulo: `Tirar ${nomeProd(prod)} do nº ${p.numero}`, perigo: true,
      linhas: [`${atual.quantidade} ${atual.embalagem || ''} a ${brl(Number(atual.preco_liquido) || 0)} = ${brl((Number(atual.quantidade) || 0) * (Number(atual.preco_liquido) || 0))}`], alvo: { tipo: 'pedido', id: p.id, numero: p.numero } };
  } },
  excluir_pedido: excluir('pedidos', 'pedido', (E, d) => { const p = acharPedido(E, d.pedido); return { id: p.id, nome: `${p.status === 'orcamento' ? 'orçamento' : 'pedido'} nº ${p.numero}`, linhas: [`Cliente: ${E.nomeCliente(p.id_cliente)}`, `Valor: ${brl(totalPedido(p))}, emissão ${dataBR(p.emissao)}`], alvo: { tipo: 'pedido', id: p.id, numero: p.numero } }; }),
  reativar_pedido: reativar('pedidos', 'pedido', (E, d, x) => { const p = acharPedido(E, d.pedido, { excluido: x.excluidos('pedidos') }); return { id: p.id, nome: `${p.status === 'orcamento' ? 'orçamento' : 'pedido'} nº ${p.numero}`, alvo: { tipo: 'pedido', id: p.id, numero: p.numero } }; }),

  criar_cliente: { perfis: V, grupo: 'clientes', resumo: 'cadastra um cliente', preparar(d, x) {
    const E = x.engine, dados = Object.assign({}, d.campos || d); delete dados.codigo;
    if (vazio(dados.razao_social)) throw erro('Para cadastrar, preciso pelo menos da razão social (ou do nome, se for pessoa física).');
    const { corpo, linhas } = campos(CLIENTE, dados, { soDono: ['limite_credito'], ctx: x, nomeEntidade: 'clientes' });
    if (corpo.cnpj_cpf) { const ja = E.clientes.find(c => String(c.cnpj_cpf || '').replace(/\D/g, '') === corpo.cnpj_cpf); if (ja) throw erro(`Já existe cliente com esse CNPJ/CPF: ${nomeCli(ja)}.`); }
    corpo.codigo = vazio(d.codigo) ? proximoCodigo(E.clientes, x.todos('clientes')) : LIM(d.codigo, 10);
    if (x.todos('clientes').some(c => String(c.codigo).trim() === corpo.codigo)) throw erro(`O código ${corpo.codigo} já é de outro cliente.`);
    corpo.id_parceiro = idParceiro();
    return { metodo: 'POST', rota: '/clientes/', corpo, recurso: 'clientes', titulo: `Cadastrar o cliente ${corpo.razao_social}`, linhas: [`código: ${corpo.codigo}`].concat(linhas), alvo: { tipo: 'cliente', codigo: corpo.codigo } };
  } },
  alterar_cliente: { perfis: V, grupo: 'clientes', resumo: 'muda o cadastro de um cliente', preparar(d, x) {
    const E = x.engine, c = acharCliente(E, d.cliente);
    const { corpo, linhas } = campos(CLIENTE, d.campos, { soDono: ['limite_credito'], ctx: x, nomeEntidade: 'clientes', atual: c });
    if (corpo.cnpj_cpf) { const ja = E.clientes.find(o => o.id !== c.id && String(o.cnpj_cpf || '').replace(/\D/g, '') === corpo.cnpj_cpf); if (ja) throw erro(`Esse CNPJ/CPF já é de ${nomeCli(ja)}.`); }
    return { metodo: 'PATCH', rota: `/clientes/${c.id}`, corpo, recurso: 'clientes', titulo: `Alterar o cadastro de ${nomeCli(c)}`, linhas, alvo: { tipo: 'cliente', id: c.id, codigo: c.codigo } };
  } },
  adicionar_contato_cliente: { perfis: V, grupo: 'clientes', resumo: 'inclui um contato no cliente', preparar(d, x) {
    const E = x.engine, c = acharCliente(E, d.cliente), dados = Object.assign({}, d.campos || d); delete dados.cliente;
    if (vazio(dados.nome)) throw erro('Diga o nome do contato.');
    if (dados.telefone && !dados.telefone1) { dados.telefone1 = dados.telefone; delete dados.telefone; }
    const { corpo, linhas } = campos(CONTATO, dados, { ctx: x, nomeEntidade: 'contatos do cliente' });
    corpo.id_parceiro = idParceiro();
    return { metodo: 'POST', rota: `/clientes/${c.id}/contatos`, corpo, recurso: 'clientes', titulo: `Incluir o contato ${corpo.nome} em ${nomeCli(c)}`, linhas, alvo: { tipo: 'cliente', id: c.id, codigo: c.codigo } };
  } },
  excluir_cliente: excluir('clientes', 'cliente', (E, d) => { const c = acharCliente(E, d.cliente); return { id: c.id, nome: 'cliente ' + nomeCli(c), linhas: [`CNPJ/CPF: ${c.cnpj_cpf || '(vazio)'}`], alvo: { tipo: 'cliente', id: c.id, codigo: c.codigo } }; }),
  reativar_cliente: reativar('clientes', 'cliente', (E, d, x) => { const s = String(d.cliente || '').trim(); const c = x.excluidos('clientes').find(o => String(o.codigo) === s || String(o.id) === s || norm(o.razao_social) === norm(s) || norm(o.fantasia) === norm(s)); if (!c) throw erro(`Não achei o cliente "${LIM(s, 40)}" entre os excluídos.`); return { id: c.id, nome: 'cliente ' + nomeCli(c), alvo: { tipo: 'cliente', id: c.id, codigo: c.codigo } }; }),

  criar_produto: { perfis: C, grupo: 'produtos', resumo: 'cadastra um produto', preparar(d, x) {
    const E = x.engine, dados = Object.assign({}, d.campos || d); delete dados.codigo; const forn = dados.fornecedor; delete dados.fornecedor;
    if (vazio(dados.nome)) throw erro('Diga o nome do produto.');
    if (vazio(dados.embalagem)) dados.embalagem = 'UND';
    const { corpo, linhas } = campos(PRODUTO, dados, { soDono: ['venda', 'comissao'], ctx: x, nomeEntidade: 'produtos' });
    if (!vazio(forn)) { const f = acharFornecedor(E, forn); corpo.id_fornecedor = f.id; linhas.push(`fornecedor: ${f.fantasia || f.razao_social}`); }
    corpo.codigo = vazio(d.codigo) ? proximoCodigo(E.produtos, x.todos('produtos')) : LIM(d.codigo, 15);
    if (x.todos('produtos').some(p => String(p.codigo).trim() === corpo.codigo)) throw erro(`O código ${corpo.codigo} já é de outro produto.`);
    corpo.id_parceiro = idParceiro();
    return { metodo: 'POST', rota: '/produtos/', corpo, recurso: 'produtos', titulo: `Cadastrar o produto ${corpo.nome}`, linhas: [`código: ${corpo.codigo}`].concat(linhas, x.papel !== 'dono' && corpo.venda == null ? ['preço de venda: fica para o Danilo definir'] : []), alvo: { tipo: 'produto', codigo: corpo.codigo } };
  } },
  alterar_produto: { perfis: C, grupo: 'produtos', resumo: 'muda o cadastro, custo ou estoque de um produto', preparar(d, x) {
    const E = x.engine, p = acharProduto(E, d.produto), dados = Object.assign({}, d.campos || {}); const forn = dados.fornecedor; delete dados.fornecedor;
    let corpo = {}, linhas = [];
    if (Object.keys(dados).length) ({ corpo, linhas } = campos(PRODUTO, dados, { soDono: ['venda', 'comissao'], ctx: x, nomeEntidade: 'produtos', atual: p }));
    if (!vazio(forn)) { const f = acharFornecedor(E, forn); corpo.id_fornecedor = f.id; linhas.push(`fornecedor: ${E.nomeFornecedor(p.id_fornecedor)} → ${f.fantasia || f.razao_social}`); }
    if (!Object.keys(corpo).length) throw erro('Diga o que mudar no produto.');
    return { metodo: 'PATCH', rota: `/produtos/${p.id}`, corpo, recurso: 'produtos', titulo: `Alterar ${nomeProd(p)}`, linhas, perigo: corpo.venda != null || corpo.estoque != null, alvo: { tipo: 'produto', id: p.id, codigo: p.codigo } };
  } },
  excluir_produto: excluir('produtos', 'produto', (E, d) => { const p = acharProduto(E, d.produto); return { id: p.id, nome: 'produto ' + nomeProd(p), linhas: [`Estoque atual: ${p.estoque}`], alvo: { tipo: 'produto', id: p.id, codigo: p.codigo } }; }),
  reativar_produto: reativar('produtos', 'produto', (E, d, x) => { const s = String(d.produto || '').trim(); const p = x.excluidos('produtos').find(o => String(o.codigo) === s || String(o.id) === s || norm(o.nome) === norm(s)); if (!p) throw erro(`Não achei o produto "${LIM(s, 40)}" entre os excluídos.`); return { id: p.id, nome: 'produto ' + nomeProd(p), alvo: { tipo: 'produto', id: p.id, codigo: p.codigo } }; }),

  criar_fornecedor: { perfis: C, grupo: 'fornecedores', resumo: 'cadastra um fornecedor', preparar(d, x) {
    const E = x.engine, dados = Object.assign({}, d.campos || d);
    if (vazio(dados.razao_social)) throw erro('Diga a razão social do fornecedor.');
    const { corpo, linhas } = campos(FORNECEDOR, dados, { ctx: x, nomeEntidade: 'fornecedores' });
    if (corpo.cnpj_cpf) { const ja = E.fornecedores.find(f => String(f.cnpj_cpf || '').replace(/\D/g, '') === corpo.cnpj_cpf); if (ja) throw erro(`Já existe fornecedor com esse CNPJ: ${ja.fantasia || ja.razao_social}.`); }
    corpo.id_parceiro = idParceiro();
    return { metodo: 'POST', rota: '/fornecedores/', corpo, recurso: 'fornecedores', titulo: `Cadastrar o fornecedor ${corpo.razao_social}`, linhas, alvo: { tipo: 'fornecedor' } };
  } },
  alterar_fornecedor: { perfis: C, grupo: 'fornecedores', resumo: 'muda o cadastro de um fornecedor', preparar(d, x) {
    const E = x.engine, f = acharFornecedor(E, d.fornecedor);
    const { corpo, linhas } = campos(FORNECEDOR, d.campos, { ctx: x, nomeEntidade: 'fornecedores', atual: f });
    return { metodo: 'PATCH', rota: `/fornecedores/${f.id}`, corpo, recurso: 'fornecedores', titulo: `Alterar o fornecedor ${f.fantasia || f.razao_social}`, linhas, alvo: { tipo: 'fornecedor', id: f.id } };
  } },
  excluir_fornecedor: excluir('fornecedores', 'fornecedor', (E, d) => { const f = acharFornecedor(E, d.fornecedor); return { id: f.id, nome: 'fornecedor ' + (f.fantasia || f.razao_social), alvo: { tipo: 'fornecedor', id: f.id } }; }),
  reativar_fornecedor: reativar('fornecedores', 'fornecedor', (E, d, x) => { const s = norm(d.fornecedor); const f = x.excluidos('fornecedores').find(o => String(o.id) === String(d.fornecedor) || norm(o.fantasia) === s || norm(o.razao_social) === s); if (!f) throw erro('Não achei esse fornecedor entre os excluídos.'); return { id: f.id, nome: 'fornecedor ' + (f.fantasia || f.razao_social), alvo: { tipo: 'fornecedor', id: f.id } }; }),

  criar_cobranca: { perfis: F, grupo: 'cobrancas', resumo: 'lança uma cobrança (conta a receber)', preparar(d, x) {
    const E = x.engine, c = acharCliente(E, d.cliente), dados = Object.assign({}, d.campos || d); const ped = dados.pedido; delete dados.cliente; delete dados.pedido;
    if (vazio(dados.valor) || vazio(dados.vencimento)) throw erro('Diga o valor e o vencimento da cobrança.');
    if (dados.forma_pagamento) dados.forma_pagamento = formaPagamento(dados.forma_pagamento);
    const { corpo, linhas } = campos(COBRANCA, dados, { ctx: x, nomeEntidade: 'cobranças' });
    if (!(corpo.valor > 0)) throw erro('O valor da cobrança precisa ser maior que zero.');
    corpo.id_cliente = c.id; corpo.id_parceiro = idParceiro();
    if (!vazio(ped)) { const p = acharPedido(E, ped); if (p.id_cliente !== c.id) throw erro(`O pedido nº ${p.numero} é de outro cliente (${E.nomeCliente(p.id_cliente)}).`); corpo.id_pedido = p.id; linhas.push(`pedido: nº ${p.numero}`); }
    return { metodo: 'POST', rota: '/cobrancas/', corpo, recurso: 'cobrancas', titulo: `Lançar cobrança de ${brl(corpo.valor)} para ${nomeCli(c)}`, linhas, alvo: { tipo: 'cobranca' } };
  } },
  alterar_cobranca: { perfis: F, grupo: 'cobrancas', resumo: 'muda vencimento, valor ou dados de uma cobrança', preparar(d, x) {
    const E = x.engine, t = acharCobranca(E, d.cobranca), dados = Object.assign({}, d.campos || {});
    if (dados.forma_pagamento) dados.forma_pagamento = formaPagamento(dados.forma_pagamento);
    const { corpo, linhas } = campos(COBRANCA, dados, { ctx: x, nomeEntidade: 'cobranças', atual: t });
    return { metodo: 'PATCH', rota: `/cobrancas/${t.id}`, corpo, recurso: 'cobrancas', titulo: `Alterar a cobrança de ${brl(Number(t.valor) || 0)} (venc. ${dataBR(t.vencimento)}) de ${E.nomeCliente(t.id_cliente)}`, linhas, alvo: { tipo: 'cobranca', id: t.id } };
  } },
  registrar_pagamento: { perfis: F, grupo: 'cobrancas', resumo: 'dá baixa (total ou parcial) numa cobrança', preparar(d, x) {
    const E = x.engine, t = acharCobranca(E, d.cobranca);
    const valor = Number(t.valor) || 0, jaPago = Number(t.valor_pago) || 0;
    const pago = vazio(d.valor_pago) ? valor : positivo(d.valor_pago, 'valor pago');
    if (pago > valor * 1.5 + 1) throw erro(`Valor pago (${brl(pago)}) muito acima do valor da cobrança (${brl(valor)}). Confira.`);
    const corpo = { valor_pago: pago, pagamento: vazio(d.data) ? x.hoje : dataISO(d.data, 'data do pagamento') };
    const fp = formaPagamento(d.forma_pagamento); if (fp) corpo.forma_pagamento = fp;
    const resta = r2(valor - pago);
    return { metodo: 'PATCH', rota: `/cobrancas/${t.id}`, corpo, recurso: 'cobrancas', titulo: `Dar baixa na cobrança de ${E.nomeCliente(t.id_cliente)} (venc. ${dataBR(t.vencimento)})`,
      linhas: [`valor da cobrança: ${brl(valor)}${jaPago ? ` (já constava pago ${brl(jaPago)})` : ''}`, `valor pago: ${brl(pago)} em ${dataBR(corpo.pagamento)}${fp ? ' · ' + fp : ''}`, resta > 0.009 ? `continua em aberto: ${brl(resta)} (pagamento parcial)` : 'fica quitada'], alvo: { tipo: 'cobranca', id: t.id } };
  } },
  excluir_cobranca: excluir('cobrancas', 'cobrança', (E, d) => { const t = acharCobranca(E, d.cobranca); return { id: t.id, nome: `cobrança de ${brl(Number(t.valor) || 0)} (venc. ${dataBR(t.vencimento)})`, linhas: [`Cliente: ${E.nomeCliente(t.id_cliente)}`], alvo: { tipo: 'cobranca', id: t.id } }; }),
  reativar_cobranca: reativar('cobrancas', 'cobrança', (E, d, x) => { const t = acharCobranca(E, d.cobranca, { excluido: x.excluidos('cobrancas') }); return { id: t.id, nome: `cobrança de ${brl(Number(t.valor) || 0)} (venc. ${dataBR(t.vencimento)})`, alvo: { tipo: 'cobranca', id: t.id } }; })
};
function excluir(recurso, nome, achar) {
  return { perfis: D, grupo: recurso, perigo: true, resumo: 'exclusão de ' + nome + ', reversível', preparar(d, x) {
    const a = achar(x.engine, d, x);
    return { metodo: 'DELETE', rota: `/${recurso}/${a.id}`, corpo: null, recurso, perigo: true, titulo: `EXCLUIR o ${a.nome}`, linhas: (a.linhas || []).concat(['Some do PedidoOK, mas dá para reativar depois.']), alvo: a.alvo };
  } };
}
function reativar(recurso, nome, achar) {
  return { perfis: D, grupo: recurso, perigo: true, resumo: 'reativação de ' + nome + ' excluído', preparar(d, x) {
    const a = achar(x.engine, d, x);
    return { metodo: 'PATCH', rota: `/${recurso}/${a.id}/undelete`, corpo: null, recurso, perigo: true, titulo: `Reativar o ${a.nome}`, linhas: ['Volta a aparecer no PedidoOK como antes de ser excluído.'], alvo: a.alvo };
  } };
}
function totalPedido(p) { let t = 0; for (const i of p.itens || []) if (!i.excluido) t += (Number(i.quantidade) || 0) * (Number(i.preco_liquido) || 0); return r2(t); }

function criarPedido(d, x, status) {
  const E = x.engine, cli = acharCliente(E, d.cliente);
  const lista = Array.isArray(d.itens) ? d.itens : [];
  if (!lista.length) throw erro('Diga os itens (produto e quantidade).');
  if (lista.length > 200) throw erro('No máximo 200 itens por vez.');
  const its = lista.map(it => montarItem(E, cli, it, x));
  const repetido = its.find((it, i) => its.findIndex(o => o.item.id_produto === it.item.id_produto) !== i);
  if (repetido) throw erro(`${repetido.p.nome} aparece duas vezes. Junte numa linha só.`);
  const vend = acharVendedor(E, d.vendedor, x, cli);
  const cond = condicao(E, d.pagamento != null ? d.pagamento : d.prazos, cli);
  const fp = formaPagamento(d.forma_pagamento);
  const frete = vazio(d.frete) ? 0 : positivo(d.frete, 'frete', { zero: true });
  const corpo = {
    id_parceiro: x.idParceiro || idParceiro(), numero: null, status, emissao: x.hoje, id_cliente: cli.id, id_vendedor: vend.id,
    tipo_desconto_acrescimo: 'percentual', valor_desconto_acrescimo: 0, valor_frete: frete, itens: its.map(i => i.item)
  };
  if (cond.id_cond_pagto) corpo.id_cond_pagto = cond.id_cond_pagto; else corpo.condicao_pagamento = cond.condicao_pagamento;
  if (fp) corpo.forma_pagamento = fp;
  if (!vazio(d.tipo_frete)) corpo.tipo_frete = tipoFrete(d.tipo_frete);
  if (!vazio(d.previsao_entrega)) corpo.previsao_entrega = dataISO(d.previsao_entrega, 'previsão de entrega');
  if (!vazio(d.observacao)) corpo.observacao_cliente = LIM(d.observacao, 100);
  corpo.observacao_representada = LIM(x.observacaoInterna || `Lançado pelo Adaptus (${x.usuarioNome || x.papel})`, 100);
  const total = its.reduce((a, i) => a + i.total, 0);
  const mostrar = its.slice(0, 15).map(i => i.linha);
  if (its.length > 15) mostrar.push(`... e mais ${its.length - 15} itens`);
  return { metodo: 'POST', rota: '/pedidos/', corpo, recurso: 'pedidos', titulo: `Criar ${status === 'orcamento' ? 'ORÇAMENTO' : 'PEDIDO'} para ${nomeCli(cli)}`,
    linhas: [`vendedor: ${vend.nome}`, `pagamento: ${cond.texto}${fp ? ' · ' + fp : ''}`].concat(frete ? [`frete: ${brl(frete)}`] : [], mostrar, [`Total: ${brl(total + frete)}${frete ? ' (com frete)' : ''}`, 'Número: o PedidoOK dá o próximo']), alvo: { tipo: 'pedido' } };
}

// ---------- API do módulo ----------
const NOME_PERFIL = { dono: 'Dono', vendas: 'Vendas', compras: 'Compras', financeiro: 'Financeiro' };
const permitido = (papel, acao) => !!(ACOES[acao] && ACOES[acao].perfis.includes(papel));
const acoesDo = papel => Object.keys(ACOES).filter(a => permitido(papel, a));
// ctx: { papel, engine, descontoMaximo, hoje (AAAA-MM-DD), usuarioNome, todos(recurso), excluidos(recurso), descontoAprovado? }
function preparar(acao, dados, ctx) {
  const def = ACOES[acao];
  if (!def) return { ok: false, erro: `Ação desconhecida: ${LIM(acao, 40)}.` };
  if (!def.perfis.includes(ctx.papel)) return { ok: false, erro: `O perfil ${NOME_PERFIL[ctx.papel] || ctx.papel} não pode fazer isso (${def.resumo}). ${def.perfis.length === 1 ? 'Só o Danilo (Dono) faz.' : 'Quem pode: ' + def.perfis.map(p => NOME_PERFIL[p] || p).join(', ') + '.'}`, semPermissao: true };
  const x = Object.assign({ todos: r => (ctx.engine[{ clientes: 'clientes', produtos: 'produtos' }[r]] || []), excluidos: () => [] }, ctx);
  try {
    const plano = def.preparar(dados && typeof dados === 'object' ? dados : {}, x);
    plano.acao = acao; plano.perigo = !!(plano.perigo || def.perigo);
    return { ok: true, plano };
  } catch (e) {
    if (e instanceof ErroAcao) return { ok: false, erro: e.message };
    return { ok: false, erro: 'Não consegui montar essa ação: ' + String(e && e.message).slice(0, 160) };
  }
}
// erros do PedidoOK em português de gente (tabela de erros da documentação)
const ERROS = { 12: 'registro não encontrado no PedidoOK', 13: 'faltou um campo obrigatório', 14: 'já existe um registro com esse código', 15: 'um valor passou do tamanho permitido', 16: 'um valor não foi aceito pelo PedidoOK', 17: 'fornecedor inexistente', 18: 'o registro está excluído', 19: 'o registro já está ativo', 20: 'existe outro registro ativo com o mesmo código', 22: 'cliente inexistente', 23: 'o pedido não é desse cliente', 24: 'isso já foi gravado antes (não duplicou)', 25: 'vendedor inexistente', 27: 'produto repetido no pedido', 28: 'produto com quantidade zero', 29: 'produto sem embalagem', 31: 'produto não está no pedido', 32: 'produto inexistente', 33: 'pedido inexistente', 34: 'cobrança inexistente', 35: 'condição de pagamento inexistente', 37: 'formato inválido', 39: 'a integração não está habilitada na conta do PedidoOK', 40: 'contato inexistente', 41: 'condição de pagamento inexistente', 42: 'o limite diário de 20 mil chamadas do PedidoOK acabou' };
function explicarErro(msg) {
  const m = String(msg || '');
  const cods = [...m.matchAll(/\b(\d{1,3})\s*-/g)].map(x => Number(x[1])).filter(c => ERROS[c]);
  if (cods.length) return [...new Set(cods)].map(c => ERROS[c]).join('; ') + ` (PedidoOK: ${m.slice(0, 160)})`;
  if (/HTTP 401|HTTP 403/.test(m)) return 'o PedidoOK não aceitou os tokens para gravar (confira a integração na plataforma PC)';
  return 'o PedidoOK recusou: ' + m.slice(0, 200);
}
const achar = (o, k) => { if (!o || typeof o !== 'object') return null; if (o[k] != null && typeof o[k] !== 'object') return o[k]; for (const v of Object.values(o)) { const r = achar(v, k); if (r != null) return r; } return null; };
// requisitar(metodo, rota, corpo) é do programa ou do servidor: confere o endereço do PedidoOK e põe os tokens
async function executar(plano, requisitar) {
  try {
    const r = await requisitar(plano.metodo, plano.rota, plano.corpo);
    return { ok: true, id: achar(r, 'id'), numero: achar(r, 'numero'), resposta: r };
  } catch (e) {
    const jaFeito = /\b24\s*-/.test(String(e.message)) && plano.metodo === 'POST';
    return { ok: jaFeito, jaFeito, erro: explicarErro(e.message), status: e.status || null };
  }
}
// texto curto do catálogo, por perfil, para as instruções do Adaptus
function catalogoTexto(papel) {
  const l = acoesDo(papel);
  if (!l.length) return '';
  return l.map(a => `${a} (${ACOES[a].resumo})`).join('; ');
}
module.exports = { ACOES, preparar, executar, permitido, acoesDo, catalogoTexto, explicarErro, proximoCodigo, formaPagamento, prazos, _t: { numero, dataISO, montarItem, acharCliente, acharProduto } };
