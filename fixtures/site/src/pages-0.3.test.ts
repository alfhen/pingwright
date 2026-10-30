import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

const b64 = (s: string) => encodeURIComponent(Buffer.from(s).toString('base64'));

describe('0.3 pages', () => {
  const paths = ['/sgtm-leak', '/identifiers', '/cookies', '/tiles', '/select', '/handoff', '/handoff/second'];
  test.each(paths)('%s is served without an extension', async (path) => {
    const res = await fetch(site.url + path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test.each(paths)('%s loads neither site.js nor the sandboxed pixel', async (path) => {
    const html = await (await fetch(site.url + path)).text();
    expect(html).not.toContain('/assets/site.js');
    expect(html).not.toContain('web-pixels');
    expect(html).not.toContain('unknown-pixel');
  });

  test('the banner script gives the pages a banner and a Consent Mode default', async () => {
    const js = await (await fetch(`${site.url}/assets/banner.js`)).text();
    expect(js).toContain('pw-consent-banner');
    expect(js).toContain("'consent', 'default'");
    expect(js).not.toContain('HeadlessChrome');
  });

  test('the pages that send hits include the banner script', async () => {
    for (const path of ['/sgtm-leak', '/identifiers', '/cookies', '/select']) {
      expect(await (await fetch(site.url + path)).text()).toContain('/assets/banner.js');
    }
  });
});

describe('/sgtm-leak', () => {
  test('the leaking body lists every dataLayer field and posts to the data form', async () => {
    const html = await (await fetch(`${site.url}/sgtm-leak`)).text();
    for (const name of ['event_name', 'page_location', 'page_title', 'email', 'phone', 'address', 'cookie_data', 'clientIdHash']) {
      expect(html).toContain(name);
    }
    expect(html).toContain("'/data?v=2&event=' + name");
    expect(html).toMatch(/clientIdHash = '[0-9a-f]{64}'/);
  });

  test('the allowlist and huge switches exist', async () => {
    const html = await (await fetch(`${site.url}/sgtm-leak?mode=allowlist`)).text();
    expect(html).toContain("mode === 'allowlist'");
    expect(html).toContain("page_referrer");
    expect(html).toContain("mode === 'huge'");
    expect(html).toContain('70 * 1024');
  });
});

describe('/identifiers', () => {
  test('sends the identifier fields after the banner is answered', async () => {
    const html = await (await fetch(`${site.url}/identifiers`)).text();
    for (const name of ["uid: 'fixture-user-0001'", "'ep.token'", "'ud[em]'", 'external_id', 'user_data', 'email_address', 'fbp']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('window.pwConsent.onAnswer(sendAll)');
  });
});

describe('/session/start', () => {
  test('sets the shop cookie', async () => {
    const res = await fetch(`${site.url}/session/start`);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^_pwid=pwfake-0001;/);
  });
});

describe('mock Stape host cookie path', () => {
  test('/pwcookie answers the loader form with Set-Cookie', async () => {
    const res = await fetch(`${site.sgtmUrl}/pwcookie?pk=${b64('/data?v=2&event=page_view')}`);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^_pwdcid=pwfake-client\.0001;/);
  });

  test('the existing loader path sets no cookie', async () => {
    const res = await fetch(`${site.sgtmUrl}/pwstape?pk=${b64('/data?v=2&event=page_view')}`);
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('/tiles, /select and /handoff', () => {
  test('tiles are titled White (01) and Black (02) with three themes', async () => {
    const html = await (await fetch(`${site.url}/tiles`)).text();
    for (const text of ['White (01)', 'Black (02)', "'button'", "'radio'", "theme === 'button'"]) {
      expect(html).toContain(text);
    }
  });

  test('select has a countryCode select with value and label, and the broken switch', async () => {
    const html = await (await fetch(`${site.url}/select`)).text();
    expect(html).toContain('name="countryCode"');
    expect(html).toContain('<option value="DE">Germany</option>');
    expect(html).toContain("query.get('broken') === '1'");
    expect(html).toContain("query.get('send') === 'hash'");
  });

  test('handoff has a form and a link to the second page', async () => {
    const html = await (await fetch(`${site.url}/handoff`)).text();
    expect(html).toContain('id="handoff-form"');
    expect(html).toContain('href="/handoff/second"');
    const second = await fetch(`${site.url}/handoff/second`);
    expect(await second.text()).toContain('Handoff second page');
  });
});
