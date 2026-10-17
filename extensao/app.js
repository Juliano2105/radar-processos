/* Radar de Processos — tela principal (v2). */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dataBR = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const linkSeguro = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const PORTAL_PDPJ = 'https://portaldeservicos.pdpj.jus.br/consulta';

const CONFIG_PADRAO = {
  intervaloHoras: 6, notificacoes: true, avisarPublicacoes: true, webhookUrl: '', chaveTransparencia: '',
  fontesPadrao: { djen: true, pdpj: true, esaj: Object.keys(Radar.ESAJ), transparencia: false },
};
async function lerConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...CONFIG_PADRAO, ...(config || {}) };
}
async function salvarConfigParcial(parcial) {
  const atual = await lerConfig();
  await chrome.storage.local.set({ config: { ...atual, ...parcial } });
}

const estado = { alvo: null, nomes: [], resultado: null, categoria: 'Todas' };

/* ---------- abas ---------- */
function abrirAba(nome) {
  document.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('.painel').forEach((p) => p.classList.toggle('ativo', p.id === nome));
  if (nome === 'monitorados') renderMonitorados();
  if (nome === 'alertas') renderAlertas();
  if (nome === 'config') carregarConfig();
  history.replaceState(null, '', `#${nome}`);
}
document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => abrirAba(b.dataset.aba)));

/* ---------- sessão jus.br ---------- */
async function sessaoPdpj() {
  const { pdpj } = await chrome.storage.local.get('pdpj');
  return pdpj && Radar.tokenValido(pdpj.token) ? pdpj : null;
}
async function renderSessao() {
  const s = await sessaoPdpj();
  const html = s
    ? `<span class="pill ok">Conectado</span><span class="nota">até ${new Date(s.exp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span><button type="button" data-conectar>Reconectar</button>`
    : '<span class="pill aviso">Não conectado</span><button type="button" data-conectar>Conectar jus.br</button><span class="nota">abre o jus.br para você entrar com gov.br</span>';
  ['#sessaoPdpj', '#sessaoPdpjCfg'].forEach((id) => {
    const el = $(id);
    el.innerHTML = html;
    el.querySelector('[data-conectar]').addEventListener('click', conectarPdpj);
  });
}
function conectarPdpj() {
  chrome.tabs.create({ url: PORTAL_PDPJ });
}

