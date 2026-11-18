// Respostas da validação de 15/11/2026 (checklist do Danilo). O programa e o servidor do WhatsApp usam os mesmos
// valores, para calcularem a sugestão de compra com as mesmas regras.
'use strict';
const VALIDACAO_1511 = {
  prazos: [['GOEDERT LTDA', 35], ['NEW PAPER', 3], ['AUDAX QUIMICA', 35], ['ATACADAO', 7], ['JAKSPEL', 3], ['SACOLMAX', 3], ['COPOBRAS-AM', 5], ['TALGE', 5], ['QUEIROZ', 3], ['IVANILDO', 3], ['NALIN', 3], ['BASTON AEROSSOL', 35], ['SEA FILM', 10], ['BRASMAN', 7], ['CONSTRU-LIMPA', 10]],
  parametros: { cicloCompra: 1, diasSeguranca: 45, diasSegurancaDemorado: 90, limiteDemorado: 20 },
  // produto sem fornecedor no PedidoOK -> fornecedor (nome no PedidoOK), 'varia' (compra avulsa) ou nome de fora do PedidoOK (com "=")
  produtos: [['010302', 'varia'], ['011005', 'varia'], ['010819', 'varia'], ['001843', 'BRASMAN'], ['001527', 'GOEDERT LTDA'], ['000495', '=NC COMERCIO'], ['010394', 'PROTEM'], ['000838', 'NALIN']],
  orcamento: { validadeDias: 7, precoPadrao: 'ultimo_cliente', descontoMaximo: 3, numeracao: 'pedidook' }
};

const semAcento = x => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
function acharFornecedor(fornecedores, nome) {
  const n = semAcento(nome);
  return fornecedores.find(f => semAcento(f.fantasia) === n || semAcento(f.razao_social) === n)
    || fornecedores.find(f => semAcento(f.fantasia).startsWith(n) || semAcento(f.razao_social).startsWith(n)) || null;
}

// Aplica as respostas na configuração do servidor (config.json): prazos, parâmetros de compra e produtos sem fornecedor.
// Não mexe em produto que já tem fornecedor no PedidoOK nem em vínculo que já existe.
function aplicarNoServidor({ fornecedores, produtos, config }) {
  config.prazos = config.prazos || {}; config.parametros = config.parametros || {}; config.fornecedorProduto = config.fornecedorProduto || {};
  const feitos = { prazos: 0, vinculos: 0 };
  for (const [nome, dias] of VALIDACAO_1511.prazos) { const f = acharFornecedor(fornecedores, nome); if (f) { config.prazos[String(f.id)] = dias; feitos.prazos++; } }
  Object.assign(config.parametros, VALIDACAO_1511.parametros);
  for (const [cod, destino] of VALIDACAO_1511.produtos) {
    const p = produtos.find(x => String(x.codigo) === cod);
    if (!p || p.id_fornecedor || config.fornecedorProduto[String(p.id)] != null) continue;
    let fid = null;
    if (destino === 'varia') fid = 'varia';
    else if (destino.startsWith('=')) fid = destino.slice(1).slice(0, 20);
    else { const f = acharFornecedor(fornecedores, destino); if (f) fid = f.id; }
    if (fid == null) continue;
    config.fornecedorProduto[String(p.id)] = fid; feitos.vinculos++;
  }
  return feitos;
}
module.exports = { VALIDACAO_1511, semAcento, acharFornecedor, aplicarNoServidor };
