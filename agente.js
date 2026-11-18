// O "cérebro" da conversa: lembra o assunto, aplica o perfil da pessoa, passa cada mensagem pela guarda e chama a IA.
'use strict';
const cfg = require('./config');
const U = require('./usuarios');
const SEG = require('./seguranca');
let IA; try { IA = require('./ia'); } catch { IA = require('../app/ia'); }
let G; try { G = require('./guarda'); } catch { G = require('../app/guarda'); }
let CUSTO; try { CUSTO = require('./custoia'); } catch { CUSTO = require('../app/custoia'); }
let ACOES; try { ACOES = require('./acoes'); } catch { ACOES = require('../app/acoes'); }
const crypto = require('crypto');

// Ações no PedidoOK pelo WhatsApp: o Adaptus prepara, o servidor mostra o resumo e só grava se a pessoa responder
// "confirmar" (vale 30 minutos). Mesmas regras do programa: cada perfil na sua área; excluir e preço de venda só o Dono.
const PEND = new Map();          // pessoa -> [{ id, acao, plano, criado }]
const usoGrav = new Map();       // pessoa -> horários das gravações (freio por hora)
const VIDA_ACAO = 30 * 60e3;
const QUER_CONFIRMAR = /^(confirmar|confirmo|confirma|confirmado|pode gravar|grava|gravar)[\s!.]*$/i;
const QUER_CANCELAR = /^(cancelar|cancela|cancelado|desistir|desisto|n[aã]o grava|n[aã]o gravar)[\s!.]*$/i;
const acoesDoPerfil = papel => cfg.ACOES_PEDIDOOK ? ACOES.acoesDo(papel) : [];
function pendentesDe(chave) {
  const l = (PEND.get(chave) || []).filter(p => Date.now() - p.criado < VIDA_ACAO);
  if (l.length) PEND.set(chave, l); else PEND.delete(chave);
  return l;
}
async function confirmarPendentes(dados, usuario, chave) {
  const lista = pendentesDe(chave); PEND.delete(chave);
  const linhas = []; let gravou = false;
  for (const p of lista) {
    if (!ACOES.permitido(usuario.papel, p.acao)) { linhas.push(`• ${p.plano.titulo}: seu perfil não pode fazer isso.`); continue; }
    const h = (usoGrav.get(chave) || []).filter(x => Date.now() - x < 3600e3), lim = usuario.papel === 'dono' ? 120 : 40;
    if (h.length >= lim) { linhas.push(`• ${p.plano.titulo}: limite de ${lim} gravações por hora.`); continue; }
    const r = await ACOES.executar(p.plano, (m, rota, corpo) => dados.requisitar(m, rota, corpo));
    dados.registrarAcao({ quem: usuario.nome, papel: usuario.papel, canal: 'whatsapp', acao: p.acao, titulo: p.plano.titulo, ok: r.ok, erro: r.ok ? undefined : String(r.erro).slice(0, 200) });
    if (!r.ok) { linhas.push(`• ${p.plano.titulo}: *não gravou* (${r.erro}).`); continue; }
    h.push(Date.now()); usoGrav.set(chave, h); gravou = true;
    if (p.plano.metodo === 'DELETE') dados.lembrarExcluido(p.plano);
    if (/\/undelete$/.test(p.plano.rota)) dados.esquecerExcluido(p.plano);
    const num = p.plano.metodo === 'POST' && p.plano.recurso === 'pedidos' && r.numero ? ` (nº ${r.numero})` : '';
    linhas.push(`• ${p.plano.titulo}${num}: ${r.jaFeito ? 'já estava gravado (não duplicou)' : 'gravado'}.`);
    console.log(new Date().toISOString(), 'ação no PedidoOK feita:', p.acao, usuario.papel, '***' + String(chave).slice(-4));
  }
  if (gravou) { try { await Promise.race([dados.sincronizar('acao'), new Promise(ok => setTimeout(ok, 30000))]); } catch {} }
  return (gravou ? '*PedidoOK atualizado:*\n' : '') + linhas.join('\n');
}
function textoConfirmacao(lista) {
  const blocos = lista.map((p, i) => `*${lista.length > 1 ? (i + 1) + '. ' : ''}${p.plano.titulo}*\n${p.plano.linhas.slice(0, 12).map(l => '• ' + l).join('\n')}`);
  return `\n\n*Para gravar no PedidoOK, confira:*\n${blocos.join('\n\n')}\n\nResponda *confirmar* para gravar (vale por 30 minutos) ou *cancelar*. Nada foi gravado ainda.`;
}

