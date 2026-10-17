-- Radar de Processos — site, parte 2: configurações por usuário e alertas vindos da verificação feita na tela.
-- Rode depois de radar-site.sql. Pode rodar de novo sem problema.

alter table public.rp_cadastros add column if not exists config jsonb not null default '{}'::jsonb;

create or replace function public.rp_site_config(p_sessao text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  return coalesce((select config from rp_cadastros where id = v_id), '{}'::jsonb);
end $$;

create or replace function public.rp_site_salvar_config(p_sessao text, p_config jsonb)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao); v_horas int;
begin
  if jsonb_typeof(p_config) <> 'object' or pg_column_size(p_config) > 20000 then raise exception 'Configuração inválida.'; end if;
  update rp_cadastros set config = p_config where id = v_id;
  -- novo intervalo vale já para a próxima verificação
  v_horas := greatest(1, least(48, coalesce((p_config->>'intervaloHoras')::int, 6)));
  update rp_monitorados set proxima_verificacao = least(proxima_verificacao, now() + make_interval(hours => v_horas))
   where cadastro_id = v_id;
  return true;
end $$;

-- alertas gerados quando a pessoa clica em "Verificar agora" no site
create or replace function public.rp_site_adicionar_alertas(p_sessao text, p_alertas jsonb)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  if jsonb_typeof(p_alertas) <> 'array' or jsonb_array_length(p_alertas) > 300 or pg_column_size(p_alertas) > 400000 then
    raise exception 'Alertas inválidos.';
  end if;
  insert into rp_alertas (cadastro_id, dados)
  select v_id, a - 'lido' from jsonb_array_elements(p_alertas) with ordinality as x(a, n)
   where jsonb_typeof(a) = 'object' order by n desc;
  delete from rp_alertas where cadastro_id = v_id and id not in
    (select id from rp_alertas where cadastro_id = v_id order by criado_em desc, id desc limit 500);
  return true;
end $$;

revoke all on function public.rp_site_config(text), public.rp_site_salvar_config(text, jsonb),
  public.rp_site_adicionar_alertas(text, jsonb) from public, anon, authenticated;
grant execute on function public.rp_site_config(text), public.rp_site_salvar_config(text, jsonb),
  public.rp_site_adicionar_alertas(text, jsonb) to anon, authenticated;

-- alertas mais novos primeiro também quando chegam juntos
create or replace function public.rp_site_alertas(p_sessao text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid := rp_sessao_id(p_sessao);
begin
  return coalesce((
    select jsonb_agg(a.dados || jsonb_build_object('id', a.id::text, 'lido', a.lido) order by a.criado_em desc, a.id desc)
      from (select * from rp_alertas where cadastro_id = v_id order by criado_em desc, id desc limit 500) a
  ), '[]'::jsonb);
end $$;