/* ---------- consulta ---------- */
$('#doc').addEventListener('input', (e) => {
  const d = Radar.soDigitos(e.target.value).slice(0, 14);
  let v = d;
  if (d.length <= 11) {
    if (d.length > 3) v = `${d.slice(0, 3)}.${d.slice(3)}`;
    if (d.length > 6) v = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    if (d.length > 9) v = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  } else {
    v = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}${d.length > 12 ? `-${d.slice(12)}` : ''}`;
  }
  e.target.value = v;
});

$('#formDoc').addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Radar.soDigitos($('#doc').value);
  const tipo = Radar.tipoDoc(d);
  const erro = $('#erroDoc');
  erro.hidden = true;
  if (!tipo) {
    erro.textContent = d.length === 11 ? 'CPF inválido — confira os números.' : d.length === 14 ? 'CNPJ inválido — confira os números.' : 'Digite um CNPJ (14 números) ou CPF (11 números).';
    erro.hidden = false;
    return;
  }
  $('#btnConsultar').disabled = true;
  $('#resultado').hidden = true;
  try {
    let alvo = { doc: d, tipo, razao: '', fantasia: '', socios: [], situacao: '', municipio: '', uf: '' };
    if (tipo === 'cnpj') {
      try { alvo = await Radar.buscarCnpj(d); } catch (_) {
        erro.textContent = 'Não consegui os dados cadastrais do CNPJ agora. A busca segue pelo número.';
        erro.hidden = false;
      }
    }
    estado.alvo = alvo;
    montarNomes(alvo);
    await restaurarMonitorado(d);
    renderAlvo();
    await renderFontes();
    $('#refino').hidden = false;
    await buscar();
  } finally {
    $('#btnConsultar').disabled = false;
  }
});

/** Ao abrir um documento monitorado, volta os nomes e o período usados quando ele foi salvo. */
async function restaurarMonitorado(doc) {
  const pedido = estado.restaurar === doc;
  estado.restaurar = null;
  const { monitorados = {} } = await chrome.storage.local.get('monitorados');
  const m = monitorados[doc];
  if (!m) return;
  const nomes = m.nomesBusca || [];
  nomes.forEach((nome) => {
    const n = estado.nomes.find((x) => x.nome === nome);
    if (n) n.marcado = true;
    else estado.nomes.push({ nome, grupo: 'extra', marcado: true });
  });
  if (nomes.length) $('#porNome').checked = true;
  if (pedido && m.periodo && [...$('#periodo').options].some((o) => o.value === m.periodo)) $('#periodo').value = m.periodo;
  renderNomes();
}

function montarNomes(alvo) {
  const nomes = [];
  const add = (nome, grupo, marcado) => {
    const n = Radar.semSufixo(nome);
    if (n.length < 5 || nomes.some((x) => x.nome === n)) return;
    nomes.push({ nome: n, grupo, marcado });
  };
  if (alvo.tipo === 'cnpj') {
    add(alvo.razao, 'empresa', true);
    if (alvo.fantasia) add(alvo.fantasia, 'empresa', Radar.semSufixo(alvo.fantasia).split(' ').length >= 3);
    (alvo.socios || []).forEach((s) => add(s, 'socio', false));
    $('#notaNomes').textContent = '';
  } else {
    $('#notaNomes').textContent = 'Para CPF, digite abaixo o nome completo da pessoa se quiser procurar também pelo nome. Nomes comuns trazem muitos homônimos.';
  }
  estado.nomes = nomes;
  renderNomes();
}

function renderNomes() {
  const box = $('#nomes');
  const grupos = { empresa: 'Empresa', socio: 'Sócios (pessoas físicas — muitos homônimos)', extra: 'Adicionados por você' };
  let html = '';
  for (const g of Object.keys(grupos)) {
    const itens = estado.nomes.map((n, i) => ({ ...n, i })).filter((n) => n.grupo === g);
    if (!itens.length) continue;
    html += `<div class="grupo">${grupos[g]}</div>`;
    html += itens.map((n) => `<label class="check"><input type="checkbox" data-i="${n.i}" ${n.marcado ? 'checked' : ''}> ${esc(n.nome)}</label>`).join('');
  }
  box.innerHTML = html || '<p class="nota">Nenhum nome — a busca será só pelo número do documento.</p>';
  box.querySelectorAll('input').forEach((c) => c.addEventListener('change', () => (estado.nomes[c.dataset.i].marcado = c.checked)));
}

$('#btnAddNome').addEventListener('click', () => {
  const v = Radar.semSufixo($('#novoNome').value);
  if (v.length < 5) return;
  if (!estado.nomes.some((n) => n.nome === v)) estado.nomes.push({ nome: v, grupo: 'extra', marcado: true });
  $('#novoNome').value = '';
  renderNomes();
});
$('#novoNome').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#btnAddNome').click(); }
});
$('#btnBuscar').addEventListener('click', () => buscar());

function renderAlvo() {
  const a = estado.alvo;
  const el = $('#alvo');
  el.hidden = false;
  el.className = 'empresa';
  if (a.tipo === 'cpf') {
    el.innerHTML = `<h2>CPF ${esc(Radar.formatarCpf(a.doc))}</h2>
      <div class="meta"><span>Pessoa física</span><span>Consulte apenas para fins legítimos — dados pessoais são protegidos pela LGPD.</span></div>`;
    return;
  }
  el.innerHTML = `
    <h2>${esc(a.razao || Radar.formatarCnpj(a.doc))}</h2>
    <div class="meta">
      <span>CNPJ ${esc(Radar.formatarCnpj(a.doc))}</span>
      ${a.fantasia ? `<span>Fantasia: ${esc(a.fantasia)}</span>` : ''}
      ${a.situacao ? `<span>Situação: ${esc(a.situacao)}</span>` : ''}
      ${a.municipio ? `<span>${esc(a.municipio)}/${esc(a.uf)}</span>` : ''}
    </div>`;
}

async function renderFontes() {
  const cfg = await lerConfig();
  const f = cfg.fontesPadrao || CONFIG_PADRAO.fontesPadrao;
  $('#fDjen').checked = f.djen !== false;
  $('#fPdpj').checked = f.pdpj !== false;
  $('#fEsaj').innerHTML = Object.entries(Radar.ESAJ)
    .map(([s, t]) => `<label class="check"><input type="checkbox" data-esaj="${s}" ${(f.esaj || []).includes(s) ? 'checked' : ''}> ${esc(t.nome)}</label>`)
    .join('');
  const temChave = !!cfg.chaveTransparencia;
  $('#fTransp').disabled = !temChave;
  $('#fTransp').checked = temChave && !!f.transparencia;
  $('#notaTransp').innerHTML = temChave ? '— CEIS e CNEP' : '— <a href="#config" id="lnkChave">configure a chave grátis</a>';
  const lnk = $('#lnkChave');
  if (lnk) lnk.addEventListener('click', (e) => { e.preventDefault(); abrirAba('config'); });
  await renderSessao();
}

function fontesSelecionadas() {
  return {
    djen: $('#fDjen').checked,
    pdpj: $('#fPdpj').checked,
    esaj: [...document.querySelectorAll('[data-esaj]')].filter((c) => c.checked).map((c) => c.dataset.esaj),
    transparencia: $('#fTransp').checked,
  };
}

function periodoSelecionado() {
  const dias = Number($('#periodo').value);
  if (!dias) return {};
  return { desde: new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10) };
}

async function buscar() {
  const a = estado.alvo;
  if (!a) return;
  const fontes = fontesSelecionadas();
  if (!fontes.djen && !fontes.pdpj && !fontes.esaj.length && !fontes.transparencia) {
    alert('Marque pelo menos uma fonte.');
    return;
  }
  await salvarConfigParcial({ fontesPadrao: fontes });
  const cfg = await lerConfig();
  const sessao = await sessaoPdpj();
  const porNome = $('#porNome').checked;
  const nomesBusca = porNome ? estado.nomes.filter((n) => n.marcado).map((n) => n.nome) : [];
  const nomesAlvo = estado.nomes.filter((n) => n.grupo !== 'socio').map((n) => n.nome);

  $('#btnBuscar').disabled = true;
  $('#progresso').hidden = false;
  $('#resultado').hidden = true;
  $('#barra').style.width = '4%';
  $('#progressoTexto').textContent = 'Começando…';
  try {
    const r = await Radar.buscarTudo({
      doc: a.doc,
      nomes: nomesBusca,
      nomesAlvo,
      fontes,
      token: sessao && sessao.token,
      chave: cfg.chaveTransparencia,
      ...periodoSelecionado(),
      onProgresso: (txt, frac) => {
        if (typeof frac === 'number') $('#barra').style.width = `${Math.max(4, frac * 100)}%`;
        $('#progressoTexto').textContent = txt;
      },
    });
    const { monitorados = {} } = await chrome.storage.local.get('monitorados');
    const salvo = monitorados[a.doc];
    if (salvo && (salvo.processos || []).length) {
      const atuais = new Set(r.processos.map((p) => p.numero));
      const guardados = salvo.processos.filter((p) => !atuais.has(p.numero)).length;
      r.processos = Radar.juntarProcessos(salvo.processos, r.processos);
      r.guardados = guardados;
    }
    estado.resultado = { ...r, fontesUsadas: fontes, nomesBusca };
    estado.categoria = 'Todas';
    $('#soConfirmados').checked = false;
    $('#soComoRe').checked = false;
    $('#filtroTexto').value = '';
    renderResultado();
    $('#progresso').hidden = true;
  } catch (err) {
    $('#progressoTexto').textContent = `Erro: ${err.message || err}`;
  } finally {
    $('#btnBuscar').disabled = false;
  }
}

const ORDEM_CAT = ['Trabalhista', 'Cobrança / Execução', 'Juizado / Consumidor', 'Cível / Outros', 'Fiscal', 'Criminal'];

function filtrados() {
  const r = estado.resultado;
  const t = Radar.normalizar($('#filtroTexto').value);
  return r.processos.filter((p) => {
    if (estado.categoria !== 'Todas' && p.categoria !== estado.categoria) return false;
    if ($('#soConfirmados').checked && p.confirmacao !== 'documento') return false;
    if ($('#soComoRe').checked && !p.poloAlvo.includes('P')) return false;
    if (t) {
      const alvo = Radar.normalizar([p.numeroMascara, p.numero, p.tribunal, p.classe, p.assunto, p.orgao, ...p.partes.map((x) => x.nome)].join(' '));
      if (!alvo.includes(t)) return false;
    }
    return true;
  });
}

function urlEsajBusca(sigla, doc) {
  const t = Radar.ESAJ[sigla];
  return `${t.base}${t.caminhos[0]}/search.do?conversationId=&cbPesquisa=DOCPARTE&dadosConsulta.valorConsulta=${doc}&cdForo=-1`;
}

function renderStatusFontes() {
  const r = estado.resultado;
  const doc = estado.alvo.doc;
  $('#statusFontes').innerHTML = r.fontes.map((f) => {
    const cls = f.status === 'ok' ? (f.truncado ? 'aviso' : 'ok') : f.status === 'erro' ? 'erro' : 'aviso';
    let extra = '';
    if (f.status === 'desconectado') extra = ' <button type="button" class="mais" data-conectar>Conectar jus.br</button>';
    if (f.status === 'captcha' && f.id.startsWith('esaj-')) extra = ` <a href="${esc(urlEsajBusca(f.id.slice(5), doc))}" target="_blank" rel="noopener">abrir no site</a>`;
    if (f.status === 'semchave') extra = ' <a href="#config" data-cfg>configurar</a>';
    const det = f.status === 'ok' ? f.detalhe + (f.truncado ? ' — lista cortada; use um período menor' : '') : f.detalhe;
    return `<div class="sf ${cls}"><b>${esc(f.nome)}</b>${f.status === 'ok' ? '✓' : f.status === 'erro' ? '✕' : '!'}<small>${esc(det)}${extra}</small></div>`;
  }).join('');
  $('#statusFontes').querySelectorAll('[data-conectar]').forEach((b) => b.addEventListener('click', conectarPdpj));
  $('#statusFontes').querySelectorAll('[data-cfg]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); abrirAba('config'); }));
}

function renderSancoes() {
  const s = estado.resultado.sancoes;
  const el = $('#sancoes');
  if (s === null || s === undefined) { el.innerHTML = ''; return; }
  if (!s.length) {
    el.innerHTML = '<div class="bloco"><span class="sancao-ok">Nenhuma sanção no CEIS/CNEP (Portal da Transparência) ✓</span></div>';
    return;
  }
  el.innerHTML = `<div class="bloco sancoes"><h3>Sanções do governo (${s.length})</h3>
    <table><tr><th>Cadastro</th><th>Sanção</th><th>Órgão</th><th>Período</th><th>Processo</th></tr>
    ${s.map((x) => `<tr><td>${esc(x.cadastro)}</td><td>${esc(x.tipo)}${x.fundamento ? `<br><small>${esc(x.fundamento)}</small>` : ''}</td><td>${esc(x.orgao)}</td><td>${esc(x.inicio)}${x.fim ? ` a ${esc(x.fim)}` : ''}</td><td>${esc(x.processo)}</td></tr>`).join('')}
    </table></div>`;
}

function renderResultado() {
  const r = estado.resultado;
  $('#resultado').hidden = false;
  renderStatusFontes();
  renderSancoes();
  const ps = r.processos;
  const comoRe = ps.filter((p) => p.poloAlvo.includes('P')).length;
  const confirmados = ps.filter((p) => p.confirmacao === 'documento').length;
  const recentes = ps.filter((p) => p.ultima && Date.now() - new Date(p.ultima).getTime() < 30 * 864e5).length;
  const cats = {};
  ps.forEach((p) => (cats[p.categoria] = (cats[p.categoria] || 0) + 1));
  const quem = estado.alvo.tipo === 'cpf' ? 'a pessoa' : 'a empresa';

  $('#resumo').innerHTML = `
    <div class="tile"><b>${ps.length}</b><span>processos encontrados</span></div>
    <div class="tile destaque"><b>${comoRe}</b><span>com ${quem} como ré</span></div>
    <div class="tile"><b>${confirmados}</b><span>confirmados pelo documento</span></div>
    <div class="tile"><b>${recentes}</b><span>com atividade nos últimos 30 dias</span></div>
    ${r.guardados ? `<p class="nota" style="grid-column:1/-1">Inclui ${r.guardados} processo(s) guardado(s) do monitoramento que não vieram nesta busca.</p>` : ''}`;

  const chips = ['Todas', ...ORDEM_CAT.filter((c) => cats[c])];
  $('#chips').innerHTML = chips
    .map((c) => `<button type="button" class="chip ${c === estado.categoria ? 'ativo' : ''}" data-c="${esc(c)}">${esc(c)} <span>${c === 'Todas' ? ps.length : cats[c]}</span></button>`)
    .join('');
  $('#chips').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { estado.categoria = b.dataset.c; renderResultado(); }));
  renderLista();
  renderAtalhos();
}

function tagsProcesso(p) {
  const t = [`<span class="tag">${esc(p.tribunal || '—')}</span>`, `<span class="tag">${esc(p.categoria)}</span>`];
  t.push(p.confirmacao === 'documento' ? '<span class="tag ok">Documento confirmado</span>' : '<span class="tag aviso">Só pelo nome — conferir</span>');
  const polo = Radar.poloTexto(p.poloAlvo);
  if (polo) t.push(`<span class="tag ${p.poloAlvo.includes('P') ? 're' : ''}">${estado.alvo.tipo === 'cpf' ? 'Pessoa' : 'Empresa'}: ${esc(polo)}</span>`);
  if (p.baixado) t.push('<span class="tag">Baixado</span>');
  return t.join('');
}

function renderLista() {
  const lista = $('#lista');
  const ps = filtrados();
  if (!estado.resultado.processos.length) {
    lista.innerHTML = '<div class="vazio">Nenhum processo encontrado nas fontes consultadas. Confira acima se alguma fonte falhou, e lembre que processos sigilosos não aparecem.</div>';
    return;
  }
  if (!ps.length) { lista.innerHTML = '<div class="vazio">Nenhum processo com esses filtros.</div>'; return; }
  lista.innerHTML = '';
  const tpl = $('#tplProcesso');
  const frag = document.createDocumentFragment();
  ps.slice(0, 500).forEach((p) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    el.querySelector('.num').textContent = p.numeroMascara;
    el.querySelector('.tags').innerHTML = tagsProcesso(p);
    const info = [
      p.classe ? `<b>${esc(p.classe)}</b>` : '',
      esc(p.assunto),
      esc(p.orgao),
      p.distribuicao ? `distribuído ${dataBR(p.distribuicao)}` : '',
      p.ultima && p.ultima !== p.distribuicao ? `última atividade ${dataBR(p.ultima)}` : '',
      p.publicacoes.length ? `${p.publicacoes.length} publicação(ões)` : '',
    ].filter(Boolean).join(' · ');
    el.querySelector('.proc-info').innerHTML = `${info}<br><span class="fontes-tag">Fonte: ${esc(p.fontes.join(', '))}</span>`;
    const pubs = el.querySelector('.pubs');
    el.querySelector('.proc-topo').addEventListener('click', () => {
      if (!pubs.dataset.ok) { pubs.innerHTML = htmlDetalhe(p); ligarMais(pubs); pubs.dataset.ok = 1; }
      pubs.hidden = !pubs.hidden;
    });
    frag.appendChild(el);
  });
  lista.appendChild(frag);
  if (ps.length > 500) lista.insertAdjacentHTML('beforeend', `<p class="nota">Mostrando 500 de ${ps.length}. Use os filtros ou exporte a planilha.</p>`);
}

function htmlDetalhe(p) {
  const polos = { A: 'autor', P: 'réu', T: 'terceiro' };
  const partes = p.partes.length
    ? `<p class="partes"><b>Partes:</b> ${p.partes.map((x) => `${esc(x.nome)}${x.polo ? ` (${polos[x.polo] || x.polo})` : ''}`).join('; ')}</p>`
    : '';
  const links = p.links.filter((l) => linkSeguro(l.url)).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">Abrir no ${esc(l.fonte)}</a>`);
  const valor = p.valor ? `<p class="partes"><b>Valor da causa:</b> ${Number(p.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</p>` : '';
  const itens = p.publicacoes.map((pub) => {
    const link = linkSeguro(pub.link);
    return `<div class="pub">
      <div class="pub-topo"><b>${dataBR(pub.data)}</b><span>${esc(pub.tipo)}</span><span class="nota">${esc(pub.documento)}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Abrir documento</a>` : ''}</div>
      <p class="pub-texto">${esc(pub.texto)}</p>
      ${pub.texto.length > 500 ? '<button type="button" class="mais">Ver texto inteiro</button>' : ''}
    </div>`;
  }).join('');
  const semPub = !p.publicacoes.length ? '<p class="nota">Sem publicações no Diário Nacional para este processo.</p>' : '';
  return partes + valor + (links.length ? `<div class="links-proc">${links.join('')}</div>` : '') + itens + semPub;
}
function ligarMais(box) {
  box.querySelectorAll('.mais').forEach((b) => b.addEventListener('click', () => {
    const t = b.previousElementSibling;
    t.classList.toggle('aberto');
    b.textContent = t.classList.contains('aberto') ? 'Recolher' : 'Ver texto inteiro';
  }));
}

$('#soConfirmados').addEventListener('change', renderLista);
$('#soComoRe').addEventListener('change', renderLista);
let tFiltro;
$('#filtroTexto').addEventListener('input', () => { clearTimeout(tFiltro); tFiltro = setTimeout(renderLista, 200); });

/* ---------- atalhos (sites com captcha) ---------- */
const ATALHOS = [
  { nome: 'Certidão trabalhista (CNDT/TST)', url: 'https://cndt-certidao.tst.jus.br/inicio.faces' },
  { nome: 'TRT9 – Paraná', url: 'https://pje.trt9.jus.br/consultaprocessual/' },
  { nome: 'TJPR – Projudi', url: 'https://projudi.tjpr.jus.br/projudi_consulta/' },
  { nome: 'TRF1 por CPF/CNPJ', url: 'https://processual.trf1.jus.br/consultaProcessual/cpfCnpjParte.php?secao=TRF1' },
  { nome: 'TRF4 – Sul', url: 'https://consulta.trf4.jus.br/trf4/controlador.php?acao=consulta_processual_pesquisa' },
  { nome: 'Protestos (CENPROT)', url: 'https://www.pesquisaprotesto.com.br/' },
  { nome: 'Dívida ativa da União (PGFN)', url: 'https://www.listadevedores.pgfn.gov.br/' },
  { nome: 'jus.br', url: 'https://www.jus.br/' },
];
function renderAtalhos() {
  $('#atalhos').innerHTML = ATALHOS.map((a, i) => `<button type="button" data-i="${i}">${esc(a.nome)} ↗</button>`).join('');
  $('#atalhos').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard.writeText(estado.alvo.doc).catch(() => {});
    chrome.tabs.create({ url: ATALHOS[b.dataset.i].url });
  }));
}

/* ---------- CSV ---------- */
$('#btnCsv').addEventListener('click', () => {
  const ps = filtrados();
  const cab = ['Processo', 'Tribunal', 'Categoria', 'Classe', 'Assunto', 'Órgão', 'Polo do consultado', 'Confirmação', 'Distribuição', 'Última atividade', 'Fontes', 'Publicações', 'Partes', 'Link'];
  const linhas = ps.map((p) => [
    p.numeroMascara, p.tribunal, p.categoria, p.classe, p.assunto, p.orgao, Radar.poloTexto(p.poloAlvo),
    p.confirmacao === 'documento' ? 'Documento' : 'Só nome', dataBR(p.distribuicao), dataBR(p.ultima),
    p.fontes.join(', '), p.publicacoes.length, p.partes.map((x) => x.nome).join('; '),
    (p.links[0] || {}).url || (p.publicacoes[0] || {}).link || '',
  ]);
  const csv = [cab, ...linhas].map((l) => l.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `processos-${estado.alvo.doc}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

/* ---------- monitorar ---------- */
$('#btnMonitorar').addEventListener('click', async () => {
  const a = estado.alvo;
  const r = estado.resultado;
  if (!a || !r) return;
  const { monitorados = {} } = await chrome.storage.local.get('monitorados');
  const pubs = [];
  r.processos.forEach((p) => p.publicacoes.forEach((x) => pubs.push(String(x.id))));
  const esajTotais = {};
  r.fontes.filter((f) => f.id.startsWith('esaj-') && f.status === 'ok').forEach((f) => (esajTotais[f.id.slice(5)] = f.total));
  const ant = monitorados[a.doc] || {};
  monitorados[a.doc] = {
    doc: a.doc,
    tipo: a.tipo,
    nome: a.tipo === 'cnpj' ? (a.razao || Radar.formatarCnpj(a.doc)) : (estado.nomes.find((n) => n.grupo === 'extra') || {}).nome || `CPF ${Radar.formatarCpf(a.doc)}`,
    nomesBusca: [...new Set([...(ant.nomesBusca || []), ...(r.nomesBusca || [])])],
    nomesAlvo: [...new Set([...(ant.nomesAlvo || []), ...estado.nomes.filter((n) => n.grupo !== 'socio').map((n) => n.nome)])],
    fontes: r.fontesUsadas,
    processos: Radar.juntarProcessos(ant.processos, r.processos),
    periodo: $('#periodo').value,
    vistos: [...new Set([...(ant.vistos || []), ...r.processos.map((p) => p.numero)])],
    pubsVistas: [...new Set([...(ant.pubsVistas || []), ...pubs])].slice(-5000),
    esajTotais: { ...(ant.esajTotais || {}), ...esajTotais },
    totalSancoes: Array.isArray(r.sancoes) ? r.sancoes.length : ant.totalSancoes,
    totalProcessos: 0,
    desde: ant.desde || new Date().toISOString(),
    ultimaVerificacao: new Date().toISOString(),
  };
  const mm = monitorados[a.doc];
  mm.totalProcessos = new Set([...mm.vistos, ...mm.processos.map((p) => p.numero)]).size;
  await chrome.storage.local.set({ monitorados });
  $('#btnMonitorar').textContent = 'Monitorando ✓';
  setTimeout(() => ($('#btnMonitorar').textContent = 'Monitorar este documento'), 2500);
});

async function renderMonitorados() {
  const { monitorados = {}, ultimaRodada } = await chrome.storage.local.get(['monitorados', 'ultimaRodada']);
  const cfg = await lerConfig();
  const lista = Object.values(monitorados);
  $('#notaMon').textContent = lista.length
    ? `Verificação automática a cada ${cfg.intervaloHoras} h${ultimaRodada ? ` · última rodada ${new Date(ultimaRodada).toLocaleString('pt-BR')}` : ''}.`
    : '';
  if (!lista.length) {
    $('#listaMon').innerHTML = '<div class="vazio">Nada monitorado ainda. Faça uma consulta e clique em “Monitorar este documento”.</div>';
    return;
  }
  const nomeFontes = (f) => [f.djen && 'DJEN', f.pdpj && 'jus.br', ...(f.esaj || []).map((s) => `e-SAJ ${s}`), f.transparencia && 'Transparência'].filter(Boolean).join(', ');
  $('#listaMon').innerHTML = lista.map((m) => {
    const doc = m.doc || m.cnpj;
    return `<div class="mon" data-doc="${esc(doc)}">
      <h3>${esc(m.nome || m.razao || Radar.formatarDoc(doc))}</h3>
      <div class="proc-info">${m.tipo === 'cpf' ? 'CPF' : 'CNPJ'} ${Radar.formatarDoc(doc)} · ${Math.max(m.totalProcessos || 0, (m.processos || []).length, (m.vistos || []).length)} processos conhecidos ·
        última verificação ${m.ultimaVerificacao ? new Date(m.ultimaVerificacao).toLocaleString('pt-BR') : '—'}
        <br>Fontes: ${esc(nomeFontes(m.fontes || { djen: true }))}
        ${(m.nomesBusca || []).length ? `<br>Também pelo nome: ${m.nomesBusca.map(esc).join(', ')}` : ''}
        ${m.ultimoErro ? `<br><span class="erro">${esc(m.ultimoErro)}</span>` : ''}</div>
      <div class="linha">
        <button type="button" data-acao="verificar">Verificar agora</button>
        <button type="button" data-acao="abrir">Abrir consulta</button>
        <button type="button" data-acao="remover" class="perigo">Parar de monitorar</button>
      </div>
    </div>`;
  }).join('');
  $('#listaMon').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const doc = b.closest('.mon').dataset.doc;
    if (b.dataset.acao === 'verificar') {
      b.disabled = true; b.textContent = 'Verificando…';
      const resp = await chrome.runtime.sendMessage({ tipo: 'verificarAgora', doc });
      b.textContent = resp && resp.ok ? resumoVerificacao(resp.resultado) : `Erro: ${resp && resp.erro}`;
      setTimeout(renderMonitorados, 3000);
    } else if (b.dataset.acao === 'abrir') {
      abrirAba('consultar');
      estado.restaurar = doc;
      $('#doc').value = Radar.formatarDoc(doc);
      $('#formDoc').requestSubmit();
    } else if (b.dataset.acao === 'remover') {
      if (!confirm('Parar de monitorar?')) return;
      const d = await chrome.storage.local.get('monitorados');
      delete d.monitorados[doc];
      await chrome.storage.local.set({ monitorados: d.monitorados });
      renderMonitorados();
    }
  }));
}

