-- Radar de Processos — ajustes de 19/10/2026. Rode depois de radar-site-config.sql. Pode rodar de novo.

create or replace function public.rp_tel(p text)
returns text language sql immutable set search_path = public as $$
  select case when length(d) in (10, 11) then '55' || d else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;

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
