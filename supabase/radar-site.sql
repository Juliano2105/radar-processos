-- Radar de Processos — versão site: login com telefone + senha, monitorados e alertas por usuário.
-- Tudo trancado: tabelas sem acesso direto; cada função exige a sessão do próprio usuário.

alter table public.rp_cadastros add column if not exists senha_hash text;

create table if not exists public.rp_sessoes (
  token_hash text primary key,
  cadastro_id uuid not null references public.rp_cadastros(id) on delete cascade,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null default now() + interval '30 days'
);
create index if not exists rp_sessoes_cadastro on public.rp_sessoes(cadastro_id);

create table if not exists public.rp_login_tentativas (
  id bigint generated always as identity primary key,
  telefone text not null,
  quando timestamptz not null default now()
);
create index if not exists rp_login_tentativas_tel on public.rp_login_tentativas(telefone, quando);

create table if not exists public.rp_monitorados (
  id uuid primary key default gen_random_uuid(),
  cadastro_id uuid not null references public.rp_cadastros(id) on delete cascade,
  doc text not null check (doc ~ '^[0-9]{11}$|^[0-9]{14}$'),
  dados jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  proxima_verificacao timestamptz not null default now() + interval '6 hours',
  unique (cadastro_id, doc)
);
create index if not exists rp_monitorados_fila on public.rp_monitorados(proxima_verificacao);

create table if not exists public.rp_alertas (
  id bigint generated always as identity primary key,
  cadastro_id uuid not null references public.rp_cadastros(id) on delete cascade,
  criado_em timestamptz not null default now(),
  lido boolean not null default false,
  dados jsonb not null
);
create index if not exists rp_alertas_cadastro on public.rp_alertas(cadastro_id, criado_em desc);

create table if not exists public.rp_config (
  chave text primary key,
  valor text not null
);

alter table public.rp_sessoes enable row level security;
alter table public.rp_login_tentativas enable row level security;
alter table public.rp_monitorados enable row level security;
alter table public.rp_alertas enable row level security;
alter table public.rp_config enable row level security;
revoke all on public.rp_sessoes, public.rp_login_tentativas, public.rp_monitorados, public.rp_alertas, public.rp_config from anon, authenticated;

-- ---------- utilidades internas (não expostas) ----------
create or replace function public.rp_tel(p text)
returns text language sql immutable set search_path = public as $$
  select case when length(d) in (10, 11) then '55' || d else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