function resumoVerificacao(res) {
  if (!res || res.ocupado) return 'Já estava verificando…';
  const t = res.reduce((a, x) => ({ n: a.n + (x.novos || 0), p: a.p + (x.novasPubs || 0) }), { n: 0, p: 0 });
  if (!t.n && !t.p) return 'Nada novo ✓';
  return `${t.n} processo(s) e ${t.p} publicação(ões) novos`;
}

$('#btnVerificarTodos').addEventListener('click', async (ev) => {
  const b = ev.currentTarget;
  b.disabled = true; b.textContent = 'Verificando…';
  const resp = await chrome.runtime.sendMessage({ tipo: 'verificarAgora' });
  b.textContent = resp && resp.ok ? resumoVerificacao(resp.resultado) : `Erro: ${resp && resp.erro}`;
  setTimeout(() => { b.disabled = false; b.textContent = 'Verificar todos agora'; renderMonitorados(); }, 3000);
});

/* ---------- alertas ---------- */
async function renderAlertas() {
  const { alertas = [] } = await chrome.storage.local.get('alertas');
  if (!alertas.length) { $('#listaAlertas').innerHTML = '<div class="vazio">Sem alertas por enquanto.</div>'; return; }
  const rotulo = { processo: 'Processo novo', publicacao: 'Nova publicação', sancao: 'Nova sanção' };
  $('#listaAlertas').innerHTML = alertas.map((a) => {
    const link = linkSeguro(a.link);
    return `<div class="alerta-item ${a.lido ? '' : 'novo'}">
      <div class="proc-id"><span class="num">${esc(a.numero)}</span>
        <span class="tags"><span class="tag ${a.tipo !== 'publicacao' ? 're' : ''}">${rotulo[a.tipo] || a.tipo}</span>
        <span class="tag">${esc(a.tribunal)}</span><span class="tag">${esc(a.categoria)}</span>
        ${a.polo ? `<span class="tag">${esc(a.polo)}</span>` : ''}</span></div>
      <div class="proc-info"><b>${esc(a.empresa)}</b> · ${esc(a.classe)}${a.data ? ` · ${dataBR(a.data)}` : ''} · detectado ${new Date(a.quando).toLocaleString('pt-BR')}
        ${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener">Abrir</a>` : ''}</div>
    </div>`;
  }).join('');
}
$('#btnLidos').addEventListener('click', async () => {
  const { alertas = [] } = await chrome.storage.local.get('alertas');
  alertas.forEach((a) => (a.lido = true));
  await chrome.storage.local.set({ alertas });
  chrome.runtime.sendMessage({ tipo: 'badge' });
  renderAlertas();
});
$('#btnLimpar').addEventListener('click', async () => {
  const { alertas = [] } = await chrome.storage.local.get('alertas');
  await chrome.storage.local.set({ alertas: alertas.filter((a) => !a.lido) });
  renderAlertas();
});

/* ---------- configurações ---------- */
async function carregarConfig() {
  const c = await lerConfig();
  $('#cfgIntervalo').value = String(c.intervaloHoras);
  $('#cfgNotif').checked = c.notificacoes;
  $('#cfgPubs').checked = c.avisarPublicacoes;
  $('#cfgWebhook').value = c.webhookUrl;
  $('#cfgChave').value = c.chaveTransparencia;
  renderSessao();
}
async function permissaoWebhook(url) {
  if (!url) return true;
  let origem;
  try { origem = new URL(url).origin + '/*'; } catch (_) { return false; }
  return chrome.permissions.request({ origins: [origem] });
}
$('#btnSalvarCfg').addEventListener('click', async () => {
  const url = $('#cfgWebhook').value.trim();
  if (url && !(await permissaoWebhook(url))) { $('#statusCfg').textContent = 'Sem permissão para acessar o endereço do webhook.'; return; }
  await salvarConfigParcial({
    intervaloHoras: Number($('#cfgIntervalo').value),
    notificacoes: $('#cfgNotif').checked,
    avisarPublicacoes: $('#cfgPubs').checked,
    webhookUrl: url,
    chaveTransparencia: $('#cfgChave').value.trim(),
  });
  await chrome.runtime.sendMessage({ tipo: 'reagendar' });
  if (estado.alvo) renderFontes();
  $('#statusCfg').textContent = 'Salvo ✓';
  setTimeout(() => ($('#statusCfg').textContent = ''), 2500);
});
$('#btnTestarWebhook').addEventListener('click', async () => {
  const url = $('#cfgWebhook').value.trim();
  if (!url) return;
  if (!(await permissaoWebhook(url))) { $('#statusWebhook').textContent = 'Permissão negada.'; return; }
  $('#statusWebhook').textContent = 'Enviando…';
  const r = await chrome.runtime.sendMessage({ tipo: 'testarWebhook', url });
  $('#statusWebhook').textContent = r && r.ok ? `Enviado (HTTP ${r.resultado})` : `Falhou: ${r && r.erro}`;
});

/* ---------- contadores ---------- */
async function atualizarContadores() {
  const { monitorados = {}, alertas = [] } = await chrome.storage.local.get(['monitorados', 'alertas']);
  const nMon = Object.keys(monitorados).length;
  const nAl = alertas.filter((a) => !a.lido).length;
  $('#contMon').textContent = nMon ? String(nMon) : '';
  $('#contAlertas').textContent = nAl ? String(nAl) : '';
}
chrome.storage.onChanged.addListener((mud) => {
  atualizarContadores();
  if (mud.pdpj) renderSessao();
});

/* ---------- início ---------- */
atualizarContadores();
renderSessao();
const inicial = location.hash.replace('#', '');
if (['monitorados', 'alertas', 'config'].includes(inicial)) abrirAba(inicial);
