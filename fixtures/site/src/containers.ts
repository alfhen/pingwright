export const containerId = 'GTM-PWTEST1';
export const noVersionContainerId = 'GTM-PWNOVER';

export const fakeWorkspace = {
  gtm_auth: 'pwfake-auth-0001',
  gtm_preview: 'env-99',
  gtm_cookies_win: 'x',
} as const;

export type BuildName = 'published' | 'workspace';

const workspaceParams = Object.keys(fakeWorkspace) as (keyof typeof fakeWorkspace)[];

export type ContainerResult = { status: 200; build: BuildName; body: string } | { status: 404 };

// Preview parameters are all-or-nothing: a partial or wrong set never gets the workspace build.
// `build=workspace` asks for the workspace build explicitly and so needs the full set.
export function resolveContainer(params: URLSearchParams, thirdPartyUrl: string): ContainerResult {
  if (params.get('id') !== containerId) return { status: 404 };
  const given = workspaceParams.filter((k) => params.has(k));
  if (given.length === 0 && params.get('build') !== 'workspace') return { status: 200, build: 'published', body: buildScript('published', thirdPartyUrl) };
  if (workspaceParams.every((k) => params.get(k) === fakeWorkspace[k])) {
    return { status: 200, build: 'workspace', body: buildScript('workspace', thirdPartyUrl) };
  }
  return { status: 404 };
}

// The workspace build echoes its gtm_auth on purpose, so redaction can be tested.
function buildScript(build: BuildName, thirdPartyUrl: string): string {
  const workspace = build === 'workspace';
  const third = JSON.stringify(thirdPartyUrl);
  const echo = workspace
    ? `
      var auth = ${JSON.stringify(fakeWorkspace.gtm_auth)};
      new Image().src = ${third} + '/gtm-echo.gif?gtm_auth=' + auth;
      navigator.sendBeacon(${third} + '/gtm-echo', 'gtm_auth=' + auth);
      var frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = '/container/echo-frame?gtm_auth=' + auth;
      document.documentElement.appendChild(frame);
      var fx = window.__PW_FIXTURE;
      var stape = function (p) {
        return fx.sgtmUrl + '/pwstape?pk=' + encodeURIComponent(btoa(p));
      };
      var shopUrl = location.origin + '/container/echo?gtm_auth=' + auth;
      var dtdc = btoa(JSON.stringify({ page_location: shopUrl, page_hostname: location.hostname }));
      fetch(stape('/g/collect?v=2&tid=G-PWTEST0001&cid=5555555555.6666666666&en=ws_echo&dl=' + encodeURIComponent(shopUrl)), { mode: 'no-cors' }).catch(function () {});
      fetch(stape('/data?v=2&tid=G-PWTEST0001&cid=5555555555.6666666666&dtdc=' + encodeURIComponent(dtdc)), { mode: 'no-cors' }).catch(function () {});`
    : '';
  return `/* fixture container ${containerId}, ${build} build */
(function () {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  gtag('consent', 'default', {
    ad_storage: ${workspace ? "'granted'" : "'denied'"},
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });
  window.pwContainer = {
    build: ${JSON.stringify(build)},
    fire: function () {
      gtag('event', 'container_event');${workspace ? "\n      gtag('event', 'workspace_only');" : ''}
      fbq('track', 'PageView');
      fbq('track', 'ViewContent');${workspace ? '' : "\n      fbq('track', 'AddToCart');"}${echo}
    }
  };
})();
`;
}
