import { describe, expect, test } from 'vitest';
import { containerId, fakeWorkspace, noVersionContainerId, resolveContainer } from './containers.ts';

const third = 'http://127.0.0.1:1';
const params = (o: Record<string, string>) => new URLSearchParams(o);

describe('resolveContainer', () => {
  test('no preview parameters gives the published build', () => {
    const r = resolveContainer(params({ id: containerId }), third);
    expect(r).toMatchObject({ status: 200, build: 'published' });
    if (r.status === 200) {
      expect(r.body).toContain("ad_storage: 'denied'");
      expect(r.body).toContain("fbq('track', 'AddToCart')");
      expect(r.body).not.toContain('workspace_only');
      expect(r.body).not.toContain(fakeWorkspace.gtm_auth);
    }
  });

  test('the full fake parameter set gives the workspace build', () => {
    const r = resolveContainer(params({ id: containerId, ...fakeWorkspace }), third);
    expect(r).toMatchObject({ status: 200, build: 'workspace' });
    if (r.status === 200) {
      expect(r.body).toContain("ad_storage: 'granted'");
      expect(r.body).toContain('workspace_only');
      expect(r.body).not.toContain("fbq('track', 'AddToCart')");
      expect(r.body).toContain(fakeWorkspace.gtm_auth);
    }
  });

  test('a partial or wrong parameter set is 404', () => {
    expect(resolveContainer(params({ id: containerId, gtm_auth: fakeWorkspace.gtm_auth }), third).status).toBe(404);
    expect(resolveContainer(params({ id: containerId, ...fakeWorkspace, gtm_auth: 'nope' }), third).status).toBe(404);
    expect(resolveContainer(params({ id: containerId, ...fakeWorkspace, gtm_cookies_win: 'y' }), third).status).toBe(404);
  });

  test('an explicit workspace request without the parameters is 404', () => {
    expect(resolveContainer(params({ id: containerId, build: 'workspace' }), third).status).toBe(404);
    expect(resolveContainer(params({ id: containerId, build: 'workspace', ...fakeWorkspace }), third).status).toBe(200);
  });

  test('a container without a version or an unknown container is 404', () => {
    expect(resolveContainer(params({ id: noVersionContainerId }), third).status).toBe(404);
    expect(resolveContainer(params({}), third).status).toBe(404);
  });
});
