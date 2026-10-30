import { expect, test } from 'vitest';
import { Recorder } from './recorder.ts';

test('recordBanner moves page-clock banner times onto the shared clock', () => {
  const recorder = Object.assign(Object.create(Recorder.prototype) as Recorder, {
    clockOffset: 1500,
    bannerEvents: [],
  }) as unknown as { recordBanner: Recorder['recordBanner']; bannerEvents: { t: number; tEnd: number }[] };
  recorder.recordBanner({
    detected: true,
    shown: true,
    cmp: 'x',
    action: 'accept',
    result: 'ok',
    t: 1_000_000,
    tEnd: 1_000_040,
  });
  expect(recorder.bannerEvents).toEqual([{ t: 1_001_500, tEnd: 1_001_540, action: 'accept' }]);
});