// Gasto da IA no mês (este servidor): cada chamada passa pelo medidor; fica guardado no config.json do servidor.
let gastoIA = null, dadosRef = null, tGravar = null;
IA.definirMedidor(x => {
  try {
    gastoIA = CUSTO.registrarChamada(gastoIA || (dadosRef && dadosRef.config && dadosRef.config.gastoIA), { usd: x.usd || 0, uso: x.uso });
    if (dadosRef && dadosRef.config) { dadosRef.config.gastoIA = gastoIA; clearTimeout(tGravar); tGravar = setTimeout(() => { try { dadosRef.salvarConfig(); } catch {} }, 2000); }
  } catch {}
});
function faixaDoMes() {
  const r = CUSTO.resumo(gastoIA || (dadosRef && dadosRef.config && dadosRef.config.gastoIA), { teto: cfg.TETO_IA_MES, cotacao: cfg.COTACAO_DOLAR });
  return r;
}
const QUER_COMPLETA = /^(completa|a completa|analise completa|análise completa|aprofundar|aprofunda|pode aprofundar|quero a completa|faz a completa|faça a completa)[\s!.]*$/i;
const CONFIRMA = /^(sim|pode|pode sim|quero|faz|faça|manda|bora|isso)[\s!.]*$/i;

const conversas = new Map();   // pessoa -> { msgs, ult }
const usos = new Map();        // pessoa -> horários das mensagens das últimas 24 horas
const VALE = 4 * 3600 * 1000;  // depois de 4 horas parado, começa assunto novo

const EXEMPLOS = {
  dono: ['Quanto vendi esse mês comparado com o mês passado?', 'Quais produtos vão faltar?', 'O que preciso comprar essa semana?', 'Quem está me devendo?', 'Quais clientes pararam de comprar?', 'Como está a margem por vendedor?'],
  compras: ['Quais produtos vão faltar?', 'O que preciso comprar da Limpex?', 'Quanto tem em estoque de detergente 5L?'],
  financeiro: ['Quem está me devendo?', 'O que vence nos próximos 7 dias?', 'Como está o cliente Hotel Aurora?'],
  vendas: ['Tem detergente neutro 5L em estoque?', 'Quanto custa o papel toalha?', 'Quais produtos estão acabando?']
};
function ajuda(u) {
  return `Olá, ${u.nome}! Aqui é o Adaptus, o assistente da ADD Clean. Eu consulto os dados do PedidoOK${acoesDoPerfil(u.papel).length ? ' e, quando você pedir, preparo mudanças lá (orçamento, cadastro, baixa), que só gravo depois de você responder *confirmar*' : ''}. Pode perguntar, por exemplo:\n${(EXEMPLOS[u.papel] || EXEMPLOS.vendas).map(x => '• ' + x).join('\n')}\n\nDigite *novo* para começar um assunto do zero.` +
    (u.papel === 'dono' ? '\n\nSegurança: *ocorrências* mostra o que foi barrado; *liberar Nome* devolve o acesso de quem foi bloqueado. *custo da IA* mostra quanto a IA gastou no mês.' : '');
}

function dentroDoLimite(chave) {
  const agora = Date.now(); const l = (usos.get(chave) || []).filter(t => agora - t < 864e5);
  const naHora = l.filter(t => agora - t < 3600e3).length;
  if (naHora >= cfg.LIMITE_MSG_HORA) { usos.set(chave, l); return `Você chegou ao limite de ${cfg.LIMITE_MSG_HORA} mensagens por hora. Tente de novo daqui a pouco.`; }
  if (l.length >= cfg.LIMITE_MSG_DIA) { usos.set(chave, l); return `Você chegou ao limite de ${cfg.LIMITE_MSG_DIA} mensagens por dia. Amanhã libera de novo.`; }
  l.push(agora); usos.set(chave, l); return null;
}

