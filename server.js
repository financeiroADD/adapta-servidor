// Servidor do agente da Adapta: recebe as mensagens do WhatsApp (Meta), consulta os dados do PedidoOK e responde.
'use strict';
const http = require('http');
const crypto = require('crypto');
const cfg = require('./config');
const SEG = require('./seguranca');
const wa = require('./whatsapp');
const U = require('./usuarios');
const agente = require('./agente');
const TR = require('./transcricao');
const { Dados } = require('./dados');

const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on('uncaughtException', e => log('ERRO não tratado:', e && e.stack || e));
process.on('unhandledRejection', e => log('Promessa rejeitada:', e && e.stack || e));

const dados = new Dados();
let usuarios = U.carregar();
setInterval(() => { usuarios = U.carregar(); }, 60000);   // dá para editar usuarios.json sem reiniciar

const vistos = new Set();           // ids de mensagens já tratadas (a Meta pode reenviar)
const filas = new Map();            // uma fila por pessoa: as respostas saem na ordem certa
const mascarar = t => '***' + String(t || '').slice(-4);

function naFila(chave, fn) {
  const ant = filas.get(chave) || Promise.resolve();
  const prox = ant.then(fn, fn).catch(e => log('erro na fila', e && e.message));
  filas.set(chave, prox); prox.finally(() => { if (filas.get(chave) === prox) filas.delete(chave); });
}

// Nota de voz: baixa da Meta, transcreve e responde como se a pessoa tivesse digitado.
// "confirmar" por áudio não grava no PedidoOK (a não ser com AUDIO_CONFIRMA=1): a gravação pede o "confirmar" digitado.
const CONFIRMAR_POR_VOZ = /^(confirmar|confirmo|confirma|confirmado|pode gravar|grava|gravar)[\s!.]*$/i;
async function responderAudio(m, u) {
  if (!TR.ligada()) return 'Ainda não consigo ouvir áudio. Pode mandar a pergunta por escrito?';
  let ouvido;
  try {
    if (!TR.extensaoDe(m.mime)) return 'Não consigo ouvir esse formato de áudio. Grave uma nota de voz pelo microfone do WhatsApp ou mande por escrito.';
    const midia = await wa.baixarMidia(m.midiaId);
    ouvido = await TR.transcrever({ buffer: midia.buffer, mime: midia.mime || m.mime });
  } catch (e) {
    log('áudio não transcrito', mascarar(m.de), e && e.message);
    if (e && e.longo) return 'Esse áudio ficou longo demais para eu ouvir. Grave um áudio mais curto ou mande por escrito.';
    if (e && e.formato) return 'Não consigo ouvir esse formato de áudio. Grave uma nota de voz pelo microfone do WhatsApp ou mande por escrito.';
    return 'Não consegui ouvir esse áudio agora. Pode tentar de novo ou mandar por escrito?';
  }
  if (!ouvido) return 'Não consegui entender o áudio (parece vazio ou com muito barulho). Pode gravar de novo ou mandar por escrito?';
  m.ouvido = ouvido;
  log('áudio transcrito', mascarar(m.de), u.papel, ouvido.length + ' caracteres');
  if (!cfg.TRANSCRICAO.confirmarPorAudio && CONFIRMAR_POR_VOZ.test(ouvido.trim()))
    return 'Por segurança, gravar no PedidoOK só vale com o *confirmar* digitado. Digite *confirmar* para gravar ou *cancelar*.';
  return agente.responder({ dados, usuario: u, texto: ouvido });
}

