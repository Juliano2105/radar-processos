/* Ponte entre a página do jus.br e a extensão (mundo isolado). */
window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data || typeof ev.data.__radarPdpjToken !== 'string') return;
  try {
    chrome.runtime.sendMessage({ tipo: 'tokenPdpj', token: ev.data.__radarPdpjToken });
  } catch (_) {
    /* extensão recarregada: ignora */
  }
});
