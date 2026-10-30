(function () {
  var held = null;
  window.dataLayer = window.dataLayer || [];
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.event !== 'add_to_cart') return;
    held = e.data.href;
    window.dataLayer.push({ event: 'add_to_cart', value: 19, currency: 'USD' });
  });
  function hitUrl(via) {
    return (
      'https://sgtm.pingwright.invalid/g/collect?v=2&tid=G-PWTEST0001&cid=3333333333.4444444444&gcs=G100&en=add_to_cart&ep.via=' +
      via +
      '&dl=' +
      encodeURIComponent(held)
    );
  }
  // Like GA4 for a visitor who has not consented: the hit is held, then flushed when the page unloads.
  window.addEventListener('pagehide', function () {
    if (held === null) return;
    navigator.sendBeacon(hitUrl('beacon'), '');
    fetch(hitUrl('keepalive'), { method: 'POST', mode: 'no-cors', keepalive: true }).catch(function () {});
  });
})();
