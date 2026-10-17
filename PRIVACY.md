# Política de Privacidade — Radar de Processos

_Última atualização: 17 de outubro de 2026_

O **Radar de Processos** é uma extensão do Chrome que consulta, em fontes públicas, processos judiciais e sanções ligados a um CNPJ ou CPF digitado por você, e pode monitorar esses documentos e avisar quando surgir algo novo.

## Resumo

- **Cadastro:** para usar, você informa **nome e telefone**. Só isso (mais a data do último uso e a versão da extensão) é guardado no nosso banco de dados, para sabermos quem usa a ferramenta.
- **As consultas não passam por nós.** Elas saem do seu navegador direto para as fontes oficiais listadas abaixo. Os CPFs/CNPJs consultados, os processos encontrados, os monitorados e os alertas ficam **somente no seu Chrome** — nem o administrador nem outros usuários conseguem vê-los.
- **Não vendemos nem compartilhamos dados.** Não há rastreadores, analytics nem anúncios.

## Cadastro

| Dado | Para quê | Onde fica |
|---|---|---|
| Nome e telefone | Identificar quem usa a ferramenta e poder entrar em contato | Banco de dados do Radar (Supabase, região São Paulo), visível só para o administrador |
| Data do último uso e versão da extensão | Saber se a ferramenta está sendo usada e atualizada | Mesmo banco |

Você pode pedir a exclusão do seu cadastro a qualquer momento pelo contato abaixo.

## Para onde vão as consultas

| Fonte | O que é enviado | Para quê |
|---|---|---|
| DJEN — Diário de Justiça Eletrônico Nacional (comunicaapi.pje.jus.br, CNJ) | CPF/CNPJ e, se você quiser, nomes | Encontrar publicações processuais |
| jus.br / PDPJ (pdpj.jus.br, CNJ) | CPF/CNPJ e o token da sua sessão no jus.br | Buscar processos na base nacional |
| e-SAJ (TJSP, TJMS, TJAL, TJCE, TJAM, TJAC) | CPF/CNPJ | Consulta pública de processos |
| Portal da Transparência (api.portaldatransparencia.gov.br, CGU) | CPF/CNPJ e a sua chave de API | Consultar sanções (CEIS/CNEP) |
| BrasilAPI e Minha Receita | CNPJ | Razão social e nome fantasia |
| Webhook (opcional, configurado por você) | Lista de processos novos | Avisar você (por exemplo, no WhatsApp) |

## Sessão do jus.br

Para consultar a base nacional do CNJ, você entra no jus.br com a sua própria conta gov.br, no site oficial. Enquanto essa página está aberta, a extensão copia o token de sessão que o próprio portal usa nas chamadas dele e o guarda **apenas no seu computador** até expirar (algumas horas). Ele é usado só para as consultas que você faz ou para o monitoramento que você ativou, e é enviado apenas ao próprio jus.br. **A extensão nunca vê, lê ou guarda a sua senha.**

## Permissões

- **storage / unlimitedStorage**: guardar configurações, monitorados e alertas no seu computador.
- **alarms**: rodar o monitoramento no intervalo que você escolher.
- **notifications**: avisar de processos novos.
- **declarativeNetRequest**: ajustar os cabeçalhos das consultas ao DJEN e ao jus.br para que as fontes aceitem as chamadas.
- **clipboardWrite**: copiar o documento quando você clica num atalho para sites com captcha.
- **Acesso aos sites listados acima**: fazer as consultas. O script que roda no jus.br só lê o cabeçalho de autorização das chamadas do próprio portal.
- **Acesso opcional a outros sites**: pedido só se você configurar um webhook, e apenas para o endereço dele.

## Dados pessoais de terceiros

Processos judiciais públicos podem conter dados pessoais. Use a ferramenta para fins legítimos e de acordo com a LGPD.

## Contato

Dúvidas: abra uma "issue" em https://github.com/Juliano2105/radar-processos/issues
