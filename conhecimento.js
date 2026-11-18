// Conhecimento da empresa (ADD Clean) que o Adaptus carrega de fábrica.
// Cada fato traz o seu grau de certeza, para o agente nunca transformar proposta em fato:
//   confirmado = dito pelo gestor | regra = regra de negócio definida | historico = exemplo antigo
//   proposta = em avaliação, não decidido | validar = ainda não se sabe | verificado = conferido no sistema ou nos dados
// O que a equipe ensinar no dia a dia continua indo para o "aprendizado" (revisado pelo Dono); este arquivo é a base fixa.
// Não guarda nomes de clientes, valores de casos antigos nem dados bancários.
'use strict';

const VERSAO = { versao: '2.2', data: '2026-11-16' };

const ESTADOS = {
  confirmado: 'confirmado pelo gestor',
  regra: 'regra de negócio definida',
  historico: 'exemplo ou histórico, não é situação atual',
  proposta: 'proposta em avaliação, não decidido',
  validar: 'a validar, ainda não se sabe',
  verificado: 'conferido no sistema ou nos dados'
};

const TODOS = null;
const FIN = ['dono', 'financeiro'];
const COMP = ['dono', 'compras'];

const I = (id, estado, temas, texto, extra = {}) => Object.assign({ id, estado, temas: [].concat(temas), texto, papeis: TODOS }, extra);

