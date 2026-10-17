# Radar de Processos

Extensão do Chrome: digite um **CNPJ ou CPF** e veja processos judiciais em fontes públicas e gratuitas — Diário de Justiça Eletrônico Nacional (DJEN), jus.br (CNJ), e-SAJ (SP, MS, AL, CE, AM, AC) — e sanções do Portal da Transparência. Monitora e avisa quando aparece processo novo.

## Como atualizar (inclusive pelo celular)

1. Edite qualquer arquivo dentro de `extensao/` — pelo github.com, pelo app do GitHub ou pedindo ao Claude.
2. Salve (commit) na branch `main`.
3. A ação **Publicar na Chrome Web Store** (aba *Actions*) confere o código, cria a versão nova (ex.: 2.0.12) e envia para a loja.
4. Depois da revisão do Google (algumas horas a poucos dias), o Chrome de todos que instalaram atualiza sozinho.

Para salvar sem publicar, escreva `[skip publish]` na mensagem do commit.

## Estrutura

| Caminho | O que é |
|---|---|
| `extensao/` | A extensão (o que vai para a loja) |
| `extensao/lib.js` | Busca nas fontes (DJEN, jus.br, e-SAJ, Transparência) |
| `extensao/background.js` | Monitoramento, alertas, sessão do jus.br |
| `extensao/app.*` | Tela |
| `.github/workflows/publicar-chrome-web-store.yml` | Publicação automática |
| `scripts/verificar.mjs` | Conferência antes de publicar |
| `loja/` | Textos e imagens da Chrome Web Store |
| `PRIVACY.md` | Política de privacidade (link exigido pela loja) |

## Configuração única da publicação automática

1. **Primeiro envio manual:** baixe o `.zip` gerado na aba *Actions* (ou compacte a pasta `extensao/`), entre no [painel da Chrome Web Store](https://chrome.google.com/webstore/devconsole), clique em *Novo item*, envie o `.zip`, preencha com os textos de `loja/descricao-chrome-web-store.md`, marque **Não listado** e envie para revisão.
2. Copie o **ID da extensão** que aparece no painel.
3. No GitHub: *Settings → Secrets and variables → Actions → New repository secret*, crie:
   - `CWS_EXTENSION_ID` — o ID do passo 2
   - `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` — os mesmos valores usados no repositório `gravador-xopi`

Pronto: daí em diante cada mudança é publicada sozinha.

## Testar sem a loja

`chrome://extensions` → *Modo do desenvolvedor* → *Carregar sem compactação* → escolha a pasta `extensao/`.
