(function () {
  var GA4 = 'G-PWTEST0001';
  var ADS = 'AW-000000001';
  var PIXEL = '100000000000001';
  var fixture = window.__PW_FIXTURE;

  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax';
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };

  function consentState(choice) {
    var v = choice === 'accept' ? 'granted' : 'denied';
    return { ad_storage: v, analytics_storage: v, ad_user_data: v, ad_personalization: v };
  }

  // Consent Mode defaults go before any tag.
  gtag('consent', 'default', Object.assign(consentState('reject'), { wait_for_update: 500 }));

  var headless = navigator.userAgent.indexOf('HeadlessChrome') !== -1;
  var stored = getCookie('pw_consent');
  if (headless) {
    // Reproduces banners that grant consent to headless browsers without asking.
    setCookie('pw_consent', 'accept');
    stored = 'accept';
  }
  if (stored) gtag('consent', 'update', consentState(stored));

  function choose(choice) {
    setCookie('pw_consent', choice);
    gtag('consent', 'update', consentState(choice));
    var banner = document.getElementById('pw-consent-banner');
    if (banner) banner.hidden = true;
  }

  gtag('js', new Date());
  gtag('config', GA4);
  gtag('config', ADS);
  var gs = document.createElement('script');
  gs.async = true;
  gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA4;
  document.head.appendChild(gs);

  /* eslint-disable */
  !(function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = '2.0';
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */
  fbq('init', PIXEL);
  fbq('track', 'PageView');

  function stapeUrl(realPath) {
    return fixture.sgtmUrl + '/pwstape?pk=' + encodeURIComponent(btoa(realPath));
  }
  var ss = document.createElement('script');
  ss.async = true;
  ss.src = stapeUrl('/gtag/js?id=' + GA4);
  document.head.appendChild(ss);
  var dtdc = btoa(JSON.stringify({ page_location: location.href, page_hostname: location.hostname }));
  var cid = '1111111111.2222222222';
  [
    '/g/collect?v=2&tid=' + GA4 + '&cid=' + cid + '&en=page_view&dl=' + encodeURIComponent(location.href),
    '/data?v=2&tid=' + GA4 + '&cid=' + cid + '&dtdc=' + encodeURIComponent(dtdc),
  ].forEach(function (p) {
    fetch(stapeUrl(p), { mode: 'no-cors' }).catch(function () {});
  });

  new Image().src = fixture.thirdPartyUrl + '/unknown-pixel?x=1';

  window.pw = {
    cart: function () {
      try {
        return JSON.parse(localStorage.getItem('pw_cart') || '[]');
      } catch {
        return [];
      }
    },
    setCart: function (cart) {
      localStorage.setItem('pw_cart', JSON.stringify(cart));
    },
  };

  document.addEventListener('DOMContentLoaded', function () {
    var banner = document.createElement('div');
    banner.id = 'pw-consent-banner';
    banner.hidden = true;
    banner.innerHTML =
      '<p>We use cookies for analytics and ads.</p>' +
      '<button id="pw-accept" type="button">Accept</button> ' +
      '<button id="pw-reject" type="button">Reject</button>';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#eee;padding:1rem;border-top:1px solid #999';
    document.body.appendChild(banner);
    banner.querySelector('#pw-accept').addEventListener('click', function () {
      choose('accept');
    });
    banner.querySelector('#pw-reject').addEventListener('click', function () {
      choose('reject');
    });
    if (!stored) banner.hidden = false;

    var footer = document.createElement('footer');
    footer.innerHTML = '<a id="pw-cookie-settings" href="#">Cookie settings</a>';
    document.body.appendChild(footer);
    footer.querySelector('a').addEventListener('click', function (e) {
      e.preventDefault();
      banner.hidden = false;
    });

    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    frame.id = 'pw-web-pixel';
    frame.src = '/web-pixels@0.0.0-fixture/sandbox/modern/';
    frame.style.cssText = 'width:0;height:0;border:0;position:absolute';
    document.body.appendChild(frame);
  });
})();
