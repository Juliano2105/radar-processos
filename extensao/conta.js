/* Radar de Processos — cadastro simples (nome + telefone).
 * O servidor guarda SÓ nome, telefone, versão e data de acesso. As consultas, os processos,
 * os monitorados e os alertas de cada pessoa ficam apenas no Chrome dela — nunca são enviados.
 * Funciona na página e no service worker (sem DOM).
 */
(function (global) {
  const SUPABASE_URL = 'https://ovvenrskswsurqzjydby.supabase.co';
  // Chave pública (publishable): só permite chamar as funções rp_cadastrar e rp_ping.
  const SUPABASE_CHAVE = 'sb_publishable_AeRqPu_qi6TjK3F7ybRsYA_e151bNZg';

  const versao = () => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return ''; }
  };

  async function rpc(funcao, corpo) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${funcao}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_CHAVE, Authorization: `Bearer ${SUPABASE_CHAVE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
    if (!r.ok) throw new Error((j && (j.message || j.hint)) || `Falha no cadastro (HTTP ${r.status})`);
    return j;
  }

  const soDigitos = (s) => String(s || '').replace(/\D/g, '');

  function telefoneValido(t) {
    const d = soDigitos(t);
    return /^\d{10,11}$/.test(d) || /^55\d{10,11}$/.test(d);
  }
  function formatarTelefone(t) {
    let d = soDigitos(t);
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    if (d.length === 11) return d.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3');
    if (d.length === 10) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3');
    return t;
  }

  async function lerCadastro() {
    const { cadastro } = await chrome.storage.local.get('cadastro');
    return cadastro && cadastro.id && cadastro.token ? cadastro : null;
  }

  async function cadastrar(nome, telefone) {
    nome = String(nome || '').replace(/\s+/g, ' ').trim();
    if (nome.length < 3) throw new Error('Informe seu nome.');
    if (!telefoneValido(telefone)) throw new Error('Informe o telefone com DDD.');
    let tel = soDigitos(telefone);
    if (tel.length <= 11) tel = `55${tel}`;
    const r = await rpc('rp_cadastrar', { p_nome: nome, p_telefone: tel, p_versao: versao() });
    const cadastro = { id: r.id, token: r.token, nome, telefone: tel, em: new Date().toISOString(), ultimoPing: new Date().toISOString() };
    await chrome.storage.local.set({ cadastro });
    return cadastro;
  }

  /** Registra o uso no máximo uma vez a cada 12 horas. Falhas são ignoradas (não atrapalham o uso). */
  async function registrarUso() {
    const c = await lerCadastro();
    if (!c) return false;
    if (c.ultimoPing && Date.now() - new Date(c.ultimoPing).getTime() < 12 * 3600e3) return true;
    try {
      const ok = await rpc('rp_ping', { p_id: c.id, p_token: c.token, p_versao: versao() });
      if (ok === false) {
        // cadastro apagado no painel: pede para cadastrar de novo
        await chrome.storage.local.remove('cadastro');
        return false;
      }
      c.ultimoPing = new Date().toISOString();
      await chrome.storage.local.set({ cadastro: c });
    } catch (_) {}
    return true;
  }

  global.Conta = { lerCadastro, cadastrar, registrarUso, telefoneValido, formatarTelefone, SUPABASE_URL, SUPABASE_CHAVE };
})(typeof self !== 'undefined' ? self : globalThis);
