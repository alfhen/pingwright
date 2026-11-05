import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readTemplateSections } from './tpl.ts';

describe('readTemplateSections', () => {
  const text = [
    '___INFO___',
    '',
    '{"type":"TAG"}',
    '',
    '___SANDBOXED_JS_FOR_WEB_TEMPLATE___',
    '',
    'data.gtmOnSuccess();',
    '',
    '___WEB_PERMISSIONS___',
    '',
    JSON.stringify([
      { instance: { key: { publicId: 'read_event_metadata' }, param: [] } },
      {
        instance: {
          key: { publicId: 'read_data_layer' },
          param: [
            { key: 'keyPatterns', value: { type: 2, listItem: [{ type: 1, string: 'event' }] } },
          ],
        },
      },
      {
        instance: {
          key: { publicId: 'access_globals' },
          param: [
            {
              key: 'keys',
              value: {
                type: 2,
                listItem: [
                  {
                    type: 3,
                    mapKey: [{ type: 1, string: 'key' }],
                    mapValue: [{ type: 1, string: 'someFn' }],
                  },
                ],
              },
            },
          ],
        },
      },
    ]),
    '',
    '___NOTES___',
    '',
    'Some notes',
  ].join('\n');

  it('splits the sections by name', () => {
    const t = readTemplateSections(text);
    expect(Object.keys(t.sections)).toEqual([
      'INFO',
      'SANDBOXED_JS_FOR_WEB_TEMPLATE',
      'WEB_PERMISSIONS',
      'NOTES',
    ]);
    expect(t.sections['NOTES']).toBe('Some notes');
    expect(t.sandboxedJs).toBe('data.gtmOnSuccess();');
  });

  it('parses the permissions and their keys', () => {
    const t = readTemplateSections(text);
    expect(t.permissions).toEqual([
      { id: 'read_event_metadata', keys: [] },
      { id: 'read_data_layer', keys: ['event'] },
      { id: 'access_globals', keys: ['someFn'] },
    ]);
  });

  it('reads the shipped template', () => {
    const file = new URL('./web-tag-reporter.tpl', import.meta.url);
    const t = readTemplateSections(readFileSync(file, 'utf8'));
    expect(Object.keys(t.sections)).toEqual([
      'TERMS_OF_SERVICE',
      'INFO',
      'TEMPLATE_PARAMETERS',
      'SANDBOXED_JS_FOR_WEB_TEMPLATE',
      'WEB_PERMISSIONS',
      'TESTS',
      'NOTES',
    ]);
  });
});
