/* Radar de Processos — segundo plano: abrir a tela, guardar a sessão do jus.br, monitorar e avisar. */
importScripts('lib.js', 'conta.js');

const CONFIG_PADRAO = {
  intervaloHoras: 6,
  notificacoes: true,
  avisarPublicacoes: true,
  webhookUrl: '',
  chaveTransparencia: '',
  fontesPadrao: { djen: true, pdpj: true, esaj: Object.keys(Radar.ESAJ), transparencia: false },
};
const MAX_ALERTAS = 500;
const MAX_PUBS_VISTAS = 5000;

async function lerConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...CONFIG_PADRAO, ...(config || {}) };
}

async function agendar() {
  const cfg = await lerConfig();
  await chrome.alarms.clear('radar');
  chrome.alarms.create('radar', { delayInMinutes: 1, periodInMinutes: Math.max(1, cfg.intervaloHoras) * 60 });
}

chrome.runtime.onInstalled.addListener(() => { agendar(); atualizarBadge(); });
chrome.runtime.onStartup.addListener(() => { agendar(); atualizarBadge(); });

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const abas = await chrome.tabs.query({ url: `${url}*` });
  if (abas.length) {
    await chrome.tabs.update(abas[0].id, { active: true });
    await chrome.windows.update(abas[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html#alertas') });
});

chrome.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name === 'radar') verificarTodos().catch((e) => console.error('Radar:', e));
});

chrome.runtime.onMessage.addListener((msg, sender, responder) => {
  (async () => {
    if (msg.tipo === 'tokenPdpj') return guardarToken(msg.token, sender);
    if (msg.tipo === 'verificarAgora') return verificarTodos(msg.doc);
    if (msg.tipo === 'reagendar') return agendar();
    if (msg.tipo === 'badge') return atualizarBadge();
    if (msg.tipo === 'testarWebhook') return enviarWebhook(msg.url, { teste: true, mensagem: 'Teste do Radar de Processos' });
  })()
    .then((r) => responder({ ok: true, resultado: r }))
    .catch((e) => responder({ ok: false, erro: String(e.message || e) }));
  return true;
});

/* ---------- sessão do jus.br ---------- */
async function guardarToken(token, sender) {
  const origem = sender && sender.url ? new URL(sender.url).hostname : '';
  if (!/(^|\.)jus\.br$/.test(origem)) return false;
  if (!Radar.tokenValido(token)) return false;
  const dados = Radar.lerJwt(token) || {};
  const { pdpj } = await chrome.storage.local.get('pdpj');
  if (pdpj && pdpj.token === token) return true;
  if (pdpj && pdpj.exp && pdpj.exp > (dados.exp || 0) && Radar.tokenValido(pdpj.token)) return true;
  await chrome.storage.local.set({
    pdpj: { token, exp: dados.exp, nome: dados.name || dados.preferred_username || '', capturado: new Date().toISOString() },
  });
  return true;
}
async function lerToken() {
  const { pdpj } = await chrome.storage.local.get('pdpj');
  return pdpj && Radar.tokenValido(pdpj.token) ? pdpj.token : null;
}