create or replace function public.rp_nova_sessao(p_cadastro uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_token text := encode(gen_random_bytes(32), 'hex');
begin
  delete from rp_sessoes where expira_em < now();
  insert into rp_sessoes (token_hash, cadastro_id) values (encode(digest(v_token, 'sha256'), 'hex'), p_cadastro);
  update rp_cadastros set ultimo_acesso = now(), acessos = acessos + 1 where id = p_cadastro;
  return v_token;
end $$;

create or replace function public.rp_sessao_id(p_sessao text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  update rp_sessoes set expira_em = now() + interval '30 days'
   where token_hash = encode(digest(coalesce(p_sessao, ''), 'sha256'), 'hex') and expira_em > now()
  returning cadastro_id into v_id;
  if v_id is null then raise exception 'Sessão expirada. Entre de novo.'; end if;
  return v_id;
end $$;

-- ---------- login ----------
create or replace function public.rp_site_cadastrar(p_nome text, p_telefone text, p_senha text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_tel text := rp_tel(p_telefone);
  v_id uuid; v_hash text;
begin
  if char_length(v_nome) < 3 then raise exception 'Informe seu nome.'; end if;
  if v_tel !~ '^55[0-9]{10,11}$' then raise exception 'Informe o telefone com DDD.'; end if;
  if char_length(coalesce(p_senha, '')) < 6 then raise exception 'A senha precisa ter pelo menos 6 caracteres.'; end if;
  -- trava contra cadastros em massa (robôs)
  if (select count(*) from rp_cadastros where criado_em > now() - interval '10 minutes') >= 20 then
    raise exception 'Muitos cadastros agora. Tente de novo em alguns minutos.';
  end if;
  select id, senha_hash into v_id, v_hash from rp_cadastros where telefone = v_tel;
  if v_id is not null and v_hash is not null then
    raise exception 'Este telefone já tem cadastro. Use "Já tenho cadastro" para entrar.';
  end if;
  if v_id is null then
    insert into rp_cadastros (nome, telefone, token_hash, senha_hash, versao)
    values (left(v_nome, 120), v_tel, encode(gen_random_bytes(16), 'hex'), crypt(p_senha, gen_salt('bf', 8)), 'site')
    returning id into v_id;
  else
    update rp_cadastros set nome = left(v_nome, 120), senha_hash = crypt(p_senha, gen_salt('bf', 8)) where id = v_id;
  end if;
  return json_build_object('sessao', rp_nova_sessao(v_id), 'nome', left(v_nome, 120), 'telefone', v_tel);
end $$;

create or replace function public.rp_site_entrar(p_telefone text, p_senha text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_tel text := rp_tel(p_telefone); v_id uuid; v_hash text; v_nome text;
begin
  if (select count(*) from rp_login_tentativas where telefone = v_tel and quando > now() - interval '15 minutes') >= 8 then
    raise exception 'Muitas tentativas. Aguarde 15 minutos.';
  end if;
  select id, senha_hash, nome into v_id, v_hash, v_nome from rp_cadastros where telefone = v_tel;
  if v_id is null or v_hash is null or crypt(coalesce(p_senha, ''), v_hash) <> v_hash then
    insert into rp_login_tentativas (telefone) values (v_tel);
    raise exception 'Telefone ou senha incorretos.';
  end if;
  delete from rp_login_tentativas where telefone = v_tel or quando < now() - interval '1 day';
  return json_build_object('sessao', rp_nova_sessao(v_id), 'nome', v_nome, 'telefone', v_tel);
end $$;

create or replace function public.rp_site_sair(p_sessao text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from rp_sessoes where token_hash = encode(digest(coalesce(p_sessao, ''), 'sha256'), 'hex');
  return true;
end $$;

create or replace function public.rp_site_eu(p_sessao text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao); r record;
begin
  select nome, telefone into r from rp_cadastros where id = v_id;
  return json_build_object('nome', r.nome, 'telefone', r.telefone);
end $$;

create or replace function public.rp_site_trocar_senha(p_sessao text, p_atual text, p_nova text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao); v_hash text;
begin
  select senha_hash into v_hash from rp_cadastros where id = v_id;
  if crypt(coalesce(p_atual, ''), v_hash) <> v_hash then raise exception 'Senha atual incorreta.'; end if;
  if char_length(coalesce(p_nova, '')) < 6 then raise exception 'A nova senha precisa ter pelo menos 6 caracteres.'; end if;
  update rp_cadastros set senha_hash = crypt(p_nova, gen_salt('bf', 8)) where id = v_id;
  return true;
end $$;

-- ---------- monitorados (sempre do dono da sessão) ----------
create or replace function public.rp_site_monitorados(p_sessao text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  return coalesce((select jsonb_object_agg(doc, dados) from rp_monitorados where cadastro_id = v_id), '{}'::jsonb);
end $$;

create or replace function public.rp_site_salvar_monitorado(p_sessao text, p_doc text, p_dados jsonb)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao); v_doc text := regexp_replace(coalesce(p_doc, ''), '\D', '', 'g');
begin
  if v_doc !~ '^[0-9]{11}$|^[0-9]{14}$' then raise exception 'Documento inválido.'; end if;
  if pg_column_size(p_dados) > 3000000 then raise exception 'Dados grandes demais.'; end if;
  if not exists (select 1 from rp_monitorados where cadastro_id = v_id and doc = v_doc)
     and (select count(*) from rp_monitorados where cadastro_id = v_id) >= 50 then
    raise exception 'Limite de 50 documentos monitorados.';
  end if;
  insert into rp_monitorados (cadastro_id, doc, dados) values (v_id, v_doc, coalesce(p_dados, '{}'::jsonb))
  on conflict (cadastro_id, doc) do update set dados = excluded.dados, atualizado_em = now();
  return true;
end $$;

create or replace function public.rp_site_remover_monitorado(p_sessao text, p_doc text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  delete from rp_monitorados where cadastro_id = v_id and doc = regexp_replace(coalesce(p_doc, ''), '\D', '', 'g');
  return found;
end $$;

-- ---------- alertas (sempre do dono da sessão) ----------
create or replace function public.rp_site_alertas(p_sessao text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  return coalesce((
    select jsonb_agg(a.dados || jsonb_build_object('id', a.id::text, 'lido', a.lido) order by a.criado_em desc)
      from (select * from rp_alertas where cadastro_id = v_id order by criado_em desc limit 500) a
  ), '[]'::jsonb);
end $$;

create or replace function public.rp_site_alertas_lidos(p_sessao text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  update rp_alertas set lido = true where cadastro_id = v_id and not lido;
  return true;
end $$;

create or replace function public.rp_site_alertas_limpar(p_sessao text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  delete from rp_alertas where cadastro_id = v_id and lido;
  return true;
end $$;

-- ---------- painel do administrador: agora mostra se usa o site e quantos monitorados ----------
drop function if exists public.rp_admin_listar(text);
create function public.rp_admin_listar(p_senha text)
returns table (id uuid, nome text, telefone text, versao text, acessos integer, criado_em timestamptz,
               ultimo_acesso timestamptz, usa_site boolean, monitorados integer)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform rp_admin_ok(p_senha);
  return query select c.id, c.nome, c.telefone, c.versao, c.acessos, c.criado_em, c.ultimo_acesso,
                      c.senha_hash is not null,
                      (select count(*)::int from rp_monitorados m where m.cadastro_id = c.id)
                 from rp_cadastros c order by c.criado_em desc;
end $$;

-- ---------- permissões ----------
revoke all on function public.rp_tel(text), public.rp_nova_sessao(uuid), public.rp_sessao_id(text),
  public.rp_site_cadastrar(text, text, text), public.rp_site_entrar(text, text), public.rp_site_sair(text),
  public.rp_site_eu(text), public.rp_site_trocar_senha(text, text, text), public.rp_site_monitorados(text),
  public.rp_site_salvar_monitorado(text, text, jsonb), public.rp_site_remover_monitorado(text, text),
  public.rp_site_alertas(text), public.rp_site_alertas_lidos(text), public.rp_site_alertas_limpar(text),
  public.rp_admin_listar(text)
  from public, anon, authenticated;

grant execute on function public.rp_site_cadastrar(text, text, text), public.rp_site_entrar(text, text), public.rp_site_sair(text),
  public.rp_site_eu(text), public.rp_site_trocar_senha(text, text, text), public.rp_site_monitorados(text),
  public.rp_site_salvar_monitorado(text, text, jsonb), public.rp_site_remover_monitorado(text, text),
  public.rp_site_alertas(text), public.rp_site_alertas_lidos(text), public.rp_site_alertas_limpar(text),
  public.rp_admin_listar(text)
  to anon, authenticated;

grant execute on function public.rp_sessao_id(text) to service_role;

-- ---------- agendamento (verifica os monitorados de hora em hora, pelo servidor de São Paulo) ----------
create extension if not exists pg_net;
create extension if not exists pg_cron;

insert into public.rp_config (chave, valor) values ('cron_segredo_hash', encode(extensions.digest('__CRON_SEGREDO__', 'sha256'), 'hex'))
on conflict (chave) do update set valor = excluded.valor;

select cron.unschedule(jobid) from cron.job where jobname = 'radar-processos-monitor';
select cron.schedule('radar-processos-monitor', '7 * * * *', $cron$
  select net.http_post(
    url := 'https://ovvenrskswsurqzjydby.supabase.co/functions/v1/radar',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-region', 'sa-east-1',
                                  'apikey', 'sb_publishable_AeRqPu_qi6TjK3F7ybRsYA_e151bNZg'),
    body := jsonb_build_object('acao', 'cron', 'segredo', '__CRON_SEGREDO__'),
    timeout_milliseconds := 150000
  );
$cron$);
