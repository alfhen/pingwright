(function () {
  window.dataLayer = window.dataLayer || [];
  function hit(path, query) {
    return 'https://sgtm.pingwright.invalid' + path + '?v=2&tid=G-PWTEST0001&cid=3333333333.4444444444&gcs=G100&' + query;
  }
  // Pushed after the frame has loaded, so requests are routed and recorded.
  setTimeout(function () {
    window.dataLayer.push({ event: 'consent_update' });
    window.dataLayer.push({ event: 'item_added', value: 19, currency: 'USD' });
    fetch(hit('/data', 'en=item_added'), { method: 'POST', mode: 'no-cors', body: '{}' }).catch(function () {});
  }, 1800);
  // Like GA4 for a visitor who has not consented: held, then flushed when the page unloads.
  window.addEventListener('pagehide', function () {
    navigator.sendBeacon(hit('/g/collect', 'en=add_to_cart&ep.via=beacon'), '');
  });
})();
