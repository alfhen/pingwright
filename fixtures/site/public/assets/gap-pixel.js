(function () {
  window.dataLayer = window.dataLayer || [];
  var mode = new URLSearchParams(location.search).get('mode');
  function hit(path, query) {
    return 'https://sgtm.pingwright.invalid' + path + '?v=2&tid=G-PWTEST0001&cid=3333333333.4444444444&gcs=G100&' + query;
  }
  function send(path, query) {
    fetch(hit(path, query), { method: 'POST', mode: 'no-cors', body: '{}' }).catch(function () {});
  }
  // Pushed after the frame has loaded, so requests are routed and recorded.
  setTimeout(function () {
    if (mode === 'custom') {
      window.dataLayer.push({ event: 'custom_add' });
      send('/data', 'en=custom_add');
      send('/g/collect', 'en=custom_add_ga');
    } else if (mode === 'close') {
      window.dataLayer.push({ event: 'add_to_cart', value: 19, currency: 'USD' });
    } else {
      window.dataLayer.push({ event: 'consent_update' });
      window.dataLayer.push({ event: 'item_added', value: 19, currency: 'USD' });
      send('/data', 'en=item_added');
    }
  }, 1800);
  // Like GA4 for a visitor who has not consented: held, then flushed when the page unloads.
  window.addEventListener('pagehide', function () {
    if (mode === 'custom') return;
    navigator.sendBeacon(hit('/g/collect', 'en=add_to_cart&ep.via=beacon'), '');
  });
})();
