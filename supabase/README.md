# Banco do cadastro (Supabase — projeto zaplcm)

Tabelas `rp_*` com RLS e sem políticas: ninguém lê ou grava direto. Tudo passa pelas funções:

| Função | Quem chama | O que faz |
|---|---|---|
| `rp_cadastrar(nome, telefone, versao)` | extensão | cria/atualiza o cadastro e devolve um token só daquela instalação |
| `rp_ping(id, token, versao)` | extensão | registra o último uso (só com o token do próprio cadastro) |
| `rp_admin_listar(senha)` | painel | lista os cadastros (exige a senha do administrador) |
| `rp_admin_excluir(senha, id)` | painel | apaga um cadastro |
| `rp_admin_trocar_senha(senha, nova)` | painel | troca a senha do painel |

Bloqueio de 15 minutos após 10 senhas erradas. Nenhum processo, CPF ou CNPJ consultado é enviado ao banco.

## Versão site

1. Rode `radar-site.sql` (troque `__CRON_SEGREDO__` por um segredo aleatório) e depois `radar-site-config.sql`.
2. Publique a função `functions/radar/index.ts` com o nome `radar`, **sem** verificação de JWT (ela faz a própria checagem de sessão e do segredo do cron). Ao publicar, os `import` de `lib.js` e `monitor.js` apontam para o jsDelivr no commit atual.
3. Sempre chame a função com o cabeçalho `x-region: sa-east-1` (ou `?forceFunctionRegion=sa-east-1`): o DJEN só responde a IP do Brasil.
4. WhatsApp: grave em `rp_config` as chaves `evo_url`, `evo_chave` e `evo_instancia` da sua Evolution API.
