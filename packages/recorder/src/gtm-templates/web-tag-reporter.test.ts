import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSandbox } from './sandbox.test-helper.ts';
import { readTemplateSections } from './tpl.ts';

const template = readTemplateSections(
  readFileSync(new URL('./web-tag-reporter.tpl', import.meta.url), 'utf8'),
);

const host = {
  data: { nameKey: 'name' },
  dataLayer: { event: 'purchase', 'gtm.uniqueEventId': 7 },
  containerVersion: { version: '3', containerId: 'GTM-PWTEST1' },
};

describe('web tag reporter template', () => {
  it('has the exact permissions', () => {
    expect(template.permissions).toEqual([
      { id: 'read_event_metadata', keys: [] },
      { id: 'access_globals', keys: ['tagreeveTagReport'] },
      { id: 'read_data_layer', keys: ['event', 'gtm.uniqueEventId'] },
      { id: 'read_container_data', keys: [] },
    ]);
    const entry = JSON.parse(template.sections['WEB_PERMISSIONS']!)[1].instance.param[0].value
      .listItem[0];
    const flags = entry.mapValue.map((v: { boolean?: boolean }) => v.boolean);
    expect(flags.slice(1)).toEqual([false, false, true]);
  });

  it('is a web tag template', () => {
    const info = JSON.parse(template.sections['INFO']!);
    expect(info.type).toBe('TAG');
    expect(info.containerContexts).toEqual(['WEB']);
    expect(info.displayName).toBe('Tagreeve tag reporter');
  });

  it('has one nameKey field that defaults to name', () => {
    const params = JSON.parse(template.sections['TEMPLATE_PARAMETERS']!);
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ name: 'nameKey', defaultValue: 'name' });
  });

  it('requires no API beyond the permissions', () => {
    const run = runSandbox(template.sandboxedJs, template.permissions, host);
    expect([...run.required].sort()).toEqual([
      'addEventCallback',
      'callInWindow',
      'copyFromDataLayer',
      'getContainerVersion',
    ]);
  });

  it('is refused an API the permissions do not grant', () => {
    expect(() => runSandbox(`require('sendPixel');`, template.permissions, host)).toThrow(
      /not granted/,
    );
  });

  it('sends one call with the planned keys and no extra metadata', () => {
    const run = runSandbox(template.sandboxedJs, template.permissions, host);
    run.fireEvent('GTM-PWTEST1', {
      tags: [
        { id: '11', status: 'success', executionTime: 4, name: 'GA4 - Purchase' },
        { id: '13', status: 'failure', executionTime: 9, name: 'Meta - PageView' },
        { id: '14', status: 'success', executionTime: 2, group: 'secret-group' },
      ],
    });
    expect(run.windowCalls).toHaveLength(1);
    const call = run.windowCalls[0]!;
    expect(call.name).toBe('tagreeveTagReport');
    expect(call.args).toEqual([
      {
        v: 1,
        container: 'GTM-PWTEST1',
        event: 'purchase',
        gtmUniqueEventId: 7,
        version: '3',
        tags: [
          { id: '11', status: 'success', executionTime: 4, name: 'GA4 - Purchase' },
          { id: '13', status: 'failure', executionTime: 9, name: 'Meta - PageView' },
          { id: '14', status: 'success', executionTime: 2, name: null },
        ],
      },
    ]);
    expect(JSON.stringify(call.args)).not.toContain('group');
  });

  it('reads the name from the nameKey field', () => {
    const run = runSandbox(template.sandboxedJs, template.permissions, {
      ...host,
      data: { nameKey: 'label' },
    });
    run.fireEvent('GTM-PWTEST1', {
      tags: [{ id: '1', status: 'success', executionTime: 1, name: 'x', label: 'y' }],
    });
    const report = run.windowCalls[0]!.args[0] as { tags: { name: string | null }[] };
    expect(report.tags[0]!.name).toBe('y');
  });

  it('runs gtmOnSuccess and does not throw with no window function', () => {
    const run = runSandbox(template.sandboxedJs, template.permissions, host);
    expect(run.successCalls).toBe(1);
    expect(() =>
      run.fireEvent('GTM-PWTEST1', { tags: [{ id: '1', status: 'success', executionTime: 1 }] }),
    ).not.toThrow();
  });

  it('reports an event with no tags list as an empty list', () => {
    const run = runSandbox(template.sandboxedJs, template.permissions, host);
    run.fireEvent('GTM-PWTEST1', {});
    expect((run.windowCalls[0]!.args[0] as { tags: unknown[] }).tags).toEqual([]);
  });
});
