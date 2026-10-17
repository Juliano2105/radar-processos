/* Radar de Processos — núcleo de busca (v2).
 * Fontes gratuitas:
 *  - DJEN (Comunica PJe / CNJ): publicações de todos os tribunais que publicam no Diário Nacional
 *  - jus.br / PDPJ (CNJ): base nacional de processos, busca por CPF/CNPJ da parte (exige login gov.br do próprio usuário)
 *  - e-SAJ: TJSP, TJMS, TJAL, TJCE, TJAM, TJAC — busca por documento da parte
 *  - Portal da Transparência (CGU): sanções CEIS/CNEP (exige chave gratuita)
 *  - BrasilAPI / Minha Receita: dados cadastrais do CNPJ
 * Funciona como script comum (página) e via importScripts (service worker): sem DOM.
 */
(function (global) {
  const DJEN = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
  const PDPJ_APIS = [
    'https://api-processo-integracao.data-lake.pdpj.jus.br/processo-api/api/v1/processos',
    'https://portaldeservicos.pdpj.jus.br/api/v2/processos',
  ];
  const TRANSPARENCIA = 'https://api.portaldatransparencia.gov.br/api-de-dados';
  const POR_PAGINA = 100;

  const ESAJ = {
    TJSP: { nome: 'TJSP · São Paulo', base: 'https://esaj.tjsp.jus.br/', caminhos: ['cpopg'] },
    TJMS: { nome: 'TJMS · Mato Grosso do Sul', base: 'https://esaj.tjms.jus.br/', caminhos: ['cpopg5', 'cpopg'] },
    TJAL: { nome: 'TJAL · Alagoas', base: 'https://www2.tjal.jus.br/', caminhos: ['cpopg'] },
    TJCE: { nome: 'TJCE · Ceará', base: 'https://esaj.tjce.jus.br/', caminhos: ['cpopg'] },
    TJAM: { nome: 'TJAM · Amazonas', base: 'https://consultasaj.tjam.jus.br/', caminhos: ['cpopg'] },
    TJAC: { nome: 'TJAC · Acre', base: 'https://esaj.tjac.jus.br/', caminhos: ['cpopg'] },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');

  /* ---------------- documentos ---------------- */
  function formatarCnpj(d) {
    d = soDigitos(d);
    return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d;
  }
  function formatarCpf(d) {
    d = soDigitos(d);
    return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : d;
  }
  function formatarDoc(d) {
    d = soDigitos(d);
    return d.length === 11 ? formatarCpf(d) : formatarCnpj(d);
  }
  function cnpjValido(c) {
    c = soDigitos(c);
    if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
    const calc = (base) => {
      const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const r = base.split('').reduce((s, n, i) => s + Number(n) * pesos[i], 0) % 11;
      return r < 2 ? 0 : 11 - r;
    };
    const d1 = calc(c.slice(0, 12));
    return c.endsWith(`${d1}${calc(c.slice(0, 12) + d1)}`);
  }
  function cpfValido(c) {
    c = soDigitos(c);
    if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    const dv = (n) => {
      const s = c.slice(0, n).split('').reduce((a, x, i) => a + Number(x) * (n + 1 - i), 0);
      const r = (s * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
  }
  function tipoDoc(d) {
    d = soDigitos(d);
    if (d.length === 14 && cnpjValido(d)) return 'cnpj';
    if (d.length === 11 && cpfValido(d)) return 'cpf';
    return null;
  }
  function formatarCnj(n) {
    const d = soDigitos(n);
    return d.length === 20 ? d.replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, '$1-$2.$3.$4.$5.$6') : String(n || '');
  }

  /* ---------------- texto ---------------- */
  function normalizar(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const SUFIXOS = /\b(LTDA|LIMITADA|ME|EPP|EIRELI|S A|SA|S S|SS|MEI|SOCIEDADE ANONIMA|CIA|COMPANHIA)\b/g;
  function semSufixo(nome) {
    return normalizar(nome).replace(SUFIXOS, ' ').replace(/\s+/g, ' ').trim();
  }
  const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ordf: 'ª', ordm: 'º', deg: '°', sect: '§', ndash: '–', mdash: '—', laquo: '«', raquo: '»' };
  const ACENTOS = { acute: '́', grave: '̀', tilde: '̃', circ: '̂', cedil: '̧', uml: '̈' };
  function decodificar(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&([A-Za-z])(acute|grave|tilde|circ|cedil|uml);/g, (m, l, t) => (l + ACENTOS[t]).normalize('NFC'))
      .replace(/&([a-z]+);/gi, (m, e) => (e.toLowerCase() in ENTIDADES ? ENTIDADES[e.toLowerCase()] : m));
  }
  function textoLimpo(html) {
    return decodificar(
      String(html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    )
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }
  const limpa = (s) => decodificar(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  function categoria(classe, tribunal, segmento) {
    const c = normalizar(classe);
    const t = String(tribunal || '').toUpperCase();
    if (t.startsWith('TRT') || t === 'TST' || segmento === 'JUSTICA_DO_TRABALHO' || c.includes('TRABALHIST') || c.includes('RECLAMACAO TRAB')) return 'Trabalhista';
    if (c.includes('EXECUCAO FISCAL')) return 'Fiscal';
    if (/PENAL|CRIM|INQUERITO|TERMO CIRCUNSTANCIADO|QUEIXA|HABEAS|MEDIDAS PROTETIVAS|EXECUCAO DA PENA|AUTO DE PRISAO/.test(c)) return 'Criminal';
    if (/EXECUCAO|MONITORIA|COBRANCA|CUMPRIMENTO DE SENTENCA|BUSCA E APREENSAO|PROTESTO|FALENCIA|RECUPERACAO JUDICIAL|INSOLVENCIA/.test(c)) return 'Cobrança / Execução';
    if (/JUIZADO|RECURSO INOMINADO/.test(c)) return 'Juizado / Consumidor';
    return 'Cível / Outros';
  }

  /* polo a partir do texto de participação do e-SAJ */
  function poloEsaj(rotulo) {
    const r = normalizar(rotulo);
    if (!r) return '';
    if (/^(REQTE|REQUERENTE|AUTOR|AUTORA|EXEQTE|EXEQUENTE|RECLAMANTE|IMPETRANTE|EMBARGANTE|APELANTE|AGRAVANTE|EXECTE|CREDOR|QUERELANTE|DEPRECANTE|REQUERENTES)/.test(r)) return 'A';
    if (/^(REQDO|REQDA|REQUERIDO|REQUERIDA|REU|RE|EXECTDO|EXECTDA|EXECUTADO|EXECUTADA|RECLAMADO|RECLAMADA|IMPETRADO|EMBARGADO|EMBARGADA|APELADO|APELADA|AGRAVADO|AGRAVADA|DEVEDOR|QUERELADO|AVERIGUADO|INDICIADO|ACUSADO|DENUNCIADO|INVESTIGADO)/.test(r)) return 'P';
    return 'T';
  }

  /* ---------------- HTTP ---------------- */
  async function lerTexto(r) {
    const buf = await r.arrayBuffer();
    const tipo = r.headers.get('content-type') || '';
    let cs = (tipo.match(/charset=([\w-]+)/i) || [])[1];
    if (!cs) {
      const amostra = new TextDecoder('latin1').decode(buf.slice(0, 2048));
      cs = (amostra.match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
    }
    try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch (_) { return new TextDecoder('utf-8').decode(buf); }
  }
  async function getJson(url, headers = {}) {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      try { e.corpo = await r.text(); } catch (_) {}
      throw e;
    }
    return r.json();
  }

  /* ---------------- CNPJ cadastral ---------------- */
  async function buscarCnpj(cnpj) {
    const d = soDigitos(cnpj);
    let j, fonte;
    try {
      j = await getJson(`https://brasilapi.com.br/api/cnpj/v1/${d}`);
      fonte = 'BrasilAPI';
    } catch (e) {
      j = await getJson(`https://minhareceita.org/${d}`);
      fonte = 'Minha Receita';
    }
    return {
      doc: d, tipo: 'cnpj',
      razao: j.razao_social || '',
      fantasia: j.nome_fantasia || '',
      situacao: j.descricao_situacao_cadastral || j.situacao_cadastral || '',
      municipio: j.municipio || '',
      uf: j.uf || '',
      socios: (j.qsa || []).map((s) => s.nome_socio).filter(Boolean),
      fonte,
    };
  }

  /* ================= FONTE: DJEN ================= */
  async function consultarDjen(params, { maxPaginas = 30, onPagina } = {}) {
    const itens = [];
    let total = null;
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const qs = new URLSearchParams({ ...params, itensPorPagina: String(POR_PAGINA), pagina: String(pagina) });
      let j;
      for (let t = 0; ; t++) {
        try { j = await getJson(`${DJEN}?${qs}`); break; } catch (e) {
          if (e.status === 403) throw new Error('DJEN recusou (403): só aceita conexões do Brasil — desligue VPN.');
          if (t >= 2) throw e;
          await sleep(1500 * (t + 1));
        }
      }
      const lote = j.items || [];
      if (total === null) total = j.count ?? lote.length;
      itens.push(...lote);
      if (onPagina) onPagina({ recebidos: itens.length, total });
      if (lote.length < POR_PAGINA || itens.length >= total) break;
      await sleep(350);
    }
    return { itens, total: total ?? 0, truncado: itens.length < (total ?? 0) };
  }

  async function fonteDjen({ doc, nomes, desde, ate, maxPaginas, progresso }) {
    const filtros = {};
    if (desde) filtros.dataDisponibilizacaoInicio = desde;
    if (ate) filtros.dataDisponibilizacaoFim = ate;
    const consultas = [];
    if (doc) {
      consultas.push({ rotulo: formatarDoc(doc), tipo: 'doc', params: { texto: formatarDoc(doc), ...filtros } });
      consultas.push({ rotulo: `${doc} (sem pontuação)`, tipo: 'doc', params: { texto: doc, ...filtros } });
    }
    (nomes || []).forEach((n) => consultas.push({ rotulo: `nome "${n}"`, tipo: 'nome', params: { nomeParte: n, ...filtros } }));

    const porId = new Map();
    const detalhes = [];
    let truncado = false;
    for (const c of consultas) {
      progresso && progresso(`DJEN: ${c.rotulo}`);
      const r = await consultarDjen(c.params, { maxPaginas, onPagina: (p) => progresso && progresso(`DJEN: ${c.rotulo} — ${p.recebidos}/${p.total}`) });
      detalhes.push(`${c.rotulo}: ${r.total}`);
      truncado = truncado || r.truncado;
      for (const it of r.itens) {
        const k = it.id ?? it.hash;
        if (!porId.has(k)) porId.set(k, { ...it, _tipo: c.tipo });
        else if (c.tipo === 'doc') porId.get(k)._tipo = 'doc';
      }
      await sleep(300);
    }

    const achados = [];
    for (const it of porId.values()) {
      const txt = textoLimpo(it.texto);
      const dig = txt.replace(/[.\/\-\s]/g, '');
      const docNoTexto = !!doc && dig.includes(doc);
      // a busca por texto do DJEN pode casar palavras soltas: só vale se o documento aparece mesmo
      if (it._tipo === 'doc' && !docNoTexto) continue;
      achados.push({
        numero: soDigitos(it.numero_processo || it.numeroprocessocommascara),
        numeroMascara: it.numeroprocessocommascara || formatarCnj(it.numero_processo),
        tribunal: it.siglaTribunal || '',
        classe: (it.nomeClasse || '').toUpperCase(),
        orgao: it.nomeOrgao || '',
        partes: (it.destinatarios || []).map((x) => ({ nome: x.nome, polo: x.polo || '' })),
        confirmacao: docNoTexto ? 'documento' : 'nome',
        ultima: it.data_disponibilizacao || '',
        link: it.link || '',
        publicacao: {
          id: it.id ?? it.hash,
          data: it.data_disponibilizacao || '',
          tipo: it.tipoComunicacao || '',
          documento: it.tipoDocumento || '',
          orgao: it.nomeOrgao || '',
          link: it.link || '',
          texto: txt,
        },
      });
    }
    return { achados, resumo: `${porId.size} publicações (${detalhes.join(' · ')})`, truncado, total: porId.size };
  }

  /* ================= FONTE: e-SAJ ================= */
  function parseEsajLista(html, base) {
    const contador = (html.match(/id="contadorDeProcessos"[^>]*>([\s\S]*?)</) || [])[1];
    let total = contador ? Number(soDigitos(contador)) : null;
    if (total === null) {
      const m = html.match(/([\d.]+)\s+Processos?\s+encontrados?/i);
      if (m) total = Number(soDigitos(m[1]));
    }
    const itens = [];
    const re = /<a[^>]*class="[^"]*linkProcesso[^"]*"[^>]*>/gi;
    const pos = [];
    let m;
    while ((m = re.exec(html))) pos.push(m.index);
    for (let i = 0; i < pos.length; i++) {
      const seg = html.slice(pos[i], pos[i + 1] || pos[i] + 6000);
      const tag = seg.match(/^<a[^>]*>/)[0];
      const href = decodificar((tag.match(/href="([^"]+)"/) || [])[1] || '');
      const numero = limpa((seg.match(/^<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]).split(' ')[0];
      const pega = (cls) => limpa((seg.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/(?:div|label|span)>`)) || [])[1]);
      const participacao = pega('tipoDeParticipacao').replace(/:$/, '');
      const dataLocal = pega('dataLocalDistribuicaoProcesso');
      itens.push({
        numero: soDigitos(numero),
        numeroMascara: numero,
        classe: pega('classeProcesso'),
        assunto: pega('assuntoPrincipalProcesso'),
        participacao,
        nomeParte: pega('nomeParte'),
        distribuicao: (dataLocal.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0],
        local: dataLocal.replace(/^\d{2}\/\d{2}\/\d{4}\s*-?\s*/, ''),
        link: href ? new URL(href, base).href : '',
      });
    }
    if (total === null) total = itens.length;
    return { total, itens };
  }

  function parseEsajProcessoUnico(html, base, url) {
    const id = (x) => limpa((html.match(new RegExp(`id="${x}"[^>]*>([\\s\\S]*?)<\\/(?:span|div|td)>`)) || [])[1]);
    const numero = id('numeroProcesso');
    if (!numero) return null;
    const dist = id('dataHoraDistribuicaoProcesso');
    return {
      numero: soDigitos(numero),
      numeroMascara: numero.split(' ')[0],
      classe: id('classeProcesso'),
      assunto: id('assuntoProcesso'),
      participacao: '',
      nomeParte: '',
      distribuicao: (dist.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0],
      local: [id('foroProcesso'), id('varaProcesso')].filter(Boolean).join(' · '),
      link: url,
    };
  }

  async function esajGet(url) {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'text/html' } });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return { html: await lerTexto(r), url: r.url };
  }

  const dataIso = (br) => (br && /\d{2}\/\d{2}\/\d{4}/.test(br) ? br.split('/').reverse().join('-') : '');

  /** Consulta um e-SAJ pelo documento. `somenteContagem` lê só a 1ª página (para o monitoramento comparar o total). */
  async function fonteEsaj(sigla, { doc, maxPaginas = 20, somenteContagem = false, progresso }) {
    const t = ESAJ[sigla];
    let erroCaminho = null;
    for (const caminho of t.caminhos) {
      const qs = (pagina) => new URLSearchParams({
        ...(pagina ? { paginaConsulta: String(pagina) } : {}),
        conversationId: '', cbPesquisa: 'DOCPARTE', 'dadosConsulta.valorConsulta': doc, cdForo: '-1',
      });
      let primeira;
      try {
        progresso && progresso(`${sigla}: consultando`);
        primeira = await esajGet(`${t.base}${caminho}/search.do?${qs()}`);
      } catch (e) {
        erroCaminho = e;
        if (e.status === 404) continue;
        throw e;
      }
      const { html, url } = primeira;
      if (/Não existem informações disponíveis|Nenhum processo encontrado/i.test(html)) {
        return { achados: [], total: 0, resumo: '0 processos' };
      }
      if (!/linkProcesso/.test(html) && /id="numeroProcesso"/.test(html)) {
        const unico = parseEsajProcessoUnico(html, t.base, url);
        if (unico) return { achados: [converterEsaj(unico, sigla)], total: 1, resumo: '1 processo' };
      }
      const p1 = parseEsajLista(html, t.base);
      if (!p1.itens.length) {
        if (/captcha/i.test(html)) {
          const e = new Error('pediu captcha'); e.captcha = true; throw e;
        }
        const msg = limpa((html.match(/id="mensagemRetorno"[\s\S]*?<li[^>]*>([\s\S]*?)<\/li>/) || [])[1]);
        if (msg) throw new Error(msg);
        return { achados: [], total: 0, resumo: '0 processos' };
      }
      if (somenteContagem) {
        return { achados: p1.itens.map((x) => converterEsaj(x, sigla)), total: p1.total, resumo: `${p1.total} processos`, parcial: true };
      }
      const itens = [...p1.itens];
      const paginas = Math.min(maxPaginas, Math.ceil(p1.total / 25));
      for (let pg = 2; pg <= paginas; pg++) {
        progresso && progresso(`${sigla}: página ${pg} de ${paginas}`);
        await sleep(400);
        try {
          const { html: h } = await esajGet(`${t.base}${caminho}/trocarPagina.do?${qs(pg)}`);
          const p = parseEsajLista(h, t.base);
          if (!p.itens.length) break;
          itens.push(...p.itens);
        } catch (e) { break; }
      }
      return {
        achados: itens.map((x) => converterEsaj(x, sigla)),
        total: p1.total,
        resumo: `${p1.total} processos${itens.length < p1.total ? ` (lidos ${itens.length})` : ''}`,
        truncado: itens.length < p1.total,
      };
    }
    throw erroCaminho || new Error('não respondeu');
  }

  function converterEsaj(x, sigla) {
    const polo = poloEsaj(x.participacao);
    return {
      numero: x.numero,
      numeroMascara: x.numeroMascara || formatarCnj(x.numero),
      tribunal: sigla,
      classe: (x.classe || '').toUpperCase(),
      assunto: x.assunto || '',
      orgao: x.local || '',
      partes: x.nomeParte ? [{ nome: x.nomeParte, polo }] : [],
      poloAlvo: polo,
      confirmacao: 'documento',
      distribuicao: dataIso(x.distribuicao),
      ultima: dataIso(x.distribuicao),
      link: x.link,
    };
  }

  /* ================= FONTE: jus.br / PDPJ ================= */
  function lerJwt(token) {
    try {
      const p = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = p + '='.repeat((4 - (p.length % 4)) % 4);
      const bin = atob(pad);
      const json = decodeURIComponent(bin.split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      return JSON.parse(json);
    } catch (_) { return null; }
  }
  function tokenValido(token) {
    const p = token && lerJwt(token);
    return !!(p && p.exp && p.exp * 1000 > Date.now() + 60000);
  }

  async function fontePdpj({ doc, token, maxPaginas = 15, progresso }) {
    if (!tokenValido(token)) {
      const e = new Error('sessão do jus.br não conectada ou expirada'); e.semToken = true; throw e;
    }
    const headers = { Authorization: `Bearer ${token}` };
    let ultimoErro;
    for (const api of PDPJ_APIS) {
      try {
        const itens = [];
        let total = null;
        let searchAfter = null;
        for (let pg = 1; pg <= maxPaginas; pg++) {
          const qs = new URLSearchParams({ cpfCnpjParte: formatarDoc(doc) });
          if (searchAfter) qs.set('searchAfter', searchAfter);
          progresso && progresso(`jus.br: página ${pg}${total ? ` — ${itens.length} de ${total}` : ''}`);
          let j;
          try {
            j = await getJson(`${api}?${qs}`, headers);
          } catch (e) {
            if ((e.status === 404 || e.status === 400) && /encontrad/i.test(e.corpo || '')) break; // sem (mais) registros
            throw e;
          }
          const lote = j.content || [];
          if (total === null && typeof j.total === 'number') total = j.total;
          itens.push(...lote);
          if (!lote.length || !j.searchAfter || (total !== null && itens.length >= total)) break;
          searchAfter = Array.isArray(j.searchAfter) ? j.searchAfter.join(',') : String(j.searchAfter);
          await sleep(300);
        }
        const tot = total ?? itens.length;
        return {
          achados: itens.map((x) => converterPdpj(x, doc)),
          total: tot,
          resumo: `${tot} processos${itens.length < tot ? ` (lidos ${itens.length})` : ''}`,
          truncado: itens.length < tot,
        };
      } catch (e) {
        ultimoErro = e;
        if (e.status === 401) { const x = new Error('o jus.br recusou a sessão — conecte de novo'); x.semToken = true; throw x; }
      }
    }
    if (ultimoErro && ultimoErro.status === 403) throw new Error('o jus.br não liberou busca por CPF/CNPJ para esta conta (403)');
    throw ultimoErro || new Error('não respondeu');
  }

  function converterPdpj(p, doc) {
    const tr = (p.tramitacoes || [])[0] || {};
    const classe = ((tr.classe || [])[0] || {}).descricao || '';
    const assunto = ((tr.assunto || [])[0] || {}).descricao || '';
    const partes = (p.partes || tr.partes || []).map((x) => ({
      nome: x.nome,
      polo: x.polo === 'ATIVO' ? 'A' : x.polo === 'PASSIVO' ? 'P' : 'T',
      docs: (x.documentosPrincipais || []).map((d) => soDigitos(d.numero)),
    }));
    const alvo = partes.find((x) => x.docs.includes(doc));
    const orgaoBruto = (tr.orgaoJulgador && tr.orgaoJulgador.nome) || (tr.dadosCompetencia && tr.dadosCompetencia.nome) || '';
    const dt = (s) => (s ? String(s).slice(0, 10) : '');
    return {
      numero: soDigitos(p.numeroProcesso),
      numeroMascara: p.numeroProcesso && /\D/.test(p.numeroProcesso) ? p.numeroProcesso : formatarCnj(p.numeroProcesso),
      tribunal: p.siglaTribunal || (tr.tribunal && tr.tribunal.sigla) || '',
      segmento: p.segmentoJustica || '',
      classe: classe.toUpperCase(),
      assunto,
      orgao: orgaoBruto === '[REDIGIDO]' ? '' : orgaoBruto,
      instancia: tr.instancia || '',
      partes: partes.map(({ nome, polo }) => ({ nome, polo })).filter((x) => x.nome && x.nome !== '[REDIGIDO]'),
      poloAlvo: alvo ? alvo.polo : '',
      confirmacao: 'documento',
      distribuicao: dt(tr.dataHoraAjuizamento || p.dataHoraPrimeiroAjuizamento),
      ultima: dt(p.dataHoraUltimoMovimento || p.dataHoraAtualizacao),
      valor: tr.valorAcao || null,
      baixado: !!tr.dataBaixa,
      link: '',
    };
  }

  /* ================= FONTE: Portal da Transparência ================= */
  async function fonteTransparencia({ doc, chave }) {
    if (!chave) { const e = new Error('sem chave da API (configure em Configurações)'); e.semChave = true; throw e; }
    const headers = { 'chave-api-dados': chave };
    const sancoes = [];
    for (const cadastro of ['ceis', 'cnep']) {
      const lista = await getJson(`${TRANSPARENCIA}/${cadastro}?codigoSancionado=${doc}&pagina=1`, headers);
      for (const s of lista || []) {
        sancoes.push({
          cadastro: cadastro.toUpperCase(),
          tipo: (s.tipoSancao && (s.tipoSancao.descricaoResumida || s.tipoSancao.descricaoPortal)) || '',
          orgao: (s.orgaoSancionador && s.orgaoSancionador.nome) || '',
          inicio: s.dataInicioSancao || '',
          fim: s.dataFimSancao || '',
          processo: s.numeroProcesso || '',
          fundamento: ((s.fundamentacao || [])[0] || {}).descricao || '',
        });
      }
      await sleep(300);
    }
    return { sancoes, resumo: sancoes.length ? `${sancoes.length} sanção(ões)` : 'nenhuma sanção' };
  }

  /* ================= busca combinada ================= */
  /**
   * fontes: { djen: true, pdpj: true, esaj: ['TJSP',...], transparencia: true }
   * Retorna { processos, fontes: [{id, nome, status, detalhe, total}], sancoes }
   */
  async function buscarTudo({ doc, nomes = [], nomesAlvo = [], desde, ate, fontes, token, chave, maxPaginas = 20, onProgresso } = {}) {
    doc = soDigitos(doc);
    const status = [];
    const blocos = [];
    let sancoes = null;
    const prog = (txt) => onProgresso && onProgresso(txt);

    const tarefas = [];
    if (fontes.djen) tarefas.push(['djen', 'Diário Nacional (DJEN)', () => fonteDjen({ doc, nomes, desde, ate, maxPaginas: Math.max(10, maxPaginas), progresso: prog })]);
    if (fontes.pdpj) tarefas.push(['pdpj', 'jus.br (CNJ)', () => fontePdpj({ doc, token, progresso: prog })]);
    (fontes.esaj || []).forEach((s) => tarefas.push([`esaj-${s}`, `e-SAJ ${s}`, () => fonteEsaj(s, { doc, maxPaginas, progresso: prog })]));
    if (fontes.transparencia) tarefas.push(['transparencia', 'Portal da Transparência', () => fonteTransparencia({ doc, chave })]);

    let feitas = 0;
    const fila = [...tarefas];
    async function trabalhador() {
      while (fila.length) {
        const [id, nome, fn] = fila.shift();
        try {
          const r = await fn();
          if (id === 'transparencia') sancoes = r.sancoes;
          else blocos.push({ id, achados: r.achados });
          status.push({ id, nome, status: 'ok', detalhe: r.resumo, truncado: !!r.truncado, total: r.total });
        } catch (e) {
          status.push({
            id, nome,
            status: e.captcha ? 'captcha' : e.semToken ? 'desconectado' : e.semChave ? 'semchave' : 'erro',
            detalhe: String(e.message || e),
          });
        }
        feitas++;
        onProgresso && onProgresso(`${feitas} de ${tarefas.length} fontes concluídas`, feitas / tarefas.length);
      }
    }
    await Promise.all([trabalhador(), trabalhador(), trabalhador()]);

    const ordem = tarefas.map((t) => t[0]);
    status.sort((a, b) => ordem.indexOf(a.id) - ordem.indexOf(b.id));
    return { processos: mesclar(blocos, nomesAlvo), fontes: status, sancoes };
  }

  const NOME_FONTE = { djen: 'DJEN', pdpj: 'jus.br' };
  function mesclar(blocos, nomesAlvo) {
    const alvoNorm = (nomesAlvo || []).map(semSufixo).filter((n) => n.length >= 5);
    const mapa = new Map();
    for (const { id, achados } of blocos) {
      const fonte = NOME_FONTE[id] || id.replace('esaj-', 'e-SAJ ');
      for (const a of achados) {
        if (!a.numero) continue;
        let p = mapa.get(a.numero);
        if (!p) {
          p = {
            numero: a.numero, numeroMascara: a.numeroMascara, tribunal: a.tribunal, classe: '', assunto: '', orgao: '',
            segmento: '', instancia: '', fontes: new Set(), partes: new Map(), poloAlvo: new Set(),
            confirmacao: 'nome', publicacoes: [], distribuicao: '', ultima: '', links: [], valor: null, baixado: false,
          };
          mapa.set(a.numero, p);
        }
        p.fontes.add(fonte);
        for (const k of ['tribunal', 'classe', 'assunto', 'orgao', 'segmento', 'instancia']) if (!p[k] && a[k]) p[k] = a[k];
        if (a.valor && !p.valor) p.valor = a.valor;
        if (a.baixado) p.baixado = true;
        if (a.distribuicao && (!p.distribuicao || a.distribuicao < p.distribuicao)) p.distribuicao = a.distribuicao;
        if (a.ultima && a.ultima > p.ultima) p.ultima = a.ultima;
        if (a.link && !a.publicacao && !p.links.some((l) => l.url === a.link)) p.links.push({ fonte, url: a.link });
        if (a.confirmacao === 'documento') p.confirmacao = 'documento';
        (a.partes || []).forEach((x) => { if (x.nome && !p.partes.has(x.nome)) p.partes.set(x.nome, x.polo); });
        if (a.poloAlvo) p.poloAlvo.add(a.poloAlvo);
        (a.partes || []).forEach((x) => {
          const n = normalizar(x.nome);
          if (x.polo && alvoNorm.some((q) => n.includes(q))) p.poloAlvo.add(x.polo);
        });
        if (a.publicacao && !p.publicacoes.some((x) => x.id === a.publicacao.id)) p.publicacoes.push(a.publicacao);
      }
    }
    const lista = [...mapa.values()].map((p) => {
      p.publicacoes.sort((a, b) => String(b.data).localeCompare(String(a.data)));
      return {
        ...p,
        fontes: [...p.fontes],
        partes: [...p.partes.entries()].map(([nome, polo]) => ({ nome, polo })),
        poloAlvo: [...p.poloAlvo].filter((x) => x === 'A' || x === 'P' || x === 'T'),
        categoria: categoria(p.classe, p.tribunal, p.segmento),
      };
    });
    lista.sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
    return lista;
  }

  function poloTexto(polos) {
    if (!polos || !polos.length) return '';
    const m = { A: 'Autora', P: 'Ré', T: 'Terceira' };
    return polos.map((x) => m[x] || x).join(' / ');
  }

  global.Radar = {
    ESAJ, DJEN, sleep, soDigitos, formatarCnpj, formatarCpf, formatarDoc, formatarCnj, cnpjValido, cpfValido, tipoDoc,
    normalizar, semSufixo, textoLimpo, categoria, poloEsaj, poloTexto, buscarCnpj,
    parseEsajLista, parseEsajProcessoUnico, converterPdpj, lerJwt, tokenValido,
    fonteDjen, fonteEsaj, fontePdpj, fonteTransparencia, buscarTudo, mesclar,
  };
})(typeof self !== 'undefined' ? self : globalThis);
