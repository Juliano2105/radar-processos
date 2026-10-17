# Textos para a Chrome Web Store

## Nome
Radar de Processos - consulta por CNPJ e CPF

## Resumo (vem do manifest, até 132 caracteres)
Digite um CNPJ ou CPF e veja processos judiciais em fontes públicas e gratuitas (DJEN, jus.br, e-SAJ) e sanções do governo.

## Categoria
Ferramentas (ou Produtividade › Ferramentas)

## Idioma
Português (Brasil)

## Visibilidade
Não listado (só quem tem o link instala)

## Descrição completa

Consulte e monitore processos judiciais de qualquer empresa ou pessoa, só com o CNPJ ou CPF. Grátis, sem cadastro e sem servidor intermediário: as consultas saem do seu navegador direto para as fontes oficiais.

🔎 ONDE PROCURA
• Diário de Justiça Eletrônico Nacional (DJEN/CNJ) — intimações e editais de todos os tribunais
• jus.br (CNJ) — base nacional de processos, com a sua própria conta gov.br
• e-SAJ — TJSP, TJMS, TJAL, TJCE, TJAM e TJAC
• Portal da Transparência — sanções do governo (CEIS e CNEP)
• Atalhos para CNDT, TRT, Projudi, TRF, protestos e PGFN

📋 O QUE MOSTRA
• Processos trabalhistas, de cobrança/execução, fiscais, de consumidor e outros
• Se a empresa/pessoa é ré ou autora
• Texto das publicações e link para o documento
• Exportação para planilha (CSV)

🔔 MONITORAMENTO
• Verifica sozinho de tempos em tempos e avisa quando aparece processo novo
• Notificação no computador e aviso por webhook (WhatsApp via Evolution API, n8n, etc.)

🔒 PRIVACIDADE
• Cadastro rápido só com nome e telefone
• As consultas não passam por servidores nossos
• Monitorados e alertas ficam no seu computador
• A senha do gov.br nunca passa pela extensão

Processos em segredo de justiça não aparecem. Use os dados de acordo com a LGPD.

## Justificativas de permissão (aba "Privacidade" do painel)

**Finalidade única:** consultar e monitorar processos judiciais e sanções públicas ligados a um CNPJ ou CPF.

- **storage / unlimitedStorage:** guardar localmente os documentos monitorados, os alertas e as configurações.
- **alarms:** executar o monitoramento periódico no intervalo escolhido pelo usuário.
- **notifications:** avisar o usuário quando surgir processo novo.
- **declarativeNetRequest:** definir os cabeçalhos Origin/Referer exigidos pelas APIs públicas do CNJ (DJEN e jus.br) nas chamadas feitas pela extensão.
- **clipboardWrite:** copiar o CPF/CNPJ quando o usuário clica num atalho para sites oficiais que exigem captcha.
- **ovvenrskswsurqzjydby.supabase.co:** cadastro do usuário (nome e telefone) e registro da data de uso.
- **Permissões de host:** cada domínio corresponde a uma fonte oficial consultada (CNJ, tribunais e-SAJ, Portal da Transparência) ou a uma API de dados cadastrais de CNPJ (BrasilAPI, Minha Receita).
- **Script de conteúdo no jus.br:** quando o usuário entra no jus.br com a própria conta gov.br, lê o cabeçalho de autorização que o portal já envia às APIs do CNJ, para que a extensão faça as consultas em nome do usuário. Não lê senha nem formulários; o token fica só no computador do usuário.
- **Código remoto:** não usa. Todo o código está no pacote.

 **Uso de dados:** marque também "Informações de identificação pessoal" para o nome e telefone do cadastro. Marque "Informações de autenticação" (token da sessão do jus.br, armazenado localmente) e "Informações de identificação pessoal" (CPF/CNPJ digitados pelo usuário, enviados apenas às fontes consultadas). Declare que os dados não são vendidos, não são usados para fins alheios à finalidade única e não são usados para crédito.

**Política de privacidade:** https://github.com/Juliano2105/radar-processos/blob/main/PRIVACY.md
