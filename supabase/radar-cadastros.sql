-- Radar de Processos — cadastro (nome + telefone) e painel do administrador.
-- Rodar uma vez no SQL Editor do projeto zaplcm (Supabase).
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.rp_cadastros (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 3 and 120),
  telefone text not null unique check (telefone ~ '^[0-9]{10,13}$'),
  token_hash text not null,
  versao text,
  acessos integer not null default 1,
  criado_em timestamptz not null default now(),
  ultimo_acesso timestamptz not null default now()
);
alter table public.rp_cadastros enable row level security;

create table if not exists public.rp_admin (
  id integer primary key check (id = 1),
  senha_hash text not null
);
alter table public.rp_admin enable row level security;

create table if not exists public.rp_admin_tentativas (
  id bigint generated always as identity primary key,
  quando timestamptz not null default now()
);
alter table public.rp_admin_tentativas enable row level security;

revoke all on public.rp_cadastros, public.rp_admin, public.rp_admin_tentativas from anon, authenticated;

create or replace function public.rp_cadastrar(p_nome text, p_telefone text, p_versao text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_token text := encode(gen_random_bytes(24), 'hex');
  v_id uuid;
begin
  if char_length(v_nome) < 3 then raise exception 'Informe seu nome.'; end if;
  if v_tel !~ '^[0-9]{10,13}$' then raise exception 'Telefone inválido.'; end if;
  insert into rp_cadastros (nome, telefone, token_hash, versao)
  values (left(v_nome, 120), v_tel, encode(digest(v_token, 'sha256'), 'hex'), left(p_versao, 20))
  on conflict (telefone) do update
    set nome = excluded.nome, token_hash = excluded.token_hash, versao = excluded.versao,
        acessos = rp_cadastros.acessos + 1, ultimo_acesso = now()
  returning id into v_id;
  return json_build_object('id', v_id, 'token', v_token);
end $$;

create or replace function public.rp_ping(p_id uuid, p_token text, p_versao text default null)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  update rp_cadastros
     set ultimo_acesso = now(), acessos = acessos + 1, versao = coalesce(left(p_versao, 20), versao)
   where id = p_id and token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  return found;
end $$;

create or replace function public.rp_admin_ok(p_senha text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  if (select count(*) from rp_admin_tentativas where quando > now() - interval '15 minutes') >= 10 then
    raise exception 'Muitas tentativas. Aguarde 15 minutos.';
  end if;
  select senha_hash into v_hash from rp_admin where id = 1;
  if v_hash is null or crypt(coalesce(p_senha, ''), v_hash) <> v_hash then
    insert into rp_admin_tentativas default values;
    raise exception 'Senha incorreta.';
  end if;
  delete from rp_admin_tentativas where quando < now() - interval '1 day';
end $$;

create or replace function public.rp_admin_listar(p_senha text)
returns table (id uuid, nome text, telefone text, versao text, acessos integer, criado_em timestamptz, ultimo_acesso timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rp_admin_ok(p_senha);
  return query select c.id, c.nome, c.telefone, c.versao, c.acessos, c.criado_em, c.ultimo_acesso
                 from rp_cadastros c order by c.criado_em desc;
end $$;

create or replace function public.rp_admin_excluir(p_senha text, p_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rp_admin_ok(p_senha);
  delete from rp_cadastros where id = p_id;
  return found;
end $$;

create or replace function public.rp_admin_trocar_senha(p_senha text, p_nova text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rp_admin_ok(p_senha);
  if char_length(coalesce(p_nova, '')) < 10 then raise exception 'A nova senha precisa ter pelo menos 10 caracteres.'; end if;
  update rp_admin set senha_hash = crypt(p_nova, gen_salt('bf', 10)) where id = 1;
  return true;
end $$;

revoke all on function public.rp_cadastrar(text, text, text), public.rp_ping(uuid, text, text), public.rp_admin_ok(text),
  public.rp_admin_listar(text), public.rp_admin_excluir(text, uuid), public.rp_admin_trocar_senha(text, text) from public, anon, authenticated;
grant execute on function public.rp_cadastrar(text, text, text), public.rp_ping(uuid, text, text),
  public.rp_admin_listar(text), public.rp_admin_excluir(text, uuid), public.rp_admin_trocar_senha(text, text) to anon, authenticated;

-- Senha inicial do painel: troque TROQUE-ESTA-SENHA por uma senha sua (mín. 10 caracteres) antes de rodar.
insert into public.rp_admin (id, senha_hash) values (1, crypt('TROQUE-ESTA-SENHA', gen_salt('bf', 10)))
on conflict (id) do nothing;