async function tratar(m) {
  if (!m.id || vistos.has(m.id)) return;
  vistos.add(m.id); if (vistos.size > 5000) vistos.delete(vistos.values().next().value);
  if (m.phoneId && cfg.WHATSAPP.phoneId && m.phoneId !== cfg.WHATSAPP.phoneId) return;
  if (m.ts && Date.now() / 1000 - m.ts > cfg.IDADE_MAX_MSG_MIN * 60) { log('mensagem antiga ignorada', mascarar(m.de)); return; }
  const chave = U.chaveTelefone(m.de);
  const u = usuarios.get(chave);
  if (!u) { log('número NÃO autorizado, ignorado', mascarar(m.de)); return; }   // não responde: não revela que o agente existe
  if (u.papel !== 'dono' && SEG.bloqueado(chave)) {         // bloqueado: não gasta IA; avisa no máximo uma vez por dia
    log('mensagem de número bloqueado', mascarar(m.de));
    if (SEG.deveAvisarBloqueado(chave)) naFila(chave, () => wa.enviarTexto(m.de, 'Seu acesso ao Adaptus está bloqueado por segurança. Só o Danilo pode liberar.'));
    return;
  }
  naFila(chave, async () => {
    await wa.marcarComoLida(m.id);
    let resp;
    if (m.texto) resp = await agente.responder({ dados, usuario: u, texto: m.texto });
    else if (m.tipo === 'image') resp = 'Recebi a imagem. A leitura de print de pedido por aqui chega na próxima etapa. Por enquanto, mande o pedido em texto ou use o programa.';
    else if (m.tipo === 'audio') resp = await responderAudio(m, u);
    else resp = 'Por enquanto eu só entendo mensagens de texto.';
    let texto = typeof resp === 'string' ? resp : resp.texto;
    if (m.tipo === 'audio' && m.ouvido) texto = `🎤 _Entendi:_ "${m.ouvido.length > 300 ? m.ouvido.slice(0, 300) + '…' : m.ouvido}"\n\n` + texto;
    await wa.enviarTexto(m.de, wa.paraWhatsApp(texto));
    if (resp && resp.banido) { log('SEGURANÇA: acesso bloqueado', mascarar(m.de), u.papel); avisarDonos(u, chave, resp.ocorrencia).catch(e => log('aviso ao dono falhou', e && e.message)); }
    else if (resp && resp.bloqueado) log('SEGURANÇA: mensagem barrada', mascarar(m.de), u.papel);
    else log('respondido', mascarar(m.de), u.papel, typeof resp === 'string' ? 'resposta-curta' : 'ferramentas=' + [...new Set(resp.ferramentas || [])].join(','));
  });
}

// Quando alguém é bloqueado, o Dono fica sabendo na hora pelo WhatsApp.
async function avisarDonos(u, chave, oc) {
  const donos = [...usuarios.values()].filter(x => x.papel === 'dono' && U.chaveTelefone(x.telefone) !== chave);
  const fim = String(chave).slice(-4);
  const txt = `*Adaptus, aviso de segurança*\nO acesso de ${u.nome} (final ${fim}) foi bloqueado.\nMotivo: ${oc ? oc.motivo : 'tentativa grave'}.` +
    (oc && oc.mensagem ? `\nMensagem: "${String(oc.mensagem).slice(0, 300)}"` : '') + `\n\nPara liberar, responda: *liberar ${u.nome.split(' ')[0]}*`;
  for (const d of donos) {
    let n = String(d.telefone).replace(/\D/g, ''); if (n.length <= 11) n = '55' + n;
    try { await wa.enviarTexto(n, txt); }
    catch (e) {
      // Fora da janela de 24 horas (o Dono não escreveu para o agente hoje) a Meta só aceita modelo aprovado.
      log('aviso ao dono por texto recusado; tentando o modelo aprovado', e && e.message);
      try { await wa.enviarModelo(n, cfg.WHATSAPP.modeloAviso, cfg.WHATSAPP.modeloIdioma, [String(u.nome).split(' ')[0], fim]); log('aviso ao dono enviado pelo modelo', cfg.WHATSAPP.modeloAviso); }
      catch (e2) { log('aviso ao dono NÃO entregue (confira se o modelo "' + cfg.WHATSAPP.modeloAviso + '" está aprovado na Meta)', e2 && e2.message); }
    }
  }
}

function lerCorpo(req, max = 1024 * 1024) {
  return new Promise((ok, erro) => {
    if (Number(req.headers['content-length']) > max) return erro(new Error('corpo grande demais'));
    const partes = []; let n = 0, estourou = false;
    req.on('data', c => { if (estourou) return; n += c.length; if (n > max) { estourou = true; partes.length = 0; erro(new Error('corpo grande demais')); } else partes.push(c); });
    req.on('end', () => { if (!estourou) ok(Buffer.concat(partes)); });
    req.on('error', erro);
  });
}
// Cabeçalhos de segurança em toda resposta (o servidor não serve páginas; nada pode ser embutido nem guardado em cache)
const CABECALHOS = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
const responder = (res, code, corpo, tipo = 'text/plain; charset=utf-8') => { res.writeHead(code, Object.assign({ 'Content-Type': tipo }, CABECALHOS)); res.end(corpo); };
const igual = (a, b) => { const h = x => crypto.createHash('sha256').update(String(x || '')).digest(); return !!a && !!b && crypto.timingSafeEqual(h(a), h(b)); };
// registro de webhooks recusados sem inundar o log
let recusas = { n: 0, desde: Date.now() };
function logRecusa(motivo) {
  if (Date.now() - recusas.desde > 600e3) { if (recusas.n > 20) log(`webhook: mais ${recusas.n - 20} recusas nos últimos 10 min`); recusas = { n: 0, desde: Date.now() }; }
  if (++recusas.n <= 20) log('webhook rejeitado:', motivo);
}

