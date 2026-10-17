/* Radar de Processos — núcleo do monitoramento, igual na extensão, no site e no servidor.
 * Recebe um monitorado, busca o que é recente nas fontes e devolve o monitorado atualizado
 * e os alertas novos. Não guarda nada: quem chama decide onde salvar e como avisar.
 * Depende de lib.js (global Radar).
 */
(function (global) {
  const Radar = global.Radar;
  const MAX_PUBS_VISTAS = 5000;

  function dataISO(d) {
    // data no fuso de Brasília, que é o das publicações
    return new Date(d.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  }

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
      if (!Radar.ESAJ[s]) continue;
      try {
        const c = await Radar.fonteEsaj(s, { doc: m.doc, somenteContagem: true });
        if (c.total && c.total !== m.esajTotais[s]) {
          let r = c;
          if (c.total > 25) { await Radar.sleep(2500); r = await Radar.fonteEsaj(s, { doc: m.doc, maxPaginas: 20 }); }
          blocos.push({ id: `esaj-${s}`, achados: r.achados });
        } else {
          blocos.push({ id: `esaj-${s}`, achados: c.achados });
        }
        m.esajTotais[s] = c.total;
      } catch (e) { avisos.push(`e-SAJ ${s}: ${e.message}`); }
      await Radar.sleep(500);
    }

    if (fontes.pdpj && cfg.usarPdpj !== false) {
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

  /**
   * Verifica um monitorado. Altera e devolve `m`.
   * Retorna { m, alertas (mais novo primeiro), resumo, total, titulo, mensagem, webhook }.
   */
  async function verificarUm(m, cfg, token) {
    const doc = m.doc;
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
    const linkDe = (p) => (p.publicacoes[0] || {}).link || (p.links[0] || {}).url || '';
    const base = (p) => ({
      quando, doc, empresa: alvo, numero: p.numeroMascara, tribunal: p.tribunal, classe: p.classe,
      categoria: p.categoria, polo: Radar.poloTexto(p.poloAlvo), fontes: p.fontes, lido: false,
    });
    const alertas = [];
    for (const p of novos) {
      alertas.unshift({ ...base(p), id: `${doc}-${p.numero}-${Date.now()}`, tipo: 'processo', data: p.ultima || p.distribuicao, link: linkDe(p) });
    }
    if (cfg.avisarPublicacoes) {
      for (const { p, pub } of novasPubs) {
        alertas.unshift({ ...base(p), id: `${doc}-${pub.id}`, tipo: 'publicacao', data: pub.data, documento: pub.tipo, link: pub.link || '' });
      }
    }
    if (sancoesNovas) {
      alertas.unshift({ quando, doc, empresa: alvo, id: `${doc}-sancao-${Date.now()}`, tipo: 'sancao', numero: `${sancoesNovas} nova(s) sanção(ões)`, tribunal: 'CGU', classe: 'Portal da Transparência', categoria: 'Sanção', lido: false });
    }

    m.processos = Radar.juntarProcessos(m.processos, processos);
    m.processos.forEach((p) => vistos.add(p.numero));
    m.vistos = [...vistos];
    m.pubsVistas = [...pubsVistas].slice(-MAX_PUBS_VISTAS);
    m.totalProcessos = Math.max(vistos.size, m.processos.length);
    m.ultimaVerificacao = quando;
    m.ultimoErro = avisos.join(' · ');

    const nPubs = cfg.avisarPublicacoes ? novasPubs.length : 0;
    const total = novos.length + nPubs + sancoesNovas;
    const partes = [];
    if (novos.length) partes.push(`${novos.length} processo(s) novo(s)`);
    if (nPubs) partes.push(`${nPubs} nova(s) publicação(ões)`);
    if (sancoesNovas) partes.push(`${sancoesNovas} sanção(ões) nova(s)`);

    return {
      m,
      alertas,
      total,
      resumo: { doc, novos: novos.length, novasPubs: novasPubs.length, avisos },
      titulo: `Radar: ${alvo}`,
      mensagem: partes.join(' e ') + (novos[0] ? `\n${novos[0].numeroMascara} · ${novos[0].tribunal} · ${novos[0].categoria}` : ''),
      webhook: total ? {
        origem: 'radar-de-processos',
        documento: Radar.formatarDoc(doc),
        nome: alvo,
        processosNovos: novos.map((p) => ({
          numero: p.numeroMascara, tribunal: p.tribunal, classe: p.classe, categoria: p.categoria,
          polo: Radar.poloTexto(p.poloAlvo), fontes: p.fontes, data: p.ultima || p.distribuicao, link: linkDe(p),
        })),
        novasPublicacoes: nPubs ? novasPubs.map(({ p, pub }) => ({ numero: p.numeroMascara, tribunal: p.tribunal, data: pub.data, tipo: pub.tipo, link: pub.link })) : [],
        sancoesNovas,
      } : null,
    };
  }

  /** Texto de WhatsApp a partir do resultado de verificarUm. */
  function textoWhatsapp(r) {
    const w = r.webhook;
    if (!w) return '';
    const linhas = [`*Radar de Processos* — ${w.nome}`, `${w.documento}`, ''];
    w.processosNovos.slice(0, 8).forEach((p) => {
      linhas.push(`🆕 *${p.numero}* · ${p.tribunal}`);
      linhas.push(`${p.classe || ''}${p.categoria ? ` · ${p.categoria}` : ''}${p.polo ? ` · ${p.polo}` : ''}`);
      if (p.link) linhas.push(p.link);
      linhas.push('');
    });
    if (w.processosNovos.length > 8) linhas.push(`… e mais ${w.processosNovos.length - 8} processo(s).`, '');
    if (w.novasPublicacoes.length) linhas.push(`📄 ${w.novasPublicacoes.length} nova(s) publicação(ões) em processos já conhecidos.`);
    if (w.sancoesNovas) linhas.push(`⚠️ ${w.sancoesNovas} sanção(ões) nova(s) no Portal da Transparência.`);
    return linhas.join('\n').trim();
  }

  /** Versão enxuta para guardar no servidor: só as publicações mais recentes de cada processo, com texto curto.
   *  Empresas com milhares de processos vão sendo enxugadas até caber no limite. */
  const NIVEIS = [
    { pubs: 2, texto: 400, partes: 8 },
    { pubs: 1, texto: 200, partes: 4 },
    { pubs: 1, texto: 0, partes: 2 },
    { pubs: 0, texto: 0, partes: 0 },
  ];
  function enxugar(m, n) {
    return {
      ...m,
      processos: (m.processos || []).map((p) => ({
        ...p,
        partes: (p.partes || []).slice(0, n.partes),
        links: (p.links || []).slice(0, 2),
        publicacoes: (p.publicacoes || []).slice(0, n.pubs).map((x) => ({ ...x, texto: String(x.texto || '').slice(0, n.texto) })),
      })),
    };
  }
  function compactar(m, limite = 2400000) {
    let r = m;
    for (const n of NIVEIS) {
      r = enxugar(m, n);
      if (JSON.stringify(r).length <= limite) return r;
    }
    return r;
  }

  global.Monitor = { buscarNovidades, verificarUm, textoWhatsapp, compactar, dataISO, MAX_PUBS_VISTAS };
})(typeof self !== 'undefined' ? self : globalThis);
