/* Radar de Processos — segundo plano: abrir a tela, guardar a sessão do jus.br, monitorar e avisar. */
importScripts('lib.js', 'monitor.js', 'conta.js');

const CONFIG_PADRAO = {
  intervaloHoras: 6,
  notificacoes: true,
  avisarPublicacoes: true,
  webhookUrl: '',
  chaveTransparencia: '',
  fontesPadrao: { djen: true, pdpj: true, esaj: Object.keys(Radar.ESAJ), transparencia: false },
};
const MAX_ALERTAS = 500;

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

/* ---------- monitoramento (núcleo em monitor.js) ---------- */
let rodando = false;

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
      const r = await Monitor.verificarUm(m, cfg, token);
      alertas = [...r.alertas, ...alertas];
      resumo.push(r.resumo);

      if (r.total && cfg.notificacoes) {
        chrome.notifications.create(`radar-${doc}-${Date.now()}`, {
          type: 'basic', iconUrl: 'icons/128.png', title: r.titulo, message: r.mensagem, priority: 2,
        });
      }
      if (r.total && cfg.webhookUrl) {
        try {
          await enviarWebhook(cfg.webhookUrl, r.webhook);
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
