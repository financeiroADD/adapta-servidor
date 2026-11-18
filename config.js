// Configuração do servidor. Tudo vem de variáveis de ambiente (nada de senha dentro do código).
'use strict';
const path = require('path');
const fs = require('fs');
const env = (k, d = '') => (process.env[k] === undefined ? d : String(process.env[k]).trim());
const PRODUCAO = env('NODE_ENV') === 'production';

// Endereços externos só por HTTPS. Endereço local (127.0.0.1) só fora da produção, para testes.
function endereco(valor, padrao) {
  try {
    const u = new URL(valor);
    if (u.protocol === 'https:' && !u.username && !u.password) return valor.replace(/\/$/, '');
    if (!PRODUCAO && u.protocol === 'http:' && u.hostname === '127.0.0.1') return valor.replace(/\/$/, '');
  } catch {}
  if (valor !== padrao) console.error(new Date().toISOString(), 'ATENÇÃO: endereço inválido ou sem HTTPS ignorado; usando o padrão', padrao);
  return padrao;
}

const DATA_DIR = env('DATA_DIR', path.join(__dirname, 'dados'));
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

module.exports = {
  PRODUCAO,
  PORT: Number(env('PORT', '3000')),
  DATA_DIR,
  FUSO: 'America/Manaus',
  WHATSAPP: {
    appSecret: env('WHATSAPP_APP_SECRET'),         // segredo do app da Meta (valida que a mensagem veio mesmo da Meta)
    verifyToken: env('WHATSAPP_VERIFY_TOKEN'),     // senha que você inventa e cola no painel da Meta
    token: env('WHATSAPP_TOKEN'),                  // token de acesso permanente (usuário do sistema)
    phoneId: env('WHATSAPP_PHONE_ID'),             // ID do número no painel da Meta
    // modelo (template) aprovado na Meta para o aviso de segurança ao Dono quando a janela de 24 horas está fechada
    modeloAviso: /^[a-z0-9_]{1,200}$/.test(env('WHATSAPP_MODELO_AVISO', 'adaptus_aviso_seguranca')) ? env('WHATSAPP_MODELO_AVISO', 'adaptus_aviso_seguranca') : 'adaptus_aviso_seguranca',
    modeloIdioma: /^[a-z]{2}(_[A-Z]{2})?$/.test(env('WHATSAPP_MODELO_IDIOMA', 'pt_BR')) ? env('WHATSAPP_MODELO_IDIOMA', 'pt_BR') : 'pt_BR',
    graphBase: endereco(env('GRAPH_BASE', 'https://graph.facebook.com'), 'https://graph.facebook.com'),
    graphVersion: /^v\d{1,3}\.\d{1,2}$/.test(env('GRAPH_VERSION', 'v23.0')) ? env('GRAPH_VERSION', 'v23.0') : 'v23.0'
  },
  PEDIDOOK: {
    tokenParceiro: env('PEDIDOOK_TOKEN_PARCEIRO'),
    token: env('PEDIDOOK_TOKEN'),
    base: endereco(env('PEDIDOOK_BASE', 'https://api.pedidook.com.br/v1'), 'https://api.pedidook.com.br/v1')
  },
  ANTHROPIC_KEY: env('ANTHROPIC_API_KEY'),
  SYNC_HORAS: Math.max(1, Number(env('SYNC_HORAS', '2')) || 2),
  LIMITE_MSG_HORA: Math.max(1, Number(env('LIMITE_MSG_HORA', '40')) || 40),   // por pessoa, protege o saldo da IA
  LIMITE_MSG_DIA: Math.max(1, Number(env('LIMITE_MSG_DIA', '300')) || 300),
  // teto de gasto da IA no WhatsApp por mês, em reais (perto do teto a equipe fica sem análise completa; acima, modo rápido)
  TETO_IA_MES: Math.max(10, Number(env('TETO_IA_MES', '200')) || 200),
  COTACAO_DOLAR: Math.max(1, Number(env('COTACAO_DOLAR', '5.5')) || 5.5),
  IDADE_MAX_MSG_MIN: Number(env('IDADE_MAX_MSG_MIN', '60')),
  USUARIOS_JSON: env('USUARIOS'),                          // [{"nome":"Danilo","telefone":"5592...","papel":"dono"}]
  // gravar no PedidoOK pelo WhatsApp (mesmas regras do programa: cada perfil na sua área, sempre com "confirmar"). 0 desliga.
  ACOES_PEDIDOOK: env('ACOES_PEDIDOOK', '1') !== '0',
  SAUDE_TOKEN: env('SAUDE_TOKEN'),                         // opcional: libera o /saude detalhado (?token=...)
  // só para testes locais: aceita webhook sem assinatura. Nunca vale em produção.
  INSEGURO_TESTE: !PRODUCAO && env('INSEGURO_TESTE') === '1'
};
