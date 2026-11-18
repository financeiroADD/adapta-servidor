// Níveis de acesso do sistema e do Adaptus no WhatsApp.
// Um lugar só para dizer o que cada perfil vê: telas do programa, cálculos do motor,
// consultas do Adaptus e campos que somem das respostas (custo, margem, faturamento).
'use strict';
const crypto = require('crypto');

const TELAS = ['inicio', 'perguntas', 'orcamento', 'tarefas', 'crm', 'estoque', 'compras', 'aprovacoes', 'fornecedores', 'clientes', 'gastos', 'caixa', 'whatsapp', 'feedback', 'historico', 'seguranca', 'config'];

const SENSIVEIS_VENDAS = ['custo', 'custo_unit', 'margem_pct', 'margem_bruta', 'margem_12m_pct', 'faturamento_12m', 'prazo_fornecedor', 'valor_12m', 'ticket_medio_12m', 'valor_12m_em_risco'];

const PAPEIS = {
  dono: {
    nome: 'Dono', resumo: 'Tudo: vendas, margens, financeiro, compras e configurações.',
    telas: TELAS, metodos: null, ferramentas: null, esconder: [], verMargem: true
  },
  vendas: {
    nome: 'Vendas', resumo: 'Orçamentos, estoque e o Adaptus para produtos, clientes e pedidos. Não vê custo, margem nem financeiro.',
    telas: ['perguntas', 'orcamento', 'tarefas', 'crm', 'estoque', 'gastos', 'feedback'],
    metodos: ['buscarProdutos', 'buscarClientes', 'infoCliente', 'produtosEmRisco'],
    ferramentas: ['buscar_produtos', 'produtos_em_risco', 'buscar_clientes', 'consultar_pedidos', 'oportunidades_cliente', 'orcamentos_nao_fechados', 'clientes_inativos', 'registrar_aprendizado', 'consultar_conhecimento', 'preparar_acao_pedidook'],
    esconder: SENSIVEIS_VENDAS, verMargem: false
  },
  compras: {
    nome: 'Compras', resumo: 'Estoque, faltas e sugestão de compra, com custo. Não vê margem, faturamento nem financeiro.',
    telas: ['perguntas', 'tarefas', 'crm', 'estoque', 'compras', 'aprovacoes', 'fornecedores', 'gastos', 'feedback'],
    metodos: ['produtosEmRisco', 'sugestaoCompra', 'buscarProdutos', 'qualidadeDados'],
    ferramentas: ['buscar_produtos', 'produtos_em_risco', 'sugestao_compra', 'qualidade_dados', 'vendas_do_produto', 'historico_fornecedor', 'registrar_aprendizado', 'consultar_conhecimento', 'preparar_acao_pedidook'],
    esconder: ['margem_pct', 'margem_bruta', 'margem_12m_pct', 'faturamento_12m', 'faturamento', 'valor_12m', 'vendas_12m'], verMargem: false
  },
  financeiro: {
    nome: 'Financeiro', resumo: 'Contas a receber, cobranças, ficha dos clientes, gastos com cartão e fluxo de caixa. Não vê custo nem margem.',
    telas: ['perguntas', 'tarefas', 'crm', 'clientes', 'gastos', 'caixa', 'feedback'],
    metodos: ['cobrancas', 'clientesInativos', 'infoCliente', 'buscarClientes'],
    ferramentas: ['cobrancas', 'info_cliente', 'titulos_do_cliente', 'consultar_pedidos', 'buscar_clientes', 'clientes_inativos', 'registrar_aprendizado', 'consultar_conhecimento', 'fluxo_caixa', 'gastos_cartao', 'preparar_acao_pedidook'],
    esconder: ['margem_pct', 'margem_12m_pct', 'margem_bruta', 'custo', 'custo_unit'], verMargem: false
  }
};

const papel = p => PAPEIS[p] || PAPEIS.vendas;   // papel desconhecido = o mais restrito

function podeTela(p, tela) { return papel(p).telas.includes(tela); }
function podeMetodo(p, metodo) { const m = papel(p).metodos; return !m || m.includes(metodo); }

// Tira os campos sensíveis de qualquer resposta (objetos e listas, em qualquer nível).
function limpador(p) {
  const esconder = new Set(papel(p).esconder);
  if (!esconder.size) return null;
  const limpar = v => {
    if (Array.isArray(v)) return v.map(limpar);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (!esconder.has(k)) o[k] = limpar(x); return o; }
    return v;
  };
  return limpar;
}

// PIN guardado só como hash scrypt com sal (OWASP Password Storage: scrypt N=2^15+, r=8, p=1).
// O hash ainda fica dentro do cofre criptografado; a espera crescente entre tentativas freia o chute.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
function hashPin(pin, sal) {
  sal = sal || crypto.randomBytes(16).toString('hex');
  return { v: 2, sal, hash: crypto.scryptSync(String(pin), sal, 32, SCRYPT).toString('hex') };
}
function confere(pin, reg) {
  if (!reg || !reg.hash) return true;   // sem PIN definido
  const h = reg.v === 2 ? crypto.scryptSync(String(pin || ''), reg.sal, 32, SCRYPT) : crypto.scryptSync(String(pin || ''), reg.sal, 32);
  const esperado = Buffer.from(reg.hash, 'hex');
  return esperado.length === h.length && crypto.timingSafeEqual(h, esperado);
}

// Senha: mesmo hash scrypt do PIN. Diferente do PIN, sem senha cadastrada NUNCA confere.
function confereSenha(senha, reg) { if (!reg || !reg.hash) return false; return confere(String(senha || ''), reg); }
const SENHA_FALSA = hashPin('nao-existe-' + crypto.randomBytes(8).toString('hex'));   // gasta o mesmo tempo quando o usuário não existe
const COMUNS = new Set(['12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234', '12121212', 'password', 'password1', 'senha123', 'senha1234', 'senha12345', 'qwerty123', 'abc12345', 'abcd1234', 'admin123', 'administrador', 'mudar123', 'trocar123', 'adapta123', 'adapta2026', 'adapta2025', 'addclean123', 'danilo123', 'iloveyou', 'brasil123', 'manaus123', 'qwertyui', 'asdfghjk']);
function senhaFraca(senha, login = '', nome = '') {
  const s = String(senha || '');
  if (s.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (s.length > 128) return 'Senha longa demais.';
  const b = s.toLowerCase();
  if (COMUNS.has(b)) return 'Essa senha é muito comum. Escolha outra.';
  if (/^(.)\1+$/.test(s)) return 'Senha fácil demais.';
  if (/^\d+$/.test(s) && s.length < 12) return 'Use letras e números (ou uma frase), não só números.';
  if ('01234567890123456789'.includes(s) || 'abcdefghijklmnopqrstuvwxyz'.includes(b) || 'qwertyuiopasdfghjklzxcvbnm'.includes(b)) return 'Sequência fácil demais.';
  const l = String(login || '').toLowerCase(), n = String(nome || '').toLowerCase().split(/\s+/)[0] || '';
  if ((l.length >= 3 && b.includes(l)) || (n.length >= 3 && b.includes(n))) return 'Não use seu usuário ou seu nome na senha.';
  return null;
}
const loginValido = l => /^[a-z0-9][a-z0-9._-]{2,19}$/.test(String(l || ''));

module.exports = { TELAS, PAPEIS, papel, podeTela, podeMetodo, limpador, hashPin, confere, confereSenha, SENHA_FALSA, senhaFraca, loginValido };
