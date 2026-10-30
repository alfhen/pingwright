(function () {
  var GA4 = 'G-PWTEST0001';
  var PIXEL = '100000000000001';
  var mode = document.currentScript.getAttribute('data-mode');
  var sandbox = mode === 'sandbox';

  window.dataLayer = window.dataLayer || [];

  function sendGa4(name) {
    fetch(
      'https://region1.google-analytics.com/g/collect?v=2&tid=' + GA4 + '&cid=5555555555.6666666666&en=' + name +
        '&dl=' + encodeURIComponent(location.href),
      { method: 'POST', mode: 'no-cors' },
    ).catch(function () {});
  }

  if (sandbox) {
    // The real gtag.js and fbevents.js cannot run in an opaque-origin frame (no cookies or storage),
    // so the frame sends the same events itself, as a custom pixel would.
    window.gtag = function (cmd, name) {
      if (cmd === 'event') sendGa4(name);
      if (cmd === 'config') sendGa4('page_view');
    };
    window.fbq = function (cmd, name) {
      if (cmd === 'track') new Image().src = 'https://www.facebook.com/tr/?id=' + PIXEL + '&ev=' + name;
    };
  } else {
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    var q = function () {
      q.queue.push(arguments);
    };
    q.push = q;
    q.loaded = true;
    q.version = '2.0';
    q.queue = [];
    window.fbq = window._fbq = q;
  }

  function addScript(src, done) {
    var s = document.createElement('script');
    s.async = true;
    s.src = src;
    if (done) {
      s.onload = done;
      s.onerror = done;
    }
    document.head.appendChild(s);
  }

  // The container has run (or failed) by now.
  function start() {
    gtag('js', new Date());
    gtag('config', GA4);
    if (!sandbox) {
      addScript('https://www.googletagmanager.com/gtag/js?id=' + GA4);
      addScript('https://connect.facebook.net/en_US/fbevents.js');
    }
    fbq('init', PIXEL);
    if (window.pwContainer) window.pwContainer.fire();
  }
  window.pwContainerPage = { start: start };

  if (mode === 'stape' || sandbox) {
    var real = '/gtm.js?id=GTM-PWTEST1';
    addScript(window.__PW_FIXTURE.sgtmUrl + '/pwstape?pk=' + encodeURIComponent(btoa(real)), start);
  }
})();
