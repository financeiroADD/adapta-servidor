# Servidor do agente da Adapta (WhatsApp)

Recebe as mensagens do WhatsApp (API oficial da Meta), consulta os dados do PedidoOK, responde com a IA da Claude e, quando a pessoa pede e confirma, grava mudanças no PedidoOK.

**Sem dependências:** só Node 20 ou mais novo. Não precisa de `npm install`.

## Como funciona
- `POST /webhook`: a Meta manda cada mensagem aqui. Só é aceita com assinatura válida (`X-Hub-Signature-256`).
- `GET /webhook`: a Meta confere o endereço uma vez (usa `WHATSAPP_VERIFY_TOKEN`).
- `GET /saude`: mostra se o servidor está de pé e quando foi a última leitura do PedidoOK (detalhes só com `SAUDE_TOKEN`).
- A cada 2 horas (e ao ligar) baixa só o que mudou no PedidoOK e guarda em `DATA_DIR`.
- Só responde números da lista `USUARIOS`. Qualquer outro número é ignorado em silêncio.

## Segurança
- Cada mensagem passa pela mesma guarda do programa (regras fixas + classificador de IA) antes de ir para o Adaptus.
- Quem pede para apagar ou adulterar os dados da empresa é bloqueado na hora; três tentativas barradas em 7 dias também bloqueiam. O Dono recebe um aviso no WhatsApp.
- Comandos do Dono: `ocorrências` (o que foi barrado e quem está bloqueado) e `liberar Nome` (devolve o acesso).
- Para mudar algo no PedidoOK o Adaptus só PREPARA a ação; quem grava é o "confirmar" da própria pessoa (veja abaixo). Mudança em massa não existe: uma ação por vez.
- Webhook só com assinatura válida da Meta; verify token comparado em tempo constante; endereços externos só por HTTPS; sem seguir redirecionamentos com tokens.
- Ocorrências e bloqueios ficam em `DATA_DIR/seguranca.json` (permissão 600). O contêiner roda com usuário sem privilégios.

## Custo da IA
- Cada pergunta vai no modelo que basta: consulta direta no Haiku (quase de graça), o dia a dia no Sonnet. As instruções fixas ficam em cache (5% do preço nas chamadas seguintes).
- Pergunta que pede análise grande sai resumida, com o convite "responda *completa*". A análise completa (mais cara) só roda se a pessoa responder `completa`.
- Teto do mês em reais em `TETO_IA_MES` (padrão 200; somado aos R$ 500 do programa, fecha os R$ 700 do mês). Perto dele a equipe fica sem análise completa; acima, segue respondida no modo rápido. O Dono continua com tudo.
- Comando do Dono: `custo da IA` mostra o gasto do mês, a projeção e quanto foi em cada tipo de resposta.

## Gravar no PedidoOK pelo WhatsApp
Mesmas regras do programa (a partir da 1.4.0). A pessoa pede ("crie um orçamento para o Cristal Tower com 12 detergentes", "dê baixa na cobrança 123 por PIX"), o Adaptus confere os dados e prepara; o servidor responde com o resumo exato do que vai gravar e termina com **"Responda *confirmar* para gravar (vale por 30 minutos) ou *cancelar*"**. Só o `confirmar` da mesma pessoa grava. Sem isso, nada vai ao PedidoOK.

| Perfil | O que pode gravar |
|---|---|
| dono | tudo, inclusive excluir e reativar, tirar item de pedido, preço de venda e limite de crédito |
| vendas | orçamentos e pedidos (criar, transformar orçamento em pedido, mudar cabeçalho e itens), clientes e contatos; desconto acima de 3% só com o Dono |
| compras | produtos (cadastro, custo, estoque, NCM, fornecedor), sem preço de venda; fornecedores |
| financeiro | cobranças (lançar, alterar, dar baixa) e a situação Pago/Faturado do pedido |

- Usa só POST, PATCH e DELETE da API oficial (nunca PUT, que zera campos). Excluir no PedidoOK é reversível; o servidor lembra o que o Adaptus excluiu para poder reativar.
- Freio: até 40 gravações por hora por pessoa (120 para o Dono). Cada gravação fica em `DATA_DIR/acoes.json` (quem, o quê, se gravou).
- Depois de gravar, o servidor relê só o que mudou no PedidoOK, para as próximas respostas já virem atualizadas.
- Para desligar: variável `ACOES_PEDIDOOK=0` (volta a ser só consulta).
- As gravações seguem a documentação oficial e foram testadas com um PedidoOK simulado. **Antes de liberar para a equipe, teste com a conta de testes do PedidoOK ou com um cliente e um produto de teste.**

## Aviso de segurança ao Dono (modelo da Meta)
Quando alguém é bloqueado, o servidor avisa o Dono no WhatsApp. Se o Dono escreveu para o agente nas últimas 24 horas, o aviso vai como texto completo. Fora dessa janela a Meta só aceita um **modelo (template) aprovado**, e o servidor usa o modelo abaixo.

Crie uma vez no painel da Meta (WhatsApp > Modelos de mensagem): nome `adaptus_aviso_seguranca`, categoria **Utilidade**, idioma **Português (BR)**, texto do corpo:

`Adaptus, aviso de segurança: o acesso de {{1}} (final {{2}}) foi bloqueado por tentativa grave. Responda "ocorrências" para ver os detalhes. Para devolver o acesso, responda "liberar" e o primeiro nome da pessoa.`

Exemplos que a Meta pede para as variáveis: {{1}} = `Carlos`, {{2}} = `4567`. O modelo leva só o primeiro nome e o final do telefone, nunca a mensagem do atacante. Ao responder o modelo, o Dono abre a janela de 24 horas e os comandos `ocorrências` e `liberar Nome` funcionam normalmente. Se o modelo não estiver aprovado, o log mostra `aviso ao dono NÃO entregue`.

## Parâmetros de compra (validação do Danilo)
Na primeira leitura do PedidoOK o servidor aplica uma única vez as respostas da validação de 15/11: prazos dos 15 fornecedores, compra diária, segurança de 90 dias (fornecedor com prazo de 20 dias ou mais) ou 45 dias, e os produtos sem fornecedor. Ficam em `DATA_DIR/config.json` (`prazos`, `parametros`, `fornecedorProduto`) e não são sobrescritos depois. **Mudanças feitas no programa (prazos, perfis de produto, sazonais) não chegam sozinhas ao servidor.** Para valer no WhatsApp, edite o `config.json` e reinicie o servidor.

## Perfis
| Perfil | O que consegue consultar |
|---|---|
| dono | tudo |
| compras | produtos, estoque, produtos em risco, sugestão de compra (sem margem) |
| financeiro | cobranças e ficha de cliente (sem margem) |
| vendas | produtos e estoque (sem custo, margem nem faturamento) |

## Variáveis
Veja `.env.exemplo`. Os valores ficam só no painel da hospedagem.

## Disco permanente
Monte um volume em `/dados` (ou aponte `DATA_DIR`). Sem ele, a cada reinício o servidor baixa tudo do PedidoOK de novo (demora alguns minutos).

## Rodar
`node server.js`