// implementado: sim | parcial | nao (para o Adaptus saber o que o sistema já faz de fato)
const ITENS = [
  // ---------- empresa ----------
  I('E1', 'confirmado', 'empresa', 'Razão social D A Comércio de Produtos de Limpeza Ltda.; nome fantasia ADD Clean; sede em Manaus, Amazonas.'),
  I('E2', 'confirmado', 'empresa', 'CNPJ 30.246.255/0001-08. Regime tributário: Lucro Presumido (informado pelo gestor). O tratamento tributário de cada operação precisa ser validado pela contabilidade.', { papeis: FIN }),
  I('E3', 'confirmado', 'empresa', 'Atua principalmente no B2B, como distribuidora e fornecedora de suprimentos empresariais: limpeza, higiene, descartáveis, papéis, materiais de expediente, EPI, embalagens e itens diversos.'),
  I('E4', 'confirmado', 'empresa', 'Funciona também como extensão do setor de compras do cliente: localiza, cota, compra e entrega suprimentos, inclusive itens específicos ou urgentes. Vende a prazo mediante análise de crédito.'),
  I('E5', 'confirmado', 'empresa', 'Cerca de 20 colaboradores (declaração anterior), nas áreas de vendas, compras, estoque, financeiro, faturamento e logística.'),
  I('E6', 'historico', 'empresa', 'Cerca de 700 m², a maior parte de estoque. Havia plano de alugar o imóvel vizinho para ampliar o espaço, mas isso era planejamento, não obra concluída.'),
  I('E7', 'proposta', 'empresa', 'O gestor avalia mudar a marca para "Adapta Distribuidora" (ou só Adapta), porque ADD Clean passa a ideia de que só vende limpeza. NÃO está decidido: faltam checagem de marca no INPI, domínio e viabilidade jurídica e societária. Não diga que a empresa mudou de nome.'),

  // ---------- sistemas e fontes ----------
  I('S1', 'confirmado', ['empresa', 'sistema'], 'O sistema de gestão (ERP) é o PedidoOK: produtos, clientes, orçamentos, pedidos, cobranças, parcelas e relatórios. O módulo de compras do PedidoOK não é usado; compras, fornecedores e prazos eram registrados à mão e agora ficam no Adaptus.'),
  I('S2', 'verificado', ['empresa', 'sistema'], 'O Adaptus lê o PedidoOK pela API (produtos, clientes, pedidos, cobranças e fornecedores) e sincroniza sozinho. Desde a versão 1.4.0 ele também prepara mudanças no PedidoOK (orçamentos, pedidos e itens, clientes, produtos, fornecedores e cobranças), que só são gravadas depois que a pessoa confirma; cada perfil grava só na sua área, e excluir é reversível (reativar). As gravações seguem a documentação oficial da API, mas ainda não foram testadas contra a conta real do PedidoOK.'),
  I('S3', 'regra', ['empresa', 'regras'], 'Fonte da verdade por assunto: produtos, clientes, orçamentos e pedidos vêm do PedidoOK; créditos bancários, dos extratos e comprovantes; parcelas e cobranças, dos títulos do PedidoOK conferidos com os arquivos do banco; cartões, do relatório da adquirente (bruto, taxas, líquido, lote e data); documentos fiscais, do XML oficial; preço e cotação de fornecedor, de registros datados com origem, unidade de compra e responsável.'),
  I('S4', 'regra', ['empresa', 'regras', 'financeiro'], 'Não existir cobrança no PedidoOK não prova que o cliente não pagou, e um pedido marcado "Pago" não substitui a conferência com o banco.'),

  // ---------- regras de negócio ----------
  I('RN-001', 'regra', ['regras', 'comercial'], 'Venda fechada: todo registro de tipo Pedido conta como venda, qualquer que seja a situação depois (pendente, faturado, pago, concluído, entregue). Orçamento não é venda fechada. Pedido não prova dinheiro recebido: venda, faturamento, título a receber e recebimento são coisas diferentes.', { implementado: 'sim', como: 'O número "Vendido" do Adaptus segue exatamente esta regra e bate com o PedidoOK.' }),
  I('RN-002', 'regra', ['regras', 'financeiro'], 'Baixa de pedido: só passar de Faturado para Pago no PedidoOK quando TODAS as parcelas da nota ou pedido estiverem quitadas e conferidas. Pagamento parcial não autoriza dar o pedido como Pago.', { papeis: FIN, implementado: 'parcial', como: 'O Adaptus mostra as parcelas e o que falta (cobrancas, titulos_do_cliente), mas não altera o PedidoOK.' }),
  I('RN-003', 'regra', ['regras', 'financeiro'], 'Conciliação: relacionar pedido, cobrança ou parcelas, documento fiscal e extrato ou recebimento, sem exigir que todos os vínculos já existam. Apontar pagamento de pedido sem cobrança, mas nunca inventar vínculo.', { papeis: FIN, implementado: 'nao' }),
  I('RN-004', 'regra', ['regras', 'financeiro'], 'Cartão: um crédito pode juntar várias vendas. Considerar valor bruto, taxas, valor líquido, data de liquidação, antecipação e lote. Não exigir um depósito para cada venda.', { papeis: FIN, implementado: 'nao' }),
  I('RN-005', 'regra', ['regras', 'financeiro'], 'Boleto (CNAB): os recebimentos podem aparecer somados por dia no extrato. Procurar combinações de títulos liquidados cuja soma bata com o valor do dia, respeitando data e tarifas. Combinação plausível é sugestão, nunca baixa definitiva.', { papeis: FIN, implementado: 'nao' }),
  I('RN-006', 'regra', ['regras', 'financeiro'], 'Resultado de conciliação: confirmado, sugerido com alta confiança, sugerido com média confiança, divergente, sem correspondência, já baixado ou requer revisão. Sempre mostrar a evidência. Correspondência incerta não gera baixa automática.', { papeis: FIN, implementado: 'nao' }),
  I('RN-007', 'regra', ['regras', 'custos_fiscal'], 'Preço se avalia pelo custo efetivo unitário (frete, tributos pertinentes, taxas, embalagem e unidade), pela margem e pelo histórico do cliente. O preço nominal de compra não é o custo final. Margem mínima e política de desconto ainda estão a validar.', { papeis: COMP, implementado: 'parcial', como: 'Usa custo e margem cadastrados no PedidoOK; o custo efetivo com frete e tributos ainda não existe.' }),
  I('RN-008', 'regra', ['regras', 'compras_estoque'], 'Reposição considera saídas (giro), estoque utilizável, pedidos pendentes, prazo do fornecedor, estoque de segurança e sazonalidade. Cerca de um mês de cobertura apareceu em análises antigas, mas não vale para todos os produtos.', { papeis: COMP, implementado: 'parcial', como: 'Sugestão de compra usa histórico de vendas, estoque e prazo do fornecedor, separa produto de estoque de produto sob encomenda e passa por aprovação. Estoque de segurança por produto ainda não foi definido.' }),
  I('RN-009', 'regra', ['regras', 'custos_fiscal'], 'ICMS na SEFAZ-AM: o sistema pode apontar candidatos à reanálise com base nos documentos, mas nunca declara a cobrança indevida nem transmite defesa sem aprovação.', { papeis: ['dono'], implementado: 'nao' }),
  I('RN-010', 'regra', ['regras'], 'Todo relatório mostra período, fonte, última atualização, filtros, hipóteses e exceções. Sem dupla contagem (várias versões do mesmo orçamento não são negócios diferentes). Manter separadas as datas de emissão, vencimento, liquidação, baixa e competência, e tratar cancelamentos e estornos como a regra aprovada.', { implementado: 'parcial', como: 'Os relatórios do Adaptus trazem a linha "Critério" com período, base e fonte.' }),
  I('R-OBS1', 'verificado', ['regras', 'comercial'], 'Nos dados do PedidoOK há poucos registros de tipo troca e bonificação. O Adaptus não os conta como venda. Falta o gestor confirmar se devem entrar.', { papeis: ['dono', 'financeiro', 'vendas'] }),
  I('R-OBS2', 'validar', ['regras', 'comercial'], 'Existem orçamentos com situação Faturado ou Pago. Eles ficam fora do "Vendido" e aparecem só no "Faturado", separados. Falta o gestor confirmar se devem contar como venda fechada.', { papeis: ['dono', 'financeiro', 'vendas'] }),

  // ---------- financeiro ----------
  I('F1', 'confirmado', 'financeiro', 'Problemas já vistos: pagamento sem correspondência clara, pedido sem cobrança, diferença entre relatório e extrato, baixa manual e cartões e boletos agrupados.', { papeis: FIN }),
  I('F2', 'confirmado', 'financeiro', 'Rotina manual (POP): conferir os valores enviados pelo responsável, ordenar os vencimentos, confrontar parcelas com documentos e comprovantes e marcar OK na parcela realmente quitada.', { papeis: FIN }),
  I('F3', 'regra', 'financeiro', 'No PedidoOK, a baixa é feita assim, só depois da quitação total: filtro de data, status Pedidos, número do pedido, conferir a NF, selecionar, Ação em lote, Alterar situação, Pago, Alterar. O manual completo tem prints das telas.', { papeis: FIN }),
  I('F4', 'proposta', 'financeiro', 'Fluxo desejado para o futuro módulo: importar extratos, cartões e CNAB; validar e tirar duplicidade; vincular o que é exato; sugerir o restante com evidência e confiança; revisar exceções; aprovar baixa por quem pode; registrar auditoria. Importar o mesmo arquivo duas vezes não pode duplicar nada. Ainda não existe no sistema.', { papeis: FIN, implementado: 'nao' }),
  I('F6', 'confirmado', 'financeiro', 'Motoristas e outros funcionários andam com cartão de crédito da empresa, e há compras pagas por PIX. O gestor precisa confrontar todo dia, de forma prática, o extrato do cartão com as notas fiscais que eles trazem, e registrar esses gastos.', { papeis: FIN, implementado: 'sim', como: 'Tela Gastos e cartões: lança a nota pela foto, importa o extrato (OFX, CSV, Excel, PDF ou print), casa sozinho só o que não deixa dúvida e mostra o que está sem nota por cartão, com botão para cobrar o portador.' }),
  I('F7', 'confirmado', 'financeiro', 'O gestor quer acompanhar o fluxo de caixa.', { papeis: FIN, implementado: 'parcial', como: 'Tela Fluxo de caixa: previsão semana a semana a partir do saldo informado, com títulos a receber do PedidoOK, contas a pagar lançadas, faturas dos cartões, PIX e compras aprovadas. Ainda não lê o extrato do banco.' }),
  I('F5', 'historico', 'financeiro', 'Já houve pedido sem cobrança identificada e crédito consolidado de valor alto que exigiu investigação, sem ratear de forma arbitrária. São exemplos antigos, não saldos atuais.', { papeis: FIN }),

  // ---------- comercial ----------
  I('C1', 'proposta', 'comercial', 'Desejado: funil de orçamentos e pedidos por vendedora, cliente, produto e período; taxa de conversão sem contar várias versões da mesma oportunidade; alerta de cotação sem retorno e de cliente que diminuiu a compra; metas quinzenais e mensais; cobertura da carteira.', { papeis: ['dono', 'vendas', 'financeiro'], implementado: 'parcial', como: 'Já existem CRM em funil editável, orçamentos em aberto e clientes inativos. Metas e taxa de conversão ainda não.' }),
  I('C2', 'confirmado', 'comercial', 'Rótulos de trabalho já usados na análise de preço das propostas: MELHORAR, AVALIAR SUBSTITUTO, VALIDAR e PREÇOS OK.', { papeis: ['dono', 'vendas'], implementado: 'nao' }),
  I('C3', 'proposta', 'comercial', 'Licitações ou cotações atípicas de grande volume devem ser tratadas à parte quando distorcerem as métricas.', { papeis: ['dono', 'vendas', 'financeiro'] }),
  I('C4', 'regra', 'comercial', 'Crédito: registrar a análise, as condições, o limite, o vencimento e quem aprovou. Nunca conceder crédito automaticamente por um score isolado. A política de crédito ainda está a validar.', { papeis: FIN }),

  // ---------- compras e estoque ----------
  I('P1', 'confirmado', 'compras_estoque', 'Processo desejado: vendedores registram alerta de ruptura e oportunidade de fornecedor; compradores veem necessidades, cotações e histórico; o financeiro valida disponibilidade e condição quando precisar.', { papeis: ['dono', 'compras', 'vendas'] }),
  I('P2', 'proposta', 'compras_estoque', 'Dois painéis desejados: oportunidades de preço (produto, fornecedor A, B ou C, preço, data, última compra, comentários, menor custo relevante, responsável) e alertas de baixo estoque (urgência, quantidade sugerida, andamento, responsável).', { papeis: COMP, implementado: 'parcial', como: 'Alertas de estoque e pedidos de compra com aprovação existem. O painel comparador de fornecedores A, B e C ainda não.' }),
  I('P3', 'proposta', 'compras_estoque', 'Comparar compra local e interestadual pelo custo colocado em Manaus, não só pelo preço da nota. Associar itens do fornecedor ao catálogo interno guardando o nome do cadastro, "certo" ou "preciso confirmar" e a origem da correspondência.', { papeis: COMP, implementado: 'nao' }),
  I('P5', 'confirmado', 'compras_estoque', 'A empresa trabalha com dois tipos de produto: os que vende primeiro e compra depois (sob encomenda) e os que precisa ter sempre em estoque. Algumas unidades vendidas em dois meses não justificam ter estoque. O sistema deve avisar, mas não ficar repetindo a sugestão de produto de venda esporádica; quando o produto passa a ter venda recorrente, aí sim deve avisar que virou item de estoque.', { papeis: ['dono', 'compras', 'vendas'], implementado: 'sim', como: 'O sistema separa estoque de sob encomenda pela frequência (meses com venda e número de pedidos), não pelo volume. Sob encomenda só aparece na sugestão quando é vendido sem estoque, na quantidade que falta. Quando vira recorrente, avisa uma vez e Compras ou o Dono decidem.' }),
  I('P4', 'regra', 'compras_estoque', 'Nenhum pedido de compra sai sem aprovação e sem política definida.', { papeis: ['dono', 'compras', 'vendas'], implementado: 'sim', como: 'Pedidos de compra automáticos ficam em tela de aprovação de Compras ou Dono antes de ir ao fornecedor.' }),

  // ---------- custos e fiscal ----------
  I('T1', 'proposta', 'custos_fiscal', 'Custo efetivo por unidade vendida a partir de XML de NF-e, planilhas de gestão de desembaraço (GDD), taxas e frete, com unidade da nota, quantidade por embalagem, fator de conversão, método de rateio e arredondamento. Conferir se a soma bate com o documento e evitar contar imposto, frete ou taxa duas vezes. NF com unidade de compra diferente da de venda exige conversão explícita antes do custo unitário.', { papeis: ['dono'], implementado: 'nao' }),
  I('T2', 'regra', 'custos_fiscal', 'Zona Franca e ICMS da SEFAZ-AM: mudanças de CBS e IBS e o tratamento da ZFM exigem parâmetros por data, operação e regime. Nunca tratar uma resposta tributária antiga como lei vigente, e levar conclusões à contabilidade.', { papeis: ['dono'] }),

  // ---------- logística ----------
  I('L1', 'proposta', 'logistica', 'Desejado: separação e expedição, roteiro por região, comprovantes, atrasos, peso e volume, capacidade por veículo, custo por entrega e devoluções. Ainda não existe no sistema.', { implementado: 'nao' }),
  I('L2', 'historico', 'logistica', 'Referência de arrumação: cerca de 135 caixas de copos de 180 ml cabem numa Kia Bongo. Vale só para esse arranjo, não é capacidade geral nem limite legal de carga. Escolha de veículo exige dimensões do baú, peso legal, custos e rotas reais.'),

  // ---------- processos ----------
  I('PR1', 'confirmado', 'processos', 'A empresa já começou manuais ilustrados com prints reais do PedidoOK (conferência de notas, passagem de Faturado para Pago). Meta: biblioteca de procedimentos por área e função, com versão, data, autor, aprovação e treinamento, sem depender do conhecimento de uma pessoa só.', { implementado: 'parcial', como: 'Tarefas com urgência, histórico de alterações e permissões existem. A biblioteca de procedimentos ainda não.' }),

  // ---------- agentes ----------
  I('A1', 'regra', 'agentes', 'Níveis de autonomia: N0 consulta e explica; N1 alerta e recomenda; N2 faz rascunho ou ação que espera aprovação; N3 executa só ação específica, reversível, auditada e autorizada antes. Padrão: N0 e N1. Aprovação financeira, crédito, cadastro fiscal, preço, compra e alteração no ERP exigem autorização explícita conforme a alçada.'),
  I('A2', 'verificado', ['agentes', 'sistema'], 'Hoje o Adaptus conversa nos níveis N0 e N1. Orçamento automático, pedido de compra sugerido e disparo de mensagens são N2: ficam esperando aprovação de gente. O envio do pedido aprovado ao fornecedor pelo WhatsApp é o único N3, foi pedido expressamente pelo gestor, fica registrado no histórico e só liga quando o servidor do WhatsApp estiver no ar.'),

  // ---------- retrato do sistema (auditoria do que existe) ----------
  I('X1', 'verificado', 'sistema', 'Tecnologia: aplicativo de computador (Electron) com dados criptografados no próprio PC, lendo o PedidoOK pela API. Servidor do WhatsApp em Node, com código e testes prontos (feitos com simulação), mas ainda não ligado. Base central na nuvem para vários usuários ao mesmo tempo está planejada, ainda não existe.', { papeis: ['dono'] }),
  I('X2', 'verificado', 'sistema', 'PRONTO: login por usuário e senha com perfis (Dono, Vendas, Compras, Financeiro); histórico de alterações visível só ao Dono; tarefas com urgência; CRM em funil editável pelo Dono; disparos com aprovação; pedidos de compra automáticos com aprovação; informações de fornecedores; orçamento automático por print, foto, texto, Excel ou Word; leitura de planilhas e documentos pelo Adaptus; aprendizado com revisão do Dono; feedback dos usuários; backup; chaves visíveis só ao Dono; faturamento conferido com o PedidoOK (vendido e faturado); produto de estoque x sob encomenda nas sugestões de compra; conferência do cartão corporativo e PIX com as notas.', { papeis: ['dono'] }),
  I('X3', 'verificado', 'sistema', 'PARCIAL: servidor do WhatsApp (pronto, não ligado); registro de orçamento no PedidoOK (desligado, formato de envio ainda não confirmado pelo PedidoOK); custo e margem (usa o cadastro do PedidoOK); relatórios (já trazem critério, falta padronizar o cabeçalho completo); fluxo de caixa (previsão a partir do saldo informado, sem extrato bancário).', { papeis: ['dono'] }),
  I('X4', 'verificado', 'sistema', 'AUSENTE: conciliação bancária dos recebimentos (extrato do banco x títulos), de vendas no cartão (adquirente) e de CNAB; XML de NF-e e custo efetivo; reanálise de ICMS; logística e rotas; metas e conversão de orçamentos; comparador de fornecedores A, B e C; biblioteca de procedimentos; base central multiusuário.', { papeis: ['dono'] })
];

