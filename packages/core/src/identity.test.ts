import { describe, expect, it } from 'vitest';
import {
  createIdentity,
  hashEmail,
  hashPhone,
  normalizeEmail,
  normalizePhone,
  scan,
  sha256,
} from './identity.ts';
import { newId } from './ids.ts';

const id = createIdentity(42);
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('createIdentity', () => {
  it('gives the same identity for the same seed', () => {
    expect(createIdentity(7)).toEqual(createIdentity(7));
  });

  it('gives different identities for different seeds', () => {
    expect(createIdentity(1)).not.toEqual(createIdentity(2));
    expect(createIdentity(1).email).not.toBe(createIdentity(2).email);
  });

  it('uses a reserved email domain, a fictional E.164 phone and an explicit country', () => {
    for (let seed = 0; seed < 50; seed++) {
      const i = createIdentity(seed);
      expect(i.email).toMatch(/^[a-z0-9.]+@example\.com$/);
      expect(i.phone).toMatch(/^\+1[2-9]\d{2}5550[1]\d{2}$/);
      expect(i.country).toBe('US');
    }
    expect(createIdentity(1, { country: 'DK' }).country).toBe('DK');
  });
});

describe('hashes', () => {
  it('matches the known SHA-256 of a fixed email', () => {
    expect(hashEmail('  Test@Example.com ').hex).toBe(
      '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b',
    );
  });

  it('exposes base64 and base64url forms of the digest', () => {
    const h = sha256('x');
    expect(Buffer.from(h.base64, 'base64').toString('hex')).toBe(h.hex);
    expect(Buffer.from(h.base64url, 'base64url').toString('hex')).toBe(h.hex);
  });

  it('normalises email and phone', () => {
    expect(normalizeEmail(' A@B.com ')).toBe('a@b.com');
    expect(normalizePhone('+1 (202) 555-0123')).toBe('+12025550123');
    expect(hashPhone('+1 202 555 0123').hex).toBe(sha256('+12025550123').hex);
  });
});

describe('scan', () => {
  it('flags a foreign email, plain, URL-encoded and inside base64', () => {
    expect(scan('em=jane@real-shop.dk', id)).toEqual([{ kind: 'email', value: 'jane@real-shop.dk' }]);
    expect(scan('em=jane%40real-shop.dk', id)).toEqual([{ kind: 'email', value: 'jane@real-shop.dk' }]);
    const encoded = encodeURIComponent(b64('{"email":"jane@real-shop.dk"}'));
    expect(scan(`dtdc=${encoded}`, id).map((m) => m.value)).toContain('jane@real-shop.dk');
  });

  it('flags a foreign email in a disguised Stape /data hit with a percent-encoded dtdc', () => {
    for (let i = 0; i < 50; i++) {
      const json = JSON.stringify({ event_name: 'page_view', page_title: 'Shop?>'.repeat(i % 5 + 1), email: 'jane@real-shop.dk' });
      const inner = `/data?v=2&dtdc=${encodeURIComponent(b64(json))}`;
      const outer = `https://sgtm.localhost/abc123?k=${encodeURIComponent(b64(inner))}`;
      expect(scan(outer, id).map((x) => x.value), `case ${i}`).toContain('jane@real-shop.dk');
    }
  });

  it('flags a foreign phone and a foreign hash', () => {
    expect(scan('ph=+4512345678', id)).toEqual([{ kind: 'phone', value: '+4512345678' }]);
    const foreign = sha256('someone@real-shop.dk').hex;
    expect(scan(`ud[em]=${foreign}`, id)).toEqual([{ kind: 'hash', value: foreign }]);
  });

  it('does not flag the identity own email, phone or hashes', () => {
    const text = [
      id.email,
      encodeURIComponent(id.email),
      b64(id.email),
      id.phone,
      hashEmail(id.email).hex,
      hashEmail(id.email).hex.toUpperCase(),
      hashPhone(id.phone).hex,
      sha256(id.phone.slice(1)).hex,
      sha256(id.lastName.toLowerCase()).hex,
    ].join('&');
    expect(scan(text, id)).toEqual([]);
  });

  it('does not flag fake vendor ids, ULIDs, consent strings or client ids', () => {
    const text = [
      'tid=G-PWTEST0001',
      'id=AW-000000001',
      'ev=Purchase&id=100000000000001',
      `eid=${newId('hit')}`,
      newId('request'),
      'gcd=13l3l3l3l1l1&gcs=G111&gcs=G100',
      'cid=1234567890.1730200000&_p=1730200000123&sid=1730200000',
      'dl=https%3A%2F%2Flocalhost%3A3000%2Fcheckout&dt=Checkout',
      'ts=1730200000000',
    ].join('&');
    expect(scan(text, id)).toEqual([]);
  });

  it('finds an encoded foreign email next to a stray percent sign', () => {
    const id = createIdentity(42);
    const found = scan('note=10%&em=jane%40real-shop.dk', id);
    expect(found).toContainEqual({ kind: 'email', value: 'jane@real-shop.dk' });
  });

  it('does not flag the own email next to escapes or plus-spaces', () => {
    for (const text of [
      `d=%7B%22email%22%3A%22${id.email}%22%7D`,
      encodeURI(`{"email":"${id.email}"}`),
      `dt=Order+for+${id.email}`,
      `x=mailto%3A${id.email}`,
    ]) {
      expect(scan(text, id), text).toEqual([]);
    }
  });

  it('reports a foreign email once with a clean value', () => {
    const jane = { kind: 'email', value: 'jane@real-shop.dk' };
    expect(scan('d=%22jane@real-shop.dk%22', id)).toEqual([jane]);
    expect(scan('dt=Order+for+jane@real-shop.dk', id)).toEqual([jane]);
  });

  it('finds a foreign email in base64 after path segments', () => {
    const payload = Buffer.from('{"email":"jane@real-shop.dk"}').toString('base64url');
    for (const url of [`https://collector.pingwright.invalid/r/${payload}`, `/data/${payload}`]) {
      expect(scan(url, id), url).toContainEqual({ kind: 'email', value: 'jane@real-shop.dk' });
    }
  });

  it('finds a foreign email in base64 JSON with non-ASCII text', () => {
    const json = JSON.stringify({ page_title: 'Ærøskøbing Østergård', email: 'jane@real-shop.dk' });
    const found = scan(`dtdc=${Buffer.from(json, 'utf8').toString('base64')}`, id);
    expect(found).toContainEqual({ kind: 'email', value: 'jane@real-shop.dk' });
  });

  it('does not flag Meta-normalised own name and city hashes across seeds', () => {
    const strip = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let seed = 0; seed < 200; seed++) {
      const id = createIdentity(seed);
      const text = [id.firstName, id.lastName, id.city, id.zip, id.country]
        .map((v) => sha256(strip(v)).hex)
        .join('&');
      expect(scan(text, id), `seed ${seed}`).toEqual([]);
    }
  });
});