const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CAT = { destruicao: 'pediu para apagar dados', alteracao: 'pediu para alterar dados', injecao: 'tentou burlar as regras', segredos: 'pediu senhas ou chaves', exfiltracao: 'tentou tirar dados da empresa', abuso: 'conteúdo malicioso', injecao_indireta: 'texto suspeito num cadastro' };
const ACAO = { banir: 'acesso bloqueado', bloquear: 'mensagem barrada', permitir: 'só registrado', aviso: 'aviso', liberado: 'acesso liberado' };
const final4 = t => String(t || '').replace(/\D/g, '').slice(-4);

// Comandos de segurança que só o Dono usa pelo WhatsApp
function comandoDono(usuario, t) {
  const v = semAcento(t).trim();
  if (/^(custo|custo da ia|custo ia|gasto da ia|gastos da ia|gasto ia)$/.test(v)) {
    const r = faixaDoMes(), f = n => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `*Gasto da IA no WhatsApp (${r.mes}):* ${f(r.gasto)} de ${f(r.teto)} (${String(r.pct).replace('.', ',')}%).` + (r.projecao != null ? `\nNo ritmo atual, o mês fecha em cerca de ${f(r.projecao)}.` : '') +
      `\nRápidas: ${r.perguntas.rapida.n} (${f(r.perguntas.rapida.valor)}) • Dia a dia: ${r.perguntas.normal.n} (${f(r.perguntas.normal.valor)}) • Completas: ${r.perguntas.completa.n} (${f(r.perguntas.completa.valor)})`;
  }
  if (/^(ocorrencias|seguranca|bloqueados)$/.test(v)) {
    const oc = SEG.ultimas(10), bl = SEG.listarBloqueados();
    const linhas = [];
    linhas.push(bl.length ? '*Bloqueados:* ' + bl.map(b => `${b.nome} (final ${final4(b.chave)})`).join(', ') : '*Bloqueados:* ninguém');
    linhas.push('');
    linhas.push(oc.length ? '*Últimas ocorrências:*' : 'Nenhuma ocorrência registrada.');
    for (const o of oc) linhas.push(`• ${new Date(o.em).toLocaleString('pt-BR', { timeZone: cfg.FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${o.nome || '?'}: ${CAT[o.categoria] || o.categoria}, ${ACAO[o.acao] || o.acao}${o.mensagem ? ` ("${String(o.mensagem).slice(0, 80)}")` : ''}`);
    if (bl.length) linhas.push('', 'Para liberar: *liberar Nome* ou *liberar* e os 4 últimos números do telefone.');
    return linhas.join('\n');
  }
  const m = v.match(/^(liberar|desbloquear)\s+(.{2,60})$/);
  if (m) {
    const alvo = m[2].trim(), dig = alvo.replace(/\D/g, '');
    const achados = SEG.listarBloqueados().filter(b => (dig.length >= 4 && b.chave.endsWith(dig)) || (!dig && semAcento(b.nome).includes(alvo)));
    if (!achados.length) return 'Não achei ninguém bloqueado com esse nome. Mande *ocorrências* para ver a lista.';
    if (achados.length > 1) return 'Achei mais de uma pessoa: ' + achados.map(b => `${b.nome} (final ${final4(b.chave)})`).join(', ') + '. Use os 4 últimos números do telefone.';
    SEG.liberar(achados[0].chave, usuario.nome);
    return `Pronto, o acesso de ${achados[0].nome} foi liberado.`;
  }
  return null;
}

