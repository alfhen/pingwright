import { describe, expect, test } from 'vitest';
import { containerId, containerVersion, fakeEmail, fakeWorkspace, fixtureTags, noVersionContainerId, resolveContainer } from './containers.ts';

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

describe('the data layer name', () => {
  const body = (extra: Record<string, string>) => {
    const r = resolveContainer(params({ id: containerId, ...extra }), third);
    if (r.status !== 200) throw new Error('no container');
    return r.body;
  };

  test('l= names the global the container pushes to', () => {
    expect(body({ l: 'myLayer' })).toContain('var layer = "myLayer";');
    expect(body({})).toContain('var layer = "dataLayer";');
  });

  test('a name that is not an identifier falls back to dataLayer', () => {
    for (const l of ['a b', '__proto__', '1x', 'x'.repeat(65)]) expect(body({ l })).toContain('var layer = "dataLayer";');
  });
});

describe('the opt-in tag reporter', () => {
  const body = (extra: Record<string, string> = {}) => {
    const r = resolveContainer(params({ id: containerId, ...extra }), third);
    if (r.status !== 200) throw new Error('no container');
    return r.body;
  };

  test('both builds define reportTags but never call it', () => {
    for (const text of [body(), body(fakeWorkspace)]) {
      expect(text).toContain('pwContainer.reportTags = function');
      expect(text).not.toMatch(/pwContainer\.reportTags\(/);
    }
  });

  test('each build carries its tag list and container version', () => {
    const published = body();
    const workspace = body(fakeWorkspace);
    expect(published).toContain(JSON.stringify(fixtureTags.published));
    expect(workspace).toContain(JSON.stringify(fixtureTags.workspace));
    expect(published).toContain(`"version":${JSON.stringify(containerVersion.published)}`);
    expect(workspace).toContain(`"version":${JSON.stringify(containerVersion.workspace)}`);
  });

  test('the published list is 11 and 12, the workspace list drops 12 and adds 13, 14, 77, 88 and 89, and 45 is in neither', () => {
    expect(fixtureTags.published).toEqual([
      { id: '11', name: 'GA4 - Config', status: 'success', executionTime: 4 },
      { id: '12', status: 'failure', executionTime: 2 },
    ]);
    const workspace = fixtureTags.workspace;
    expect(workspace.map((t) => [t.id, t.status])).toEqual([['11', 'success'], ['13', 'failure'], ['14', 'success'], ['77', 'success'], ['88', 'success'], ['89', 'success']]);
    expect(workspace.filter((t) => t.name === undefined).map((t) => t.id)).toEqual(['13', '14']);
    expect(workspace.find((t) => t.id === '77')!.name).toBe('GA4 - Workspace Only');
    expect(workspace.find((t) => t.id === '88')!.name).toContain(fakeEmail);
    expect(workspace.find((t) => t.id === '89')!.name).toContain(fakeWorkspace.gtm_auth);
    expect([...fixtureTags.published, ...workspace].some((t) => t.id === '45')).toBe(false);
  });
});