const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/saude') {
      // público: só se está de pé. Detalhes apenas com SAUDE_TOKEN (?token=...)
      const base = { ok: true, dados: dados.contagem().produtos > 0, ultimoSync: dados.ultimoSync };
      const detalhe = cfg.SAUDE_TOKEN && igual(url.searchParams.get('token'), cfg.SAUDE_TOKEN) ? { sincronizando: dados.sincronizando, ultimoErro: dados.ultimoErro, whatsapp: !!(cfg.WHATSAPP.token && cfg.WHATSAPP.phoneId), usuarios: usuarios.size, bloqueados: SEG.listarBloqueados().length } : {};
      return responder(res, 200, JSON.stringify(Object.assign(base, detalhe)), 'application/json');
    }
    if (url.pathname === '/webhook') {
      if (req.method === 'GET') {   // a Meta confere o endereço uma vez, ao cadastrar o webhook
        const desafio = url.searchParams.get('hub.challenge') || '';
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && igual(url.searchParams.get('hub.verify_token'), cfg.WHATSAPP.verifyToken) && /^[A-Za-z0-9._-]{1,128}$/.test(desafio);
        return ok ? responder(res, 200, desafio) : responder(res, 403, 'proibido');
      }
      if (req.method === 'POST') {
        let cru; try { cru = await lerCorpo(req, 1024 * 1024); } catch { logRecusa('corpo grande demais'); res.setHeader('Connection', 'close'); return responder(res, 413, 'grande demais'); }
        const assinado = wa.assinaturaValida(cru, req.headers['x-hub-signature-256']);
        if (!assinado && !(cfg.INSEGURO_TESTE && !cfg.WHATSAPP.appSecret)) { logRecusa('assinatura inválida'); return responder(res, 401, 'assinatura inválida'); }
        responder(res, 200, 'ok');      // responde rápido; a Meta reenvia se demorar
        let payload; try { payload = JSON.parse(cru.toString('utf8')); } catch { return; }
        const { mensagens, falhas } = wa.lerMensagens(payload);
        for (const f of falhas) log('ENTREGA FALHOU', mascarar(f.para), f.erros.join('; '));
        for (const m of mensagens) tratar(m).catch(e => log('erro ao tratar mensagem', e && e.message));
        return;
      }
    }
    responder(res, 404, 'não encontrado');
  } catch (e) { log('erro http', e && e.message); try { responder(res, 500, 'erro'); } catch {} }
});

// tempos-limite contra conexões lentas de propósito (slowloris)
servidor.requestTimeout = 30000; servidor.headersTimeout = 15000; servidor.keepAliveTimeout = 5000; servidor.maxHeadersCount = 60; servidor.maxRequestsPerSocket = 100;
servidor.listen(cfg.PORT, () => {
  log(`Servidor do agente no ar na porta ${cfg.PORT}`);
  const falta = [];
  if (!cfg.WHATSAPP.appSecret) falta.push('WHATSAPP_APP_SECRET');
  if (!cfg.WHATSAPP.verifyToken) falta.push('WHATSAPP_VERIFY_TOKEN');
  if (!cfg.WHATSAPP.token) falta.push('WHATSAPP_TOKEN');
  if (!cfg.WHATSAPP.phoneId) falta.push('WHATSAPP_PHONE_ID');
  if (!cfg.ANTHROPIC_KEY) falta.push('ANTHROPIC_API_KEY');
  if (!dados.temTokens()) falta.push('PEDIDOOK_TOKEN_PARCEIRO/PEDIDOOK_TOKEN');
  if (falta.length) log('ATENÇÃO, faltam variáveis:', falta.join(', '));
  if (cfg.WHATSAPP.verifyToken && cfg.WHATSAPP.verifyToken.length < 16) log('ATENÇÃO: WHATSAPP_VERIFY_TOKEN curto; use 16 caracteres ou mais.');
  if (!cfg.PRODUCAO) log('Modo de teste (NODE_ENV diferente de production).');
  log('Pessoas autorizadas:', usuarios.size);
  log('Áudio:', TR.ligada() ? `ligado (transcrição ${cfg.TRANSCRICAO.modelo}${cfg.TRANSCRICAO.confirmarPorAudio ? ', "confirmar" por voz liberado' : ''})` : 'desligado (falta OPENAI_API_KEY)');
  dados.agendar();
});
module.exports = { servidor, dados, tratar };
