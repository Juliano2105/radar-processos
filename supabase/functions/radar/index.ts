// Radar de Processos — servidor do site (Supabase Edge Function "radar").
// Rode sempre na região de São Paulo (cabeçalho x-region: sa-east-1): o DJEN só responde a IP do Brasil.
//
// Ações:
//  - proxy: o site pede uma página de fonte pública (DJEN, e-SAJ, Transparência). Exige sessão válida.
//  - cron:  chamado pelo agendamento do banco de hora em hora. Verifica os monitorados vencidos,
//           grava os alertas de cada dono e avisa no WhatsApp (Evolution API, se configurada).
//  - whatsapp_meu: o site manda o aviso de um "Verificar agora" para o WhatsApp do PRÓPRIO dono da sessão.
//
// O núcleo (extensao/lib.js e extensao/monitor.js) vem embutido na publicação como reserva e,
// a cada 10 minutos, é recarregado do GitHub (branch main): mudou no GitHub, o servidor acompanha sozinho.
// Ao publicar, os imports abaixo apontam para o jsDelivr no commit atual.
import './lib.js';
import './monitor.js';

// deno-lint-ignore no-explicit-any
const G = globalThis as any;
const NUCLEO_URL = 'https://raw.githubusercontent.com/Juliano2105/radar-processos/main/extensao/';
const nucleo = { versao: 'embutido', checado: 0 };

