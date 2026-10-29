(function () {
  var href = location.href;
  // Simple requests only: this opaque-origin frame cannot pass a CORS preflight.
  fetch('https://collector.pingwright.invalid/report', {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ source: 'fixture-pixel', event: 'page_viewed', href: href }),
  }).catch(function () {});
  // The sandbox URL is sent as the page: a deliberate defect.
  fetch(
    'https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=3333333333.4444444444&en=page_view&dl=' +
      encodeURIComponent(href),
    { method: 'POST', mode: 'no-cors' },
  ).catch(function () {});
})();
