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