/* ---------- utilidades ---------- */
function dataISO(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

async function atualizarBadge() {
  const { alertas = [] } = await chrome.storage.local.get('alertas');
  const n = alertas.filter((a) => !a.lido).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  await chrome.action.setBadgeText({ text: n ? String(n > 99 ? '99+' : n) : '' });
}

async function enviarWebhook(url, corpo) {
  if (!url) return null;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  if (!r.ok) throw new Error(`Webhook respondeu HTTP ${r.status}`);
  return r.status;
}

/* ---------- monitoramento ---------- */
let rodando = false;

/** Busca o que for recente/novo para um monitorado e devolve os achados de cada fonte. */
async function buscarNovidades(m, cfg, token) {
  const agora = new Date();
  const base = m.ultimaVerificacao ? new Date(m.ultimaVerificacao) : new Date(agora.getTime() - 30 * 864e5);
  const desde = dataISO(new Date(base.getTime() - 3 * 864e5)); // folga para publicações indexadas com atraso
  const fontes = m.fontes || cfg.fontesPadrao;
  const blocos = [];
  const avisos = [];
  m.esajTotais = m.esajTotais || {};

  if (fontes.djen) {
    try {
      const r = await Radar.fonteDjen({ doc: m.doc, nomes: m.nomesBusca || [], desde, ate: dataISO(agora), maxPaginas: 10 });
      blocos.push({ id: 'djen', achados: r.achados });
    } catch (e) { avisos.push(`DJEN: ${e.message}`); }
  }

  for (const s of fontes.esaj || []) {
    try {
      const c = await Radar.fonteEsaj(s, { doc: m.doc, somenteContagem: true });
      if (c.total && c.total !== m.esajTotais[s]) {
        const r = c.total <= 25 ? c : await Radar.fonteEsaj(s, { doc: m.doc, maxPaginas: 20 });
        blocos.push({ id: `esaj-${s}`, achados: r.achados });
      } else {
        blocos.push({ id: `esaj-${s}`, achados: c.achados });
      }
      m.esajTotais[s] = c.total;
    } catch (e) { avisos.push(`e-SAJ ${s}: ${e.message}`); }
    await Radar.sleep(500);
  }

  if (fontes.pdpj) {
    if (!token) avisos.push('jus.br: sessão expirada — abra o jus.br e entre com gov.br');
    else {
      try {
        const r = await Radar.fontePdpj({ doc: m.doc, token, maxPaginas: 10 });
        blocos.push({ id: 'pdpj', achados: r.achados });
      } catch (e) { avisos.push(`jus.br: ${e.message}`); }
    }
  }

  let sancoesNovas = 0;
  if (fontes.transparencia && cfg.chaveTransparencia) {
    try {
      const r = await Radar.fonteTransparencia({ doc: m.doc, chave: cfg.chaveTransparencia });
      const n = r.sancoes.length;
      if (typeof m.totalSancoes === 'number' && n > m.totalSancoes) sancoesNovas = n - m.totalSancoes;
      m.totalSancoes = n;
    } catch (e) { avisos.push(`Transparência: ${e.message}`); }
  }

  return { processos: Radar.mesclar(blocos, m.nomesAlvo || []), avisos, sancoesNovas };
}

async function verificarTodos(somenteDoc) {
  if (rodando) return { ocupado: true };
  if (!(await Conta.lerCadastro())) return [];
  rodando = true;
  Conta.registrarUso().catch(() => {});
  try {
    const cfg = await lerConfig();
    const token = await lerToken();
    const dados = await chrome.storage.local.get(['monitorados', 'alertas']);
    const monitorados = dados.monitorados || {};
    let alertas = dados.alertas || [];
    const resumo = [];

    for (const doc of Object.keys(monitorados)) {
      if (somenteDoc && doc !== somenteDoc) continue;
      const m = monitorados[doc];
      m.doc = m.doc || doc;
      const { processos, avisos, sancoesNovas } = await buscarNovidades(m, cfg, token);

      const vistos = new Set(m.vistos || []);
      const pubsVistas = new Set(m.pubsVistas || []);
      const novos = [];
      const novasPubs = [];
      for (const p of processos) {
        const ehNovo = !vistos.has(p.numero);
        if (ehNovo) { novos.push(p); vistos.add(p.numero); }
        for (const pub of p.publicacoes) {
          const chave = String(pub.id);
          if (!pubsVistas.has(chave)) {
            pubsVistas.add(chave);
            if (!ehNovo) novasPubs.push({ p, pub });
          }
        }
      }

      const alvo = m.nome || Radar.formatarDoc(doc);
      const quando = new Date().toISOString();
      const base = (p) => ({
        quando, doc, empresa: alvo, numero: p.numeroMascara, tribunal: p.tribunal, classe: p.classe,
        categoria: p.categoria, polo: Radar.poloTexto(p.poloAlvo), fontes: p.fontes, lido: false,
      });
      for (const p of novos) {
        alertas.unshift({ ...base(p), id: `${doc}-${p.numero}-${Date.now()}`, tipo: 'processo', data: p.ultima || p.distribuicao, link: (p.publicacoes[0] || {}).link || (p.links[0] || {}).url || '' });
      }
      if (cfg.avisarPublicacoes) {
        for (const { p, pub } of novasPubs) {
          alertas.unshift({ ...base(p), id: `${doc}-${pub.id}`, tipo: 'publicacao', data: pub.data, documento: pub.tipo, link: pub.link || '' });
        }
      }
      if (sancoesNovas) {
        alertas.unshift({ quando, doc, empresa: alvo, id: `${doc}-sancao-${Date.now()}`, tipo: 'sancao', numero: `${sancoesNovas} nova(s) sanção(ões)`, tribunal: 'CGU', classe: 'Portal da Transparência', categoria: 'Sanção', lido: false });
      }

      m.vistos = [...vistos];
      m.pubsVistas = [...pubsVistas].slice(-MAX_PUBS_VISTAS);
      m.totalProcessos = vistos.size;
      m.ultimaVerificacao = quando;
      m.ultimoErro = avisos.join(' · ');
      resumo.push({ doc, novos: novos.length, novasPubs: novasPubs.length, avisos });

      const nPubs = cfg.avisarPublicacoes ? novasPubs.length : 0;
      const totalAvisos = novos.length + nPubs + sancoesNovas;
      if (totalAvisos && cfg.notificacoes) {
        const partes = [];
        if (novos.length) partes.push(`${novos.length} processo(s) novo(s)`);
        if (nPubs) partes.push(`${nPubs} nova(s) publicação(ões)`);
        if (sancoesNovas) partes.push(`${sancoesNovas} sanção(ões) nova(s)`);
        chrome.notifications.create(`radar-${doc}-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'icons/128.png',
          title: `Radar: ${alvo}`,
          message: partes.join(' e ') + (novos[0] ? `\n${novos[0].numeroMascara} · ${novos[0].tribunal} · ${novos[0].categoria}` : ''),
          priority: 2,
        });
      }
      if (totalAvisos && cfg.webhookUrl) {
        try {
          await enviarWebhook(cfg.webhookUrl, {
            origem: 'radar-de-processos',
            documento: Radar.formatarDoc(doc),
            nome: alvo,
            processosNovos: novos.map((p) => ({
              numero: p.numeroMascara, tribunal: p.tribunal, classe: p.classe, categoria: p.categoria,
              polo: Radar.poloTexto(p.poloAlvo), fontes: p.fontes, data: p.ultima || p.distribuicao,
              link: (p.publicacoes[0] || {}).link || (p.links[0] || {}).url || '',
            })),
            novasPublicacoes: nPubs ? novasPubs.map(({ p, pub }) => ({ numero: p.numeroMascara, tribunal: p.tribunal, data: pub.data, tipo: pub.tipo, link: pub.link })) : [],
            sancoesNovas,
          });
        } catch (e) {
          m.ultimoErro = [m.ultimoErro, `Webhook: ${e.message || e}`].filter(Boolean).join(' · ');
        }
      }
    }

    alertas = alertas.slice(0, MAX_ALERTAS);
    await chrome.storage.local.set({ monitorados, alertas, ultimaRodada: new Date().toISOString() });
    await atualizarBadge();
    return resumo;
  } finally {
    rodando = false;
  }
}