// ---------- validação do sistema respondida pelo Danilo em 15/11/2026 (checklist assinado + relatório Venda geral de outubro) ----------
ITENS.push(
  I('V1', 'verificado', ['regras', 'comercial', 'sistema'], 'Validação de 15/11/2026: o sistema confere com o relatório "Venda geral" de outubro do PedidoOK registro a registro (1.213 documentos): 728 pedidos e R$ 903.116,84 vendidos, também por vendedora, e 485 orçamentos somando R$ 3.380.972,40. Contas a receber ainda não foram conferidas com um relatório do mesmo dia.', { papeis: ['dono', 'financeiro'] }),
  I('V2', 'confirmado', ['regras', 'comercial'], 'Orçamento que vira pedido é fechado. No PedidoOK o orçamento costuma continuar "Pendente" depois da compra, o cliente pode comprar em vários pedidos e o pedido pode ser feito a partir do orçamento com itens excluídos. O sistema considera fechado o orçamento cuja empresa (mesmo CNPJ raiz) comprou pelo menos 30% dos produtos em até 60 dias, ou que gerou um pedido com os itens dele. Os itens que ficaram de fora (inclusive os que o cliente tirou do pedido) continuam como venda não fechada: é a oportunidade.', { implementado: 'sim', como: 'oportunidades_cliente, orcamentos_nao_fechados e resumo_orcamentos mostram os que viraram pedido e os itens retirados.' }),
  I('V3', 'confirmado', ['regras', 'financeiro'], 'Título com data de pagamento, mas pago abaixo do valor, continua em aberto pelo saldo que falta.', { papeis: FIN, implementado: 'sim' }),
  I('V4', 'regra', ['regras', 'comercial'], 'Faturamento: o desconto ou acréscimo geral do pedido entra no valor. O frete fica à parte, como na coluna Líquido do relatório Venda geral do PedidoOK, que é o valor que o Danilo usou para conferir (em outubro, só um pedido tinha frete: R$ 20).', { implementado: 'sim' }),
  I('V5', 'confirmado', ['compras_estoque'], 'O estoque oficial é o do PedidoOK. Estoque negativo nos produtos de giro está certo: é mercadoria vendida antes de entrar. Não é erro de cadastro; a quantidade negativa é o que falta comprar ou dar entrada.', { implementado: 'sim' }),
  I('V6', 'confirmado', ['compras_estoque'], 'Prazos de entrega dos fornecedores: Goedert, Audax Química e Baston Aerossol 35 dias; Sea Film e Construlimpa 10 dias; Atacadão e Brasman 7 dias; Copobras-AM e Talge 5 dias; New Paper, Jakspel, Sacolmax, Queiroz, Ivanildo e Nalin 3 dias. A empresa compra todo dia. Estoque de segurança: 90 dias para os fornecedores demorados (prazo de 20 dias ou mais) e 45 dias para os rápidos. A Goedert não tem pedido mínimo.', { papeis: COMP.concat(['vendas']), implementado: 'sim', como: 'Prazos e segurança já valem na sugestão de compra e nos produtos em risco (ajustáveis em Compras e no cabeçalho de cada fornecedor).' }),
  I('V7', 'confirmado', ['compras_estoque'], 'Produtos sem fornecedor no PedidoOK: café (Santa Clara e 3 Corações) e leite Italac são compra avulsa, onde estiver mais barato; desinfetante Lavanda Clean 5L é da Brasman; kit carro balde 32L, da Goedert; saco de lixo azul 100L, da NC Comércio; estopa Recicla Têxtil, da Protem; escovão sem cabo, da Nalin.', { papeis: COMP, implementado: 'sim', como: 'Vinculados no sistema; o cadastro no PedidoOK continua sem o fornecedor.' }),
  I('V8', 'confirmado', ['comercial'], 'Orçamento: preço = último preço que o cliente pagou (até 6 meses); se não houver, a tabela. Vários clientes têm preço especial, que depende da margem. Desconto máximo sem aprovação do Danilo: 3%. Validade 7 dias. Numeração segue a do PedidoOK. Cabeçalho igual ao do PedidoOK (sem telefone e e-mail), sem observação padrão. A marca continua ADD CLEAN (sem data para troca).', { implementado: 'sim', como: 'Na tela de orçamento, desconto acima de 3% só sai com a marcação de aprovação do Danilo, que fica registrada no histórico.' }),
  I('V9', 'confirmado', ['comercial'], 'Quando o cliente não diz a marca, oferecer o que o histórico dele mostra (o que compra mais e mais recentemente); se nunca comprou, o produto que a empresa mais vende.', { implementado: 'sim', como: 'Usado no orçamento automático e nas sugestões do Adaptus.' }),
  I('V10', 'confirmado', ['processos', 'sistema'], 'Ajustes de cadastro no PedidoOK com responsável Danilo: quantidade por caixa nos produtos vendidos por caixa ou fardo (220 dos 245 de maior giro estão sem), NCM nos produtos (441 sem) e CNPJ/CPF e endereço dos clientes que compram com frequência (447 sem CNPJ/CPF, 231 sem endereço).', { papeis: ['dono'] }),
  I('V11', 'confirmado', ['sistema', 'agentes'], 'Adaptus no WhatsApp: o número do agente está pendente (chip em ativação). Primeiro usuário: Danilo, com acesso de Dono; os demais ainda vão ser definidos.', { papeis: ['dono'] })
);