/** Recarrega lib.js e monitor.js do GitHub se mudaram. Se algo falhar, continua com o que já está carregado. */
async function atualizarNucleo() {
  if (Date.now() - nucleo.checado < 10 * 60e3) return;
  nucleo.checado = Date.now();
  try {
    const [lib, mon] = await Promise.all(['lib.js', 'monitor.js'].map(async (f) => {
      const r = await fetchNativo(`${NUCLEO_URL}${f}?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`${f} HTTP ${r.status}`);
      return r.text();
    }));
    if (lib.length < 5000 || mon.length < 2000) throw new Error('arquivo incompleto');
    const versao = (await sha256(lib + mon)).slice(0, 12);
    if (versao === nucleo.versao) return;
    const antes = { Radar: G.Radar, Monitor: G.Monitor };
    try {
      (0, eval)(lib);
      (0, eval)(mon);
      if (typeof G.Radar?.mesclar !== 'function' || typeof G.Monitor?.verificarUm !== 'function') throw new Error('núcleo inválido');
      nucleo.versao = versao;
    } catch (e) {
      G.Radar = antes.Radar;
      G.Monitor = antes.Monitor;
      throw e;
    }
  } catch (e) {
    console.warn('Radar: núcleo do GitHub não carregou, seguindo com o atual:', (e as Error).message);
  }
}

const SB = Deno.env.get('SUPABASE_URL')!;
const SR = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const fetchNativo: typeof fetch = globalThis.fetch.bind(globalThis);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const HOSTS = new Set([
  'comunicaapi.pje.jus.br',
  'esaj.tjsp.jus.br', 'esaj.tjms.jus.br', 'www2.tjal.jus.br', 'esaj.tjce.jus.br', 'consultasaj.tjam.jus.br', 'esaj.tjac.jus.br',
  'api.portaldatransparencia.gov.br', 'brasilapi.com.br', 'minhareceita.org',
]);
const MAX_CORPO = 6 * 1024 * 1024;
const NAVEGADOR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ---------- banco (service role) ---------- */
async function sb(caminho: string, init: RequestInit = {}) {
  const r = await fetchNativo(`${SB}/rest/v1/${caminho}`, {
    ...init,
    headers: { apikey: SR, Authorization: `Bearer ${SR}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch (_) { /* texto */ }
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || `banco HTTP ${r.status}`);
  return j;
}

const sessoes = new Map<string, { id: string; ate: number }>();
async function donoDaSessao(sessao: unknown): Promise<string> {
  if (typeof sessao !== 'string' || sessao.length < 20 || sessao.length > 200) throw new Error('Sessão expirada. Entre de novo.');
  const c = sessoes.get(sessao);
  if (c && c.ate > Date.now()) return c.id;
  const id = await sb('rpc/rp_sessao_id', { method: 'POST', body: JSON.stringify({ p_sessao: sessao }) });
  if (!id) throw new Error('Sessão expirada. Entre de novo.');
  sessoes.set(sessao, { id, ate: Date.now() + 60e3 });
  if (sessoes.size > 5000) sessoes.clear();
  return id;
}

async function sha256(t: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function config(chave: string): Promise<string | null> {
  const r = await sb(`rp_config?chave=eq.${encodeURIComponent(chave)}&select=valor`);
  return r && r[0] ? r[0].valor : null;
}

/* ---------- busca nas fontes, com cookies e cabeçalhos certos ---------- */
type Jar = Map<string, Map<string, string>>;

function cabecalhosFonte(url: URL, extra: Record<string, string> = {}) {
  const h: Record<string, string> = { 'User-Agent': NAVEGADOR, 'Accept-Language': 'pt-BR,pt;q=0.9', ...extra };
  if (url.hostname === 'comunicaapi.pje.jus.br') {
    h.Origin = 'https://comunica.pje.jus.br';
    h.Referer = 'https://comunica.pje.jus.br/';
  }
  return h;
}

function guardarCookies(jar: Jar, host: string, r: Response) {
  // deno-lint-ignore no-explicit-any
  const lista: string[] = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : [];
  if (!lista.length) return;
  const m = jar.get(host) || new Map();
  for (const sc of lista) {
    const par = sc.split(';')[0];
    const i = par.indexOf('=');
    if (i > 0) m.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
  jar.set(host, m);
}
const cookieDe = (jar: Jar, host: string) => [...(jar.get(host) || new Map()).entries()].map(([k, v]) => `${k}=${v}`).join('; ');

/** GET numa fonte permitida, seguindo redirecionamentos e guardando cookies. */
async function buscarFonte(endereco: string, jar: Jar, extra: Record<string, string> = {}) {
  let url = new URL(endereco);
  for (let i = 0; i < 6; i++) {
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) throw new Error(`Endereço não permitido: ${url.hostname}`);
    const h = cabecalhosFonte(url, extra);
    const ck = cookieDe(jar, url.hostname);
    if (ck) h.Cookie = ck;
    const r = await fetchNativo(url.href, { headers: h, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    guardarCookies(jar, url.hostname, r);
    const destino = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && destino) {
      await r.body?.cancel();
      url = new URL(destino, url);
      continue;
    }
    return { r, url: url.href };
  }
  throw new Error('Redirecionamentos demais.');
}

/** fetch usado pelo lib.js dentro do servidor (um pote de cookies por verificação). */
function fetchDoServidor(jar: Jar) {
  return async (entrada: string | URL | Request, init: RequestInit = {}) => {
    const endereco = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const extra: Record<string, string> = {};
    new Headers(init.headers || {}).forEach((v, k) => { if (k === 'accept' || k === 'chave-api-dados') extra[k] = v; });
    const { r, url } = await buscarFonte(endereco, jar, extra);
    const corpo = await r.arrayBuffer();
    const resp = new Response(r.status === 204 ? null : corpo, { status: r.status, headers: r.headers });
    Object.defineProperty(resp, 'url', { value: url });
    return resp;
  };
}

/* ---------- ação: proxy ---------- */
function b64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

// deno-lint-ignore no-explicit-any
async function proxy(corpo: any) {
  await donoDaSessao(corpo.sessao);
  const jar: Jar = new Map();
  let host = '';
  try { host = new URL(String(corpo.url)).hostname; } catch (_) { return json({ erro: 'Endereço inválido.' }, 400); }
  if (!HOSTS.has(host)) return json({ erro: 'Endereço não permitido.' }, 400);
  if (typeof corpo.cookie === 'string' && corpo.cookie.length < 4000) {
    const m = new Map<string, string>();
    corpo.cookie.split(';').forEach((p: string) => { const i = p.indexOf('='); if (i > 0) m.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });
    jar.set(host, m);
  }
  const extra: Record<string, string> = {};
  if (corpo.cabecalhos && typeof corpo.cabecalhos === 'object') {
    for (const k of ['accept', 'chave-api-dados']) if (typeof corpo.cabecalhos[k] === 'string') extra[k] = corpo.cabecalhos[k].slice(0, 300);
  }
  const { r, url } = await buscarFonte(String(corpo.url), jar, extra);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_CORPO) return json({ erro: 'Resposta grande demais.' }, 502);
  const fim = new URL(url).hostname;
  return json({ status: r.status, tipo: r.headers.get('content-type') || '', url, corpo: b64(buf), cookie: cookieDe(jar, fim), host: fim });
}

/* ---------- ação: cron ---------- */
const configPadrao = () => ({
  intervaloHoras: 6, notificacoes: true, avisarPublicacoes: true, chaveTransparencia: '',
  fontesPadrao: { djen: true, pdpj: false, esaj: Object.keys(G.Radar.ESAJ), transparencia: false },
});

async function whatsapp(telefone: string, texto: string) {
  const [url, chave, instancia] = await Promise.all([config('evo_url'), config('evo_chave'), config('evo_instancia')]);
  if (!url || !chave || !instancia || !texto) return false;
  const r = await fetchNativo(`${url.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(instancia)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: chave },
    body: JSON.stringify({ number: telefone, text: texto, textMessage: { text: texto } }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`WhatsApp HTTP ${r.status}`);
  return true;
}

// deno-lint-ignore no-explicit-any
async function cron(corpo: any) {
  const hash = await config('cron_segredo_hash');
  if (!hash || typeof corpo.segredo !== 'string' || (await sha256(corpo.segredo)) !== hash) return json({ erro: 'não autorizado' }, 401);
  await atualizarNucleo();
  const Monitor = G.Monitor;
  const CONFIG_PADRAO = configPadrao();
  const inicio = Date.now();
  const agora = new Date().toISOString();
  const fila = await sb(
    `rp_monitorados?select=id,cadastro_id,doc,dados,rp_cadastros(telefone,config)&proxima_verificacao=lte.${encodeURIComponent(agora)}&order=proxima_verificacao.asc&limit=25`,
  );
  const feitos = [];
  for (const item of fila || []) {
    if (Date.now() - inicio > 100e3) break; // deixa o resto para a próxima rodada
    const dono = item.rp_cadastros || {};
    const cfg = { ...CONFIG_PADRAO, ...(dono.config || {}), usarPdpj: false };
    const horas = Math.max(1, Math.min(48, Number(cfg.intervaloHoras) || 6));
    const m = { ...(item.dados || {}), doc: item.doc };
    m.fontes = { ...(m.fontes || CONFIG_PADRAO.fontesPadrao), pdpj: false };
    // marca já a próxima, para outra rodada não pegar o mesmo item.
    // Conta a partir do início da rodada e com 10 min de folga: senão a rodada de daqui a N horas,
    // que começa no mesmo minuto, chega segundos antes e o item fica para a hora seguinte.
    await sb(`rp_monitorados?id=eq.${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ proxima_verificacao: new Date(inicio + horas * 3600e3 - 10 * 60e3).toISOString() }),
    });
    const jar: Jar = new Map();
    G.fetch = fetchDoServidor(jar);
    try {
      const r = await Monitor.verificarUm(m, cfg, null);
      if (r.alertas.length) {
        const linhas = [...r.alertas].reverse().map((a: Record<string, unknown>) => {
          const { lido: _l, ...dados } = a;
          return { cadastro_id: item.cadastro_id, dados };
        });
        await sb('rp_alertas', { method: 'POST', body: JSON.stringify(linhas), headers: { Prefer: 'return=minimal' } });
      }
      if (r.total && cfg.notificacoes !== false && dono.telefone) {
        try { await whatsapp(dono.telefone, Monitor.textoWhatsapp(r)); } catch (e) {
          m.ultimoErro = [m.ultimoErro, `WhatsApp: ${(e as Error).message}`].filter(Boolean).join(' · ');
        }
      }
      await sb(`rp_monitorados?id=eq.${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ dados: Monitor.compactar(m), atualizado_em: new Date().toISOString() }),
        headers: { Prefer: 'return=minimal' },
      });
      feitos.push({ doc: item.doc.slice(0, 4) + '…', novos: r.resumo.novos, avisos: r.resumo.avisos.length });
    } catch (e) {
      feitos.push({ doc: item.doc.slice(0, 4) + '…', erro: (e as Error).message });
    } finally {
      G.fetch = fetchNativo;
    }
  }
  return json({ ok: true, verificados: feitos.length, pendentes: (fila || []).length - feitos.length, feitos, regiao: Deno.env.get('SB_REGION') || '', nucleo: nucleo.versao });
}

/* ---------- ação: whatsapp_meu ---------- */
const envios = new Map<string, number[]>();
// deno-lint-ignore no-explicit-any
async function whatsappMeu(corpo: any) {
  const id = await donoDaSessao(corpo.sessao);
  const texto = typeof corpo.texto === 'string' ? corpo.texto.slice(0, 3500).trim() : '';
  if (!texto) return json({ erro: 'Mensagem vazia.' }, 400);
  const agora = Date.now();
  const recentes = (envios.get(id) || []).filter((t) => agora - t < 3600e3);
  if (recentes.length >= 10) return json({ erro: 'Muitos avisos nesta hora.' }, 429);
  const r = await sb(`rp_cadastros?id=eq.${id}&select=telefone,config`);
  const dono = r && r[0];
  if (!dono || !dono.telefone) return json({ erro: 'Cadastro não encontrado.' }, 404);
  if (dono.config && dono.config.notificacoes === false) return json({ ok: true, enviado: false, motivo: 'desligado' });
  recentes.push(agora);
  envios.set(id, recentes);
  const enviado = await whatsapp(dono.telefone, texto);
  return json({ ok: true, enviado });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ erro: 'use POST' }, 405);
  // deno-lint-ignore no-explicit-any
  let corpo: any = {};
  try { corpo = await req.json(); } catch (_) { return json({ erro: 'JSON inválido' }, 400); }
  try {
    if (corpo.acao === 'proxy') return await proxy(corpo);
    if (corpo.acao === 'cron') return await cron(corpo);
    if (corpo.acao === 'whatsapp_meu') return await whatsappMeu(corpo);
    return json({ erro: 'ação desconhecida' }, 400);
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return json({ erro: msg }, /Sess[aã]o/.test(msg) ? 401 : 500);
  }
});
