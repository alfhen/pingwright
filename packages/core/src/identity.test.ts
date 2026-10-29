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
});