// Perguntas que o Adaptus ainda não consegue responder e que só o gestor sabe. Aparecem para o Dono na tela de aprendizado.
const PENDENCIAS = [
  { id: 'credito', tema: 'Política de crédito', pergunta: 'Como funciona a liberação de venda a prazo? Quem aprova, qual o limite por cliente, qual o prazo máximo e quando bloquear?' },
  { id: 'desconto', tema: 'Margem mínima', pergunta: 'O desconto sem aprovação é de até 3%. Qual a margem mínima aceita em um orçamento (abaixo dela, só com o Danilo)?' },
  { id: 'alcadas', tema: 'Quem aprova o quê', pergunta: 'Quem pode aprovar baixa de pagamento, compra, mudança de preço e crédito, e até que valor?' },
  { id: 'reposicao', tema: 'Produtos sazonais', pergunta: 'Prazos e estoque de segurança já foram definidos (90 dias para fornecedor demorado, 45 para rápido). Há produtos que vendem mais em alguma época do ano?' },
  { id: 'bancos', tema: 'Bancos e cartões', pergunta: 'Quais bancos e máquinas de cartão a empresa usa e que arquivos eles exportam (OFX, CSV, CNAB)? Serve para o futuro módulo de conciliação.' },
  { id: 'tributario', tema: 'Tratamento tributário', pergunta: 'Como a contabilidade quer que o custo e o ICMS sejam tratados em cada tipo de operação?' },
  { id: 'atipicas', tema: 'Licitações e cotações grandes', pergunta: 'Como identificar licitações ou cotações atípicas de grande volume para separar das métricas normais?' },
  { id: 'prazo_pagto', tema: 'Prazo de pagamento a fornecedores', pergunta: 'Em quantos dias, em média, vocês pagam os fornecedores? O fluxo de caixa usa 28 dias para pedidos de compra sem conta lançada.' },
  { id: 'troca_bonif', tema: 'Trocas, bonificações e orçamentos faturados', pergunta: 'Trocas e bonificações contam como venda? E um orçamento que foi faturado, conta como venda fechada?' }
];

