/* Radar de Processos — modo SITE.
 * A mesma tela da extensão roda no navegador comum. Este arquivo entra entre conta.js e app.js e:
 *  - troca o cadastro por login com telefone + senha;
 *  - guarda monitorados, alertas e configurações no servidor, sempre presos à sessão do próprio usuário
 *    (o banco só entrega dados do dono da sessão — ninguém vê o que o outro monitora);
 *  - manda as consultas ao DJEN/e-SAJ/Transparência pelo servidor em São Paulo (o DJEN só aceita IP do Brasil);
 *  - esconde o que só existe na extensão (jus.br com gov.br, webhook, notificação do Chrome).
 * Na extensão este arquivo NÃO é carregado.
 */
(function () {
  const SB = 'https://ovvenrskswsurqzjydby.supabase.co';
  const CHAVE = 'sb_publishable_AeRqPu_qi6TjK3F7ybRsYA_e151bNZg';
  const FUNCAO = `${SB}/functions/v1/radar?forceFunctionRegion=sa-east-1`;
  const PELO_SERVIDOR = new Set([
    'comunicaapi.pje.jus.br',
    ...Object.values(Radar.ESAJ).map((t) => new URL(t.base).hostname),
    'api.portaldatransparencia.gov.br',
  ]);
  const CHAVE_SESSAO = 'radar_sessao';
  const fetchNativo = window.fetch.bind(window);

  /* ---------- sessão ---------- */
  const lerSessao = () => { try { return JSON.parse(localStorage.getItem(CHAVE_SESSAO) || 'null'); } catch (_) { return null; } };
  const gravarSessao = (s) => { try { s ? localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)) : localStorage.removeItem(CHAVE_SESSAO); } catch (_) {} };
  let sessao = lerSessao();

  async function rpc(funcao, corpo) {
    const r = await fetchNativo(`${SB}/rest/v1/rpc/${funcao}`, {
      method: 'POST',
      headers: { apikey: CHAVE, Authorization: `Bearer ${CHAVE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const t = await r.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch (_) {}
    if (!r.ok) {
      const msg = (j && (j.message || j.hint)) || `Falha (HTTP ${r.status})`;
      if (/Sess[aã]o expirada/i.test(msg)) sair(true);
      throw new Error(msg);
    }
    return j;
  }
  const rpcS = (funcao, corpo = {}) => rpc(funcao, { p_sessao: sessao && sessao.sessao, ...corpo });

  /* ---------- dados do usuário (cópia local do que está no servidor) ---------- */
  const dados = { monitorados: {}, alertas: [], config: {}, ultimaRodada: null };
  let pronto = Promise.resolve();
  const ouvintes = [];
  const avisar = (mud) => ouvintes.forEach((f) => { try { f(mud, 'local'); } catch (e) { console.error(e); } });
  const copia = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

  async function carregar() {
    if (!sessao) return;
    const [mon, al, cfg] = await Promise.all([rpcS('rp_site_monitorados'), rpcS('rp_site_alertas'), rpcS('rp_site_config')]);
    dados.monitorados = mon || {};
    dados.alertas = al || [];
    dados.config = cfg || {};
    try { dados.ultimaRodada = localStorage.getItem('radar_ultimaRodada'); } catch (_) {}
    avisar({ monitorados: {}, alertas: {}, config: {} });
  }
  function recarregar() {
    pronto = carregar().catch((e) => console.warn('Radar:', e.message));
    return pronto;
  }

  function configParaTela() {
    const c = { ...dados.config };
    const f = c.fontesPadrao || { djen: true, esaj: Object.keys(Radar.ESAJ), transparencia: false };
    c.fontesPadrao = { ...f, pdpj: false };
    c.webhookUrl = '';
    if (typeof c.notificacoes !== 'boolean') c.notificacoes = true;
    return c;
  }

  async function salvarMonitorados(novos) {
    const antigos = dados.monitorados;
    const tarefas = [];
    for (const doc of Object.keys(novos)) {
      if (JSON.stringify(novos[doc]) !== JSON.stringify(antigos[doc])) {
        tarefas.push(rpcS('rp_site_salvar_monitorado', { p_doc: doc, p_dados: Monitor.compactar(novos[doc]) }));
      }
    }
    for (const doc of Object.keys(antigos)) {
      if (!(doc in novos)) tarefas.push(rpcS('rp_site_remover_monitorado', { p_doc: doc }));
    }
    await Promise.all(tarefas);
    dados.monitorados = copia(novos);
  }

  async function salvarAlertas(novos) {
    const antigos = dados.alertas;
    if (novos.length < antigos.length) await rpcS('rp_site_alertas_limpar');
    else if (novos.some((a) => a.lido) && antigos.some((a) => !a.lido)) await rpcS('rp_site_alertas_lidos');
    dados.alertas = copia(novos);
  }

  /* ---------- chrome.* de mentira ---------- */
  const storage = {
    async get(chaves) {
      await pronto;
      const lista = chaves == null ? ['monitorados', 'alertas', 'config', 'ultimaRodada', 'cadastro'] : [].concat(chaves);
      const o = {};
      for (const k of lista) {
        if (k === 'config') o.config = configParaTela();
        else if (k === 'cadastro') { if (sessao) o.cadastro = { id: 'site', token: sessao.sessao, nome: sessao.nome, telefone: sessao.telefone }; }
        else if (k === 'pdpj') { /* jus.br só na extensão */ }
        else if (k in dados && dados[k] != null) o[k] = copia(dados[k]);
      }
      return o;
    },
    async set(obj) {
      await pronto;
      const mud = {};
      if (obj.monitorados) { await salvarMonitorados(obj.monitorados); mud.monitorados = { newValue: obj.monitorados }; }
      if (obj.alertas) { await salvarAlertas(obj.alertas); mud.alertas = { newValue: obj.alertas }; }
      if (obj.config) {
        const { webhookUrl: _w, ...cfg } = obj.config;
        await rpcS('rp_site_salvar_config', { p_config: cfg });
        dados.config = cfg;
        mud.config = { newValue: cfg };
      }
      if (obj.ultimaRodada) {
        dados.ultimaRodada = obj.ultimaRodada;
        try { localStorage.setItem('radar_ultimaRodada', obj.ultimaRodada); } catch (_) {}
      }
      avisar(mud);
    },
    async remove(chaves) {
      if ([].concat(chaves).includes('cadastro')) sair(false);
    },
  };

  let verificando = false;
  async function verificarAgora(somenteDoc) {
    if (verificando) return { ocupado: true };
    verificando = true;
    try {
      await pronto;
      const cfg = { ...configParaTela(), usarPdpj: false };
      const resumo = [];
      const novosAlertas = [];
      for (const doc of Object.keys(dados.monitorados)) {
        if (somenteDoc && doc !== somenteDoc) continue;
        const m = copia(dados.monitorados[doc]);
        m.doc = m.doc || doc;
        const r = await Monitor.verificarUm(m, cfg, null);
        novosAlertas.unshift(...r.alertas);
        resumo.push(r.resumo);
        await rpcS('rp_site_salvar_monitorado', { p_doc: doc, p_dados: Monitor.compactar(m) });
        dados.monitorados[doc] = m;
      }
      if (novosAlertas.length) {
        await rpcS('rp_site_adicionar_alertas', { p_alertas: novosAlertas.slice(0, 300) });
        dados.alertas = (await rpcS('rp_site_alertas')) || [];
      }
      await storage.set({ ultimaRodada: new Date().toISOString() });
      avisar({ monitorados: {}, alertas: {} });
      return resumo;
    } finally {
      verificando = false;
    }
  }

  window.chrome = {
    storage: { local: storage, onChanged: { addListener: (f) => ouvintes.push(f) } },
    runtime: {
      getManifest: () => ({ version: 'site' }),
      getURL: (x) => x,
      onMessage: { addListener() {} },
      async sendMessage(msg) {
        try {
          if (msg.tipo === 'verificarAgora') return { ok: true, resultado: await verificarAgora(msg.doc) };
          return { ok: true, resultado: null };
        } catch (e) { return { ok: false, erro: e.message || String(e) }; }
      },
    },
    tabs: { create: ({ url }) => window.open(url, '_blank', 'noopener') },
    permissions: { request: async () => true },
  };

  /* ---------- consultas às fontes passam pelo servidor ---------- */
  const potes = new Map(); // cookies por site (e-SAJ precisa para paginar)
  function base64ParaBytes(b64) {
    const s = atob(b64);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  window.fetch = async function (entrada, init = {}) {
    const endereco = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    let host = '';
    try { host = new URL(endereco, location.href).hostname; } catch (_) {}
    if (!PELO_SERVIDOR.has(host)) return fetchNativo(entrada, init);
    if (!sessao) throw new Error('Entre com seu telefone e senha para consultar.');
    const cab = {};
    new Headers(init.headers || {}).forEach((v, k) => { if (k === 'accept' || k === 'chave-api-dados') cab[k] = v; });
    let r;
    let j = {};
    for (let tentativa = 0; ; tentativa++) {
      try {
        r = await fetchNativo(FUNCAO, {
          method: 'POST',
          headers: { apikey: CHAVE, Authorization: `Bearer ${CHAVE}`, 'Content-Type': 'application/json', 'x-region': 'sa-east-1' },
          body: JSON.stringify({ acao: 'proxy', sessao: sessao.sessao, url: endereco, cookie: potes.get(host) || '', cabecalhos: cab }),
          signal: init.signal,
        });
        j = await r.json().catch(() => null);
        // falha do próprio servidor (sem resposta nossa): tenta de novo
        if (j || tentativa >= 2) { j = j || {}; break; }
      } catch (e) {
        if (tentativa >= 2 || (init.signal && init.signal.aborted)) throw e;
      }
      await new Promise((ok) => setTimeout(ok, 1500 * (tentativa + 1)));
    }
    if (!r.ok) {
      if (r.status === 401) sair(true);
      throw new Error(j.erro || `servidor HTTP ${r.status}`);
    }
    if (j.cookie) potes.set(j.host || host, j.cookie);
    const corpo = [101, 204, 205, 304].includes(j.status) ? null : base64ParaBytes(j.corpo || '');
    const resp = new Response(corpo, { status: j.status || 200, headers: { 'content-type': j.tipo || 'application/octet-stream' } });
    Object.defineProperty(resp, 'url', { value: j.url || endereco });
    return resp;
  };

  /* ---------- conta: telefone + senha ---------- */
  let modoEntrar = false;
  function sair(expirou) {
    if (sessao && !expirou) rpc('rp_site_sair', { p_sessao: sessao.sessao }).catch(() => {});
    sessao = null;
    gravarSessao(null);
    dados.monitorados = {}; dados.alertas = []; dados.config = {};
    if (expirou) alert('Sua sessão expirou. Entre de novo com seu telefone e senha.');
    location.hash = '';
    location.reload();
  }

  const ContaExt = window.Conta;
  window.Conta = {
    ...ContaExt,
    async lerCadastro() {
      return sessao ? { id: 'site', token: sessao.sessao, nome: sessao.nome, telefone: sessao.telefone } : null;
    },
    async cadastrar(nome, telefone) {
      const senha = document.getElementById('cadSenha').value;
      if (!ContaExt.telefoneValido(telefone)) throw new Error('Informe o telefone com DDD.');
      if (String(senha).length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
      const r = modoEntrar
        ? await rpc('rp_site_entrar', { p_telefone: telefone, p_senha: senha })
        : await rpc('rp_site_cadastrar', { p_nome: nome, p_telefone: telefone, p_senha: senha });
      sessao = { sessao: r.sessao, nome: r.nome, telefone: r.telefone };
      gravarSessao(sessao);
      document.getElementById('cadSenha').value = '';
      await recarregar();
      return storage.get('cadastro').then((o) => o.cadastro);
    },
    async registrarUso() {
      if (!sessao) return false;
      try {
        const eu = await rpcS('rp_site_eu');
        sessao.nome = eu.nome; sessao.telefone = eu.telefone;
        gravarSessao(sessao);
        return true;
      } catch (e) {
        return !/Sess[aã]o/i.test(e.message);
      }
    },
  };

  /* ---------- ajustes na tela ---------- */
  const $ = (s) => document.querySelector(s);
  const blocoDe = (sel) => { const el = $(sel); return el && el.closest('.bloco'); };
  document.body.classList.add('modo-site');

  // cadastro / entrar
  const form = $('#formCadastro');
  $('#cadTel').insertAdjacentHTML('afterend', `
    <label for="cadSenha">Senha</label>
    <input id="cadSenha" type="password" autocomplete="new-password" minlength="6" maxlength="72" required placeholder="mínimo 6 caracteres">`);
  form.querySelector('.nota:last-of-type').textContent =
    'Guardamos seu nome, telefone e os documentos que você monitora, presos só à sua conta. Nenhum outro usuário vê o que você consulta ou monitora.';
  form.insertAdjacentHTML('beforeend', '<button type="button" class="link-modo" id="cadModo"></button>');
  function aplicarModo() {
    const nome = $('#cadNome');
    nome.hidden = modoEntrar;
    nome.required = !modoEntrar;
    form.querySelector('label[for="cadNome"]').hidden = modoEntrar;
    form.querySelector('h2').textContent = modoEntrar ? 'Entrar' : 'Criar conta';
    form.querySelector('h2 + .nota').textContent = modoEntrar
      ? 'Use o telefone e a senha do seu cadastro.'
      : 'Informe nome, telefone (WhatsApp) e crie uma senha. Os avisos de processo novo chegam nesse WhatsApp.';
    $('#cadSenha').autocomplete = modoEntrar ? 'current-password' : 'new-password';
    $('#cadBtn').dataset.texto = modoEntrar ? 'Entrar' : 'Criar conta';
    $('#cadBtn').dataset.ocupado = modoEntrar ? 'Entrando…' : 'Criando…';
    $('#cadBtn').textContent = $('#cadBtn').dataset.texto;
    $('#cadModo').textContent = modoEntrar ? 'Não tenho cadastro — criar conta' : 'Já tenho cadastro — entrar';
    $('#cadErro').hidden = true;
  }
  $('#cadModo').addEventListener('click', () => { modoEntrar = !modoEntrar; aplicarModo(); });
  modoEntrar = (() => { try { return !!localStorage.getItem('radar_ja_entrou'); } catch (_) { return false; } })();
  aplicarModo();
  form.addEventListener('submit', () => { try { localStorage.setItem('radar_ja_entrou', '1'); } catch (_) {} });

  // o que só existe na extensão
  document.querySelectorAll('.fonte-pdpj').forEach((el) => (el.hidden = true));
  [blocoDe('#sessaoPdpjCfg'), blocoDe('#cfgWebhook')].forEach((el) => el && (el.hidden = true));
  $('.topo .marca span').textContent = 'DJEN · e-SAJ · Transparência';
  const notif = $('#cfgNotif').closest('label');
  notif.lastChild.textContent = ' Avisar no meu WhatsApp quando aparecer novidade';
  const notaMon = blocoDe('#cfgIntervalo').querySelector('.nota');
  if (notaMon) notaMon.textContent = 'O servidor verifica sozinho, mesmo com o computador desligado. As novidades aparecem em “Alertas” e chegam no WhatsApp do seu cadastro.';
  const sobre = $('.sobre p');
  if (sobre) sobre.innerHTML = '<strong>DJEN</strong> (CNJ): intimações e editais publicados por todos os tribunais. <strong>e-SAJ</strong>: consulta pública de SP, MS, AL, CE, AM e AC. <strong>Portal da Transparência</strong> (CGU): sanções. Dados do CNPJ: BrasilAPI e Minha Receita. Nada é pago. No site, as consultas passam pelo nosso servidor em São Paulo, porque o DJEN só aceita conexões do Brasil. A busca no <strong>jus.br</strong> com gov.br existe só na extensão do Chrome.';

  // conta: sair e trocar senha
  $('#cfgConta').insertAdjacentHTML('afterend', `
    <div class="linha pequena">
      <button type="button" id="btnSair">Sair</button>
    </div>
    <details class="trocar-senha">
      <summary>Trocar senha</summary>
      <div class="linha pequena">
        <input type="password" id="senhaAtual" placeholder="Senha atual" autocomplete="current-password">
        <input type="password" id="senhaNova" placeholder="Nova senha (mín. 6)" autocomplete="new-password">
        <button type="button" id="btnTrocarSenha">Trocar</button>
        <span class="nota" id="statusSenha"></span>
      </div>
    </details>`);
  $('#btnSair').addEventListener('click', () => sair(false));
  $('#btnTrocarSenha').addEventListener('click', async () => {
    try {
      await rpcS('rp_site_trocar_senha', { p_atual: $('#senhaAtual').value, p_nova: $('#senhaNova').value });
      $('#senhaAtual').value = ''; $('#senhaNova').value = '';
      $('#statusSenha').textContent = 'Senha trocada ✓';
    } catch (e) { $('#statusSenha').textContent = e.message; }
  });

  if (sessao) recarregar();
})();
