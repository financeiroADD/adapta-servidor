// Transcreve áudios do WhatsApp (notas de voz) com a API de transcrição da OpenAI.
// O texto transcrito segue o mesmo caminho do texto digitado: guarda de segurança, perfil, limites e custo.
// Sem dependências: usa fetch, FormData e Blob do próprio Node (20 ou mais novo).
'use strict';
const cfg = require('./config');
const T = cfg.TRANSCRICAO;

// Formatos que a API aceita. O WhatsApp manda nota de voz como "audio/ogg; codecs=opus".
const EXTENSOES = {
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac'
};
const extensaoDe = mime => EXTENSOES[String(mime || '').split(';')[0].trim().toLowerCase()] || null;

const ligada = () => !!T.chave;

// Palavras do dia a dia da empresa ajudam a transcrição a acertar nomes e termos.
const DICA = 'Conversa de trabalho em português do Brasil, numa distribuidora de produtos de limpeza em Manaus. ' +
  'Termos comuns: Adaptus, PedidoOK, orçamento, pedido, cliente, fornecedor, estoque, cobrança, boleto, PIX, margem, faturamento, ' +
  'detergente, desinfetante, papel toalha, papel higiênico, saco de lixo, galão, caixa, fardo, unidade.';

async function transcrever({ buffer, mime }) {
  if (!ligada()) throw new Error('transcrição desligada (falta OPENAI_API_KEY)');
  const ext = extensaoDe(mime);
  if (!ext) { const e = new Error('formato de áudio não aceito: ' + mime); e.formato = true; throw e; }
  if (!buffer || !buffer.length) throw new Error('áudio vazio');
  if (buffer.length > T.maxBytes) { const e = new Error('áudio longo demais'); e.longo = true; throw e; }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: String(mime).split(';')[0].trim() }), 'audio.' + ext);
  form.append('model', T.modelo);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  form.append('prompt', DICA);

  // sem seguir redirecionamento: a chave nunca vai para outro endereço
  const r = await fetch(T.base + '/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + T.chave }, body: form,
    redirect: 'error', signal: AbortSignal.timeout(60000)
  });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
  if (!r.ok) {
    const msg = (j && j.error && (j.error.message || j.error.code)) || txt.slice(0, 200);
    const e = new Error('transcrição ' + r.status + ': ' + String(msg).slice(0, 200)); e.status = r.status; throw e;
  }
  return String((j && j.text) || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

module.exports = { transcrever, ligada, extensaoDe };
