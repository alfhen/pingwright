import { templateShim, type FixtureTag } from './template-shim.ts';

export const containerId = 'GTM-PWTEST1';
export const noVersionContainerId = 'GTM-PWNOVER';

export const fakeWorkspace = {
  gtm_auth: 'pwfake-auth-0001',
  gtm_preview: 'env-99',
  gtm_cookies_win: 'x',
} as const;

export const fakeEmail = 'pw-fixture@example.com';

// Tag 45 never fires in either build. The workspace build drops 12 and adds 13, 14, 77, 88 and 89.
export const fixtureTags: Record<'published' | 'workspace', FixtureTag[]> = {
  published: [
    { id: '11', name: 'GA4 - Config', status: 'success', executionTime: 4 },
    { id: '12', status: 'failure', executionTime: 2 },
  ],
  workspace: [
    { id: '11', name: 'GA4 - Config', status: 'success', executionTime: 4 },
    { id: '13', status: 'failure', executionTime: 2 },
    { id: '14', status: 'success', executionTime: 3 },
    { id: '77', name: 'GA4 - Workspace Only', status: 'success', executionTime: 5 },
    { id: '88', name: `Lead - ${fakeEmail}`, status: 'success', executionTime: 1 },
    { id: '89', name: `Auth - ${fakeWorkspace.gtm_auth}`, status: 'success', executionTime: 1 },
  ],
};

export const containerVersion: Record<BuildName, string> = { published: '3', workspace: '4' };

export type BuildName = 'published' | 'workspace';

const workspaceParams = Object.keys(fakeWorkspace) as (keyof typeof fakeWorkspace)[];

export type ContainerResult = { status: 200; build: BuildName; body: string } | { status: 404 };

// Preview parameters are all-or-nothing: a partial or wrong set never gets the workspace build.
// `build=workspace` asks for the workspace build explicitly and so needs the full set.
export function resolveContainer(params: URLSearchParams, thirdPartyUrl: string, tagLogUrl = `${thirdPartyUrl}/tag-report-log`): ContainerResult {
  if (params.get('id') !== containerId) return { status: 404 };
  const layer = layerName(params.get('l'));
  const given = workspaceParams.filter((k) => params.has(k));
  if (given.length === 0 && params.get('build') !== 'workspace') return { status: 200, build: 'published', body: buildScript('published', thirdPartyUrl, tagLogUrl, layer) };
  if (workspaceParams.every((k) => params.get(k) === fakeWorkspace[k])) {
    return { status: 200, build: 'workspace', body: buildScript('workspace', thirdPartyUrl, tagLogUrl, layer) };
  }
  return { status: 404 };
}

// Like real GTM, the container pushes to the global that `l=` names.
function layerName(value: string | null): string {
  return value !== null && /^[A-Za-z_$][\w$]{0,63}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : 'dataLayer';
}

// The workspace build echoes its gtm_auth on purpose, so redaction can be tested. It does so everywhere except
// /container/direct, which stays a control without echo traffic.
function buildScript(build: BuildName, thirdPartyUrl: string, tagLogUrl: string, layer = 'dataLayer'): string {
  const workspace = build === 'workspace';
  const third = JSON.stringify(thirdPartyUrl);
  const echo = workspace
    ? `
      if (location.pathname === '/container/direct') return;
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
  window.google_tag_manager = window.google_tag_manager || {};
  window.google_tag_manager[${JSON.stringify(containerId)}] = {};
  var layer = ${JSON.stringify(layer)};
  window[layer] = window[layer] || [];
  window.gtag = window.gtag || function () { window[layer].push(arguments); };
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
${templateShim({ container: containerId, version: containerVersion[build], tags: fixtureTags[build], logUrl: tagLogUrl })}
`;
}