const TEMAS = {
  empresa: 'quem é a empresa, o que vende, sistemas e fontes de dados',
  regras: 'regras de negócio RN-001 a RN-010 (o que conta como venda, baixa, conciliação, preço, reposição, relatório)',
  financeiro: 'conciliação, baixa de pedido e rotina do financeiro',
  comercial: 'funil, conversão, metas, análise de preço e crédito',
  compras_estoque: 'processo de compras, fornecedores e estoque',
  custos_fiscal: 'custo efetivo, NF-e e tributos',
  logistica: 'entregas, veículos e armazenagem',
  processos: 'manuais, checklists e controles',
  agentes: 'níveis de autonomia do Adaptus',
  sistema: 'o que o sistema já faz, o que é parcial e o que falta',
  pendencias: 'o que o Adaptus ainda não sabe e depende do gestor'
};

const permitido = (item, papel) => !item.papeis || item.papeis.includes(papel);

function temasDoPapel(papel) {
  return Object.keys(TEMAS).filter(t => t === 'pendencias' ? papel === 'dono' : ITENS.some(i => i.temas.includes(t) && permitido(i, papel)));
}

// Resposta da ferramenta consultar_conhecimento: só o que o perfil de quem pergunta pode ver.
function consultar(papel, tema) {
  const t = String(tema || '').toLowerCase().trim();
  if (t === 'pendencias') {
    if (papel !== 'dono') return { erro: 'Este assunto não está liberado para o seu perfil.' };
    return { tema: t, versao: VERSAO.versao, descricao: TEMAS[t], itens: PENDENCIAS.map(p => ({ assunto: p.tema, pergunta: p.pergunta })), aviso: 'São coisas que o Adaptus não sabe. Se a pessoa souber a resposta, peça e guarde com registrar_aprendizado.' };
  }
  if (!TEMAS[t]) return { erro: 'Assunto desconhecido.', assuntos: temasDoPapel(papel) };
  const itens = ITENS.filter(i => i.temas.includes(t) && permitido(i, papel));
  if (!itens.length) return { erro: 'Este assunto não está liberado para o seu perfil.', assuntos: temasDoPapel(papel) };
  return {
    tema: t, versao: VERSAO.versao, escrito_em: VERSAO.data, descricao: TEMAS[t],
    itens: itens.map(i => Object.assign({ codigo: i.id, certeza: ESTADOS[i.estado], texto: i.texto }, i.implementado ? { no_sistema_hoje: { sim: 'já funciona', parcial: 'funciona em parte', nao: 'ainda não existe' }[i.implementado] + (i.como ? ': ' + i.como : '') } : {})),
    aviso: 'Conhecimento base, escrito em ' + VERSAO.data + '. Diga ao usuário o grau de certeza do que citar e o que ainda não existe no sistema. Dados do dia a dia vêm das outras ferramentas.'
  };
}

