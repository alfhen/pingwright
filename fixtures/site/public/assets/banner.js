(function () {
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function consentState(choice) {
    var v = choice === 'accept' ? 'granted' : 'denied';
    return { ad_storage: v, analytics_storage: v, ad_user_data: v, ad_personalization: v };
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };
  gtag('consent', 'default', Object.assign(consentState('reject'), { wait_for_update: 500 }));
  var stored = getCookie('pw_consent');
  if (stored) gtag('consent', 'update', consentState(stored));

  var listeners = [];
  window.pwConsent = {
    choice: function () {
      return getCookie('pw_consent');
    },
    onAnswer: function (cb) {
      listeners.push(cb);
    },
  };

  function choose(choice) {
    document.cookie = 'pw_consent=' + choice + '; path=/; max-age=31536000; SameSite=Lax';
    gtag('consent', 'update', consentState(choice));
    document.getElementById('pw-consent-banner').hidden = true;
    listeners.forEach(function (cb) {
      cb(choice);
    });
  }

  window.pwSha256 = function (value) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value).trim().toLowerCase())).then(function (buf) {
      return Array.prototype.map
        .call(new Uint8Array(buf), function (b) {
          return b.toString(16).padStart(2, '0');
        })
        .join('');
    });
  };

  // The identity typed into /checkout, or fixed fakes when nothing was typed.
  window.pwIdentity = function () {
    var s = {};
    try {
      s = JSON.parse(sessionStorage.getItem('pw_checkout') || '{}');
    } catch {
      s = {};
    }
    return {
      email: s.email || 'pw-fixture@example.com',
      phone: s.phone || '+1 555 0100',
      firstName: s['first-name'] || 'Pat',
      lastName: s['last-name'] || 'Example',
      address1: s.address1 || '1 Example Street',
      city: s.city || 'Exampleville',
      zip: s.zip || '00000',
      country: s.country || 'DE',
    };
  };

  document.addEventListener('DOMContentLoaded', function () {
    var banner = document.createElement('div');
    banner.id = 'pw-consent-banner';
    banner.hidden = !!stored;
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
    var footer = document.createElement('footer');
    footer.innerHTML = '<a id="pw-cookie-settings" href="#">Cookie settings</a>';
    document.body.appendChild(footer);
    footer.querySelector('a').addEventListener('click', function (e) {
      e.preventDefault();
      banner.hidden = false;
    });
  });
})();
