/* Roda dentro do portal jus.br (mundo da página). Quando o próprio portal faz uma
 * chamada autenticada à API do PDPJ, copia o token de sessão do usuário e o entrega
 * à extensão. Não lê senha nem formulário: só o cabeçalho que o portal já envia. */
(() => {
  if (window.__radarPdpj) return;
  window.__radarPdpj = true;
  const enviar = (valor) => {
    if (!valor) return;
    const m = String(valor).match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i);
    if (m) window.postMessage({ __radarPdpjToken: m[1] }, window.location.origin);
  };
  const ehPdpj = (url) => {
    try { return /(^|\.)pdpj\.jus\.br$/.test(new URL(url, location.href).hostname); } catch (_) { return false; }
  };

  const fetchOriginal = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (ehPdpj(url)) {
        const h = (init && init.headers) || (input && input.headers);
        if (h) enviar(h instanceof Headers ? h.get('authorization') : (h.Authorization || h.authorization));
      }
    } catch (_) {}
    return fetchOriginal.apply(this, arguments);
  };

  const abrir = XMLHttpRequest.prototype.open;
  const definir = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (metodo, url) {
    this.__radarUrl = url;
    return abrir.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (nome, valor) {
    try {
      if (/^authorization$/i.test(nome) && ehPdpj(this.__radarUrl)) enviar(valor);
    } catch (_) {}
    return definir.apply(this, arguments);
  };
})();