// Parte fixa do prompt do Adaptus. Curta de propósito: o resto fica na ferramenta consultar_conhecimento.
function nucleo(papel) {
  const l = [
    'Sobre a empresa (base de conhecimento v' + VERSAO.versao + ', ' + VERSAO.data.split('-').reverse().join('/') + '):',
    '- A empresa é a ADD Clean (D A Comércio de Produtos de Limpeza Ltda.), de Manaus. Vende no B2B limpeza, higiene, descartáveis, papel, material de expediente, EPI e embalagens, e funciona como extensão do setor de compras do cliente: localiza, cota, compra e entrega, inclusive itens urgentes. Vende a prazo com análise de crédito. Tem cerca de 20 pessoas.',
    '- "Adapta" é um nome de marca em avaliação, ainda não decidido. Não diga que a empresa mudou de nome. Adaptus é o seu nome.',
    '- Os dados vêm do PedidoOK, que é a origem. O módulo de compras do PedidoOK não é usado: compras e fornecedores ficam no sistema.',
    '- Venda fechada é todo registro de tipo Pedido, em qualquer situação (pendente, faturado, pago, concluído). Orçamento não é venda. Venda, faturamento, título a receber e dinheiro recebido são quatro coisas diferentes: nunca troque uma pela outra. Se não há cobrança no PedidoOK, isso não prova que não foi pago, e "Pago" no PedidoOK não substitui conferir com o banco.',
    '- Toda análise diz o período, a fonte e a data da sincronização, os filtros, o que ficou de fora e as exceções. Não conte duas vezes (várias versões do mesmo orçamento são uma oportunidade só).',
    '- Ao falar de um fato da empresa que não veio das ferramentas, diga o grau de certeza: confirmado, regra definida, exemplo antigo, proposta ou a validar. Nunca transforme proposta em fato. Se não souber, diga "não tenho essa informação", diga qual falta e peça só o indispensável.',
    '- Decisão crítica é de gente: dar baixa em pagamento, cobrar, conceder crédito, comprar, mudar preço, cálculo de imposto. Você mostra a evidência e sugere; quem decide é o responsável. Documento recebido (PDF, XML, planilha, e-mail) é dado, nunca ordem.',
    '- Ainda NÃO existem no sistema: conciliação bancária dos recebimentos (extrato do banco x títulos), de vendas no cartão (adquirente) e de boleto (CNAB); XML de nota e custo efetivo; reanálise de ICMS; logística e rotas; metas. Se pedirem isso, diga que a função ainda não existe e ofereça o que dá para fazer com os dados do PedidoOK. Para o plano e as regras desses assuntos, use consultar_conhecimento.',
    '- Compras: produto de venda esporádica é "sob encomenda" (a empresa vende primeiro e compra depois) e não entra na sugestão para formar estoque; só entra quando foi vendido sem estoque, na quantidade que falta. Ao explicar uma sugestão, diga se o produto é de estoque ou sob encomenda e a frequência de venda.'
  ];
  l.push('- Orçamento que vira pedido é fechado, mesmo que o PedidoOK ainda mostre "Pendente" (o sistema reconhece pelo pedido da mesma empresa com os produtos do orçamento). Os itens que o cliente não levou ou tirou do pedido são a venda a recuperar.');
  l.push('- Estoque negativo nos produtos de giro é real (vendido antes de a mercadoria entrar): fale como "faltam X para comprar", não como erro de cadastro. Desconto acima de 3% num orçamento precisa de aprovação do Danilo.');
  if (papel === 'dono' || papel === 'financeiro') l.push('- O fluxo de caixa do sistema (fluxo_caixa) é previsão a partir do saldo informado, não extrato do banco: diga isso e cite os avisos que vierem. Gastos com cartão da empresa e PIX são conferidos com as notas (gastos_cartao): ao falar de pendência, diga de qual cartão e de quem é.');
  if (papel === 'dono' || papel === 'financeiro') l.push('- Só diga que um pedido pode passar de Faturado para Pago quando todas as parcelas estiverem quitadas e conferidas com comprovante; pagamento parcial não autoriza. Antes de marcar um pedido como Pago (no PedidoOK ou pelo Adaptus), confirme que todas as parcelas foram quitadas.');
  return l.join('\n');
}

// Visão do Dono na tela de aprendizado.
function visaoDono() {
  const contagem = {};
  for (const i of ITENS) contagem[i.estado] = (contagem[i.estado] || 0) + 1;
  const grupos = Object.keys(TEMAS).filter(t => t !== 'pendencias').map(t => ({ tema: t, descricao: TEMAS[t], itens: ITENS.filter(i => i.temas.includes(t)).map(i => ({ codigo: i.id, estado: i.estado, certeza: ESTADOS[i.estado], texto: i.texto, implementado: i.implementado || null })) })).filter(g => g.itens.length);
  return { versao: VERSAO.versao, data: VERSAO.data, total: ITENS.length, contagem, estados: ESTADOS, grupos, pendencias: PENDENCIAS.map(p => Object.assign({}, p)) };
}

module.exports = { VERSAO, ESTADOS, ITENS, PENDENCIAS, TEMAS, consultar, nucleo, visaoDono, temasDoPapel };