async function responder({ dados, usuario, texto }) {
  const chave = U.chaveTelefone(usuario.telefone);
  const t = String(texto || '').trim().slice(0, 4000);
  if (!t) return 'Não entendi a mensagem. Pode escrever de novo?';
  if (/^(novo|nova conversa|limpar|reiniciar|recome[cç]ar)$/i.test(t)) { conversas.delete(chave); return 'Pronto, começamos do zero. O que você quer saber?'; }
  if (/^(ajuda|menu|comandos|\?)$/i.test(t)) return ajuda(usuario);
  if (usuario.papel === 'dono') { const r = comandoDono(usuario, t); if (r) return r; }
  // confirmar ou cancelar o que o Adaptus preparou (não passa pela IA)
  if (QUER_CONFIRMAR.test(t) || QUER_CANCELAR.test(t)) {
    const pend = pendentesDe(chave);
    if (pend.length && QUER_CONFIRMAR.test(t)) {
      if (!cfg.ACOES_PEDIDOOK) { PEND.delete(chave); return 'Gravar no PedidoOK pelo WhatsApp está desligado no servidor.'; }
      return confirmarPendentes(dados, usuario, chave);
    }
    if (pend.length) { PEND.delete(chave); return 'Cancelado. Nada foi gravado no PedidoOK.'; }
    if (QUER_CONFIRMAR.test(t)) return 'Não há nada esperando confirmação (vale por 30 minutos depois do resumo). Peça de novo o que quer gravar.';
  }
  if (!cfg.ANTHROPIC_KEY) return 'O Adaptus ainda não está com a chave da IA configurada no servidor.';
  const limite = dentroDoLimite(chave); if (limite) return limite;

  // guarda de entrada: regras + classificador -> política (bloqueia quem pede para apagar os dados da empresa)
  const comAcoes = acoesDoPerfil(usuario.papel).length > 0;
  const { regra, classe } = await IA.guardar({ chave: cfg.ANTHROPIC_KEY, cfg: dados.config, salvarCfg: () => dados.salvarConfig() }, t, { papel: usuario.papel, acoes: comAcoes });
  const dec = G.decidir({ regra, classe, papel: usuario.papel, ocorrenciasRecentes: SEG.reincidencias(chave), acoes: comAcoes });
  if (dec.acao !== 'permitir' || dec.anotar) {
    const oc = SEG.registrar({ usuarioId: chave, nome: usuario.nome, papel: usuario.papel, categoria: dec.categoria, gravidade: dec.gravidade, acao: dec.acao, motivo: dec.motivo, mensagem: t,
      regra: { c: regra.categoria, g: regra.gravidade, disfarce: regra.disfarce }, classificador: classe ? { c: classe.categoria, g: classe.gravidade } : null });
    if (dec.acao === 'banir') { SEG.bloquear(chave, usuario.nome, dec.motivo, oc.id); conversas.delete(chave); return { texto: dec.mensagem, banido: true, ocorrencia: oc }; }
    if (dec.acao === 'bloquear') {
      const aviso = usuario.papel !== 'dono' && SEG.reincidencias(chave) === 2 ? ' Se acontecer de novo, o acesso será bloqueado.' : '';
      return { texto: dec.mensagem + aviso, bloqueado: true };
    }
  }

  let c = conversas.get(chave);
  if (!c || Date.now() - c.ult > VALE) { c = { msgs: [], ult: Date.now() }; conversas.set(chave, c); }
  dadosRef = dados;
  // Nível da resposta. No WhatsApp não há janela: pergunta grande sai resumida com o convite "responda completa",
  // que funciona como o aviso de custo do programa. "completa" (ou "sim" logo depois do convite) faz a análise.
  let pergunta = t, nivel, convite = '';
  if (c.aprofundar && (QUER_COMPLETA.test(t) || CONFIRMA.test(t))) { nivel = 'completa'; pergunta = 'Faça agora a análise completa da minha pergunta anterior: ' + c.aprofundar; c.aprofundar = null; }
  else {
    c.aprofundar = null;
    nivel = CUSTO.classificarPergunta(t, { anterior: c.nivel }).nivel;
    if (nivel === 'completa') { nivel = 'normal'; c.aprofundar = t.slice(0, 600); convite = '\n\nEssa pergunta pede uma análise completa, que gasta mais da IA. Mandei o resumo; se quiser a análise completa, responda *completa*.'; }
  }
  const mes = faixaDoMes();
  const pol = CUSTO.politica({ papel: usuario.papel, faixa: mes.faixa, pedido: nivel });
  if (pol.nivel !== 'completa' && convite && CUSTO.politica({ papel: usuario.papel, faixa: mes.faixa, pedido: 'completa' }).nivel !== 'completa') { convite = ''; c.aprofundar = null; }
  c.msgs.push({ role: 'user', content: pergunta }); c.ult = Date.now();
  const papel = U.PAPEIS[usuario.papel] || U.PAPEIS.vendas;
  const criadas = [];
  const prepararAcao = d => {
    d = d && typeof d === 'object' ? d : {};
    const eng = dados.engine();
    const r = ACOES.preparar(String(d.acao || '').slice(0, 60), d.dados, { papel: usuario.papel, engine: eng, descontoMaximo: dados.config.orcamento && dados.config.orcamento.descontoMaximo != null ? dados.config.orcamento.descontoMaximo : 3, hoje: eng.hoje, usuarioNome: usuario.nome, todos: x => dados.todos(x), excluidos: x => dados.excluidos(x) });
    if (!r.ok) return { erro: r.erro };
    const lista = pendentesDe(chave); while (lista.length >= 5) lista.shift();
    const p = { id: crypto.randomBytes(6).toString('hex'), acao: r.plano.acao, plano: r.plano, criado: Date.now() };
    lista.push(p); PEND.set(chave, lista); criadas.push(p);
    return { preparada: true, titulo: r.plano.titulo, resumo: r.plano.linhas, aviso: 'Ainda NÃO foi gravado. O sistema vai mostrar este resumo e pedir para a pessoa responder "confirmar". Não repita o resumo inteiro: diga em uma frase o que preparou.' };
  };
  const r = await IA.conversar({
    acoes: comAcoes, prepararAcao,
    chave: cfg.ANTHROPIC_KEY, cfg: dados.config, salvarCfg: () => dados.salvarConfig(),
    engine: () => dados.engine(), historico: c.msgs, ultimoSync: dados.ultimoSync, nivel: pol.nivel, economia: pol.economia,
    canal: 'whatsapp', usuario, ferramentasPermitidas: papel.ferramentas, filtrarResultado: U.filtrador(usuario.papel),
    segredos: [cfg.ANTHROPIC_KEY, cfg.PEDIDOOK.tokenParceiro, cfg.PEDIDOOK.token, cfg.WHATSAPP.token, cfg.WHATSAPP.appSecret, cfg.WHATSAPP.verifyToken].filter(Boolean),
    aoDadoSuspeito: d => SEG.registrar({ usuarioId: null, nome: usuario.nome, papel: usuario.papel, categoria: 'injecao_indireta', gravidade: 2, acao: 'aviso', motivo: 'Um dado do PedidoOK tem texto que parece uma ordem para a IA (' + d.motivo + ').', mensagem: d.trecho })
  });
  if (r.custo) { try { gastoIA = CUSTO.registrarPergunta(gastoIA || dados.config.gastoIA, { usd: r.custo.usd || 0, nivel: r.custo.nivel || pol.nivel, quem: usuario.nome }); dados.config.gastoIA = gastoIA; } catch {} }
  if (!r.ok) { c.msgs.pop(); c.aprofundar = null; return r.tentarDeNovo ? r.erro : 'Não consegui consultar agora: ' + r.erro; }
  c.nivel = (r.custo && r.custo.nivel) || pol.nivel;
  c.msgs.push({ role: 'assistant', content: r.texto });
  if (c.msgs.length > 20) c.msgs.splice(0, c.msgs.length - 20);
  const aviso = pol.aviso ? '\n\n_' + pol.aviso + '_' : '';
  const confirmar = criadas.length ? textoConfirmacao(criadas) : '';
  return { texto: r.texto + confirmar + (r.vazio || r.semIA || confirmar ? '' : convite) + aviso, ferramentas: r.ferramentas, nivel: c.nivel, acoes: criadas.length };
}
module.exports = { responder, ajuda };
