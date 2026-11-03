import { describe, expect, test } from 'vitest';
import {
  CONTAINER_HOST,
  INTRO_SEEN_KEY,
  MDELAYS,
  NOTIFICATIONS,
  SCATTER,
  TAGS,
  battery,
  deskClock,
  introGateScript,
  mailList,
  placeNotifications,
  timeSpent,
  wastedLine,
} from './intro-data.ts';

describe('intro data', () => {
  test('one notification per delay, 16 tag rows, and the story host on .example', () => {
    expect(NOTIFICATIONS).toHaveLength(13);
    expect(MDELAYS).toHaveLength(13);
    expect(SCATTER).toHaveLength(13);
    expect(TAGS).toHaveLength(16);
    expect(CONTAINER_HOST).toBe('www.northwind.example');
  });

  test('the first four notifications stack at the top right and the rest scatter', () => {
    const placed = placeNotifications(13);
    expect(placed.slice(0, 4).map((n) => [n.x, n.y, n.rotate])).toEqual([
      ['calc(100% - 340px)', '42px', '0deg'],
      ['calc(100% - 340px)', '130px', '0deg'],
      ['calc(100% - 340px)', '218px', '0deg'],
      ['calc(100% - 340px)', '306px', '0deg'],
    ]);
    expect(placed.slice(4).map((n) => [n.x, n.y, n.rotate])).toEqual(SCATTER.slice(0, 9));
    expect(placeNotifications(2)).toHaveLength(2);
  });

  test('mail notifications land on top of the inbox, newest first', () => {
    expect(mailList(0).map((m) => m.from)).toEqual(['Mads Holm', 'Sofie (Legal)', 'Pixel & Co', 'Office', 'GTM Weekly']);
    expect(mailList(5).slice(0, 4).map((m) => m.subject)).toEqual([
      'RE: RE: pixel',
      'Consent audit, DPO cc',
      'FW: Complaint re. cookies',
      'Quick favour? Meta numbers + consent',
    ]);
  });

  test('the clock speeds up, the battery drains and the ticket time grows', () => {
    expect([deskClock(0), deskClock(4), deskClock(13)]).toEqual(['Thu 16:47', 'Thu 17:05', 'Thu 20:01']);
    expect([battery(0), battery(13), battery(30)]).toEqual(['80%', '28%', '8%']);
    expect([timeSpent(0), timeSpent(6), timeSpent(13)]).toEqual(['5m', '46m', '3h 19m']);
    expect(wastedLine()).toBe('3h 19m in the tag manager. Meta still fires before consent.');
  });
});

describe('the gate script', () => {
  interface Env {
    stored?: string | null;
    storageThrows?: boolean;
    width?: number;
    reduce?: boolean;
  }

  function runGate({ stored = null, storageThrows = false, width = 1280, reduce = false }: Env) {
    const dataset: Record<string, string> = {};
    const timeouts: (() => void)[] = [];
    const localStorage = {
      getItem(key: string) {
        if (storageThrows) throw new Error('SecurityError');
        return key === INTRO_SEEN_KEY ? stored : null;
      },
    };
    const window = { innerWidth: width, matchMedia: (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)' }) };
    const document = { documentElement: { dataset } };
    const setTimeout = (fn: () => void) => timeouts.push(fn);
    new Function('localStorage', 'window', 'document', 'setTimeout', introGateScript)(localStorage, window, document, setTimeout);
    return { pending: dataset.intro === 'pending', dataset, timeouts };
  }

  test('marks the intro pending on a first visit to a wide window without reduced motion', () => {
    expect(runGate({}).pending).toBe(true);
  });

  test('does not mark it when seen, narrow, with reduced motion, or when storage throws', () => {
    expect(runGate({ stored: '1' }).pending).toBe(false);
    expect(runGate({ width: 859 }).pending).toBe(false);
    expect(runGate({ reduce: true }).pending).toBe(false);
    expect(runGate({ storageThrows: true }).pending).toBe(false);
    expect(runGate({ stored: '0', width: 860 }).pending).toBe(true);
  });

  test('clears a pending mark the island never took over', () => {
    const run = runGate({});
    run.timeouts.forEach((fn) => fn());
    expect(run.dataset.intro).toBeUndefined();
  });
});
