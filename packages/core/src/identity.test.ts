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
    expect(scan('em=jane@shop.example.net', id)).toEqual([{ kind: 'email', value: 'jane@shop.example.net' }]);
    expect(scan('em=jane%40shop.example.net', id)).toEqual([{ kind: 'email', value: 'jane@shop.example.net' }]);
    const encoded = encodeURIComponent(b64('{"email":"jane@shop.example.net"}'));
    expect(scan(`dtdc=${encoded}`, id).map((m) => m.value)).toContain('jane@shop.example.net');
  });

  it('flags a foreign email in a disguised Stape /data hit with a percent-encoded dtdc', () => {
    for (let i = 0; i < 50; i++) {
      const json = JSON.stringify({ event_name: 'page_view', page_title: 'Shop?>'.repeat(i % 5 + 1), email: 'jane@shop.example.net' });
      const inner = `/data?v=2&dtdc=${encodeURIComponent(b64(json))}`;
      const outer = `https://sgtm.localhost/abc123?k=${encodeURIComponent(b64(inner))}`;
      expect(scan(outer, id).map((x) => x.value), `case ${i}`).toContain('jane@shop.example.net');
    }
  });

  it('flags a foreign phone and a foreign hash', () => {
    expect(scan('ph=+4512345678', id)).toEqual([{ kind: 'phone', value: '+4512345678' }]);
    const foreign = sha256('someone@shop.example.net').hex;
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

  it('does not flag asset names that look like emails', () => {
    const text = 'https://cdn.example.com/img/logo@2x.png?w=98 /fonts/icons@1.0.woff2 /css/app@3.css';
    expect(scan(text, id)).toEqual([]);
    expect(scan('mail=someone@example.png.example.com', id)).toEqual([{ kind: 'email', value: 'someone@example.png.example.com' }]);
  });

  it('does not flag a number after a form-encoded plus-space as a phone', () => {
    const id = createIdentity(42);
    expect(scan('dt=Order+100000001&q=sku+123456789', id)).toEqual([]);
  });

  it('finds an encoded foreign email next to a stray percent sign', () => {
    const id = createIdentity(42);
    const found = scan('note=10%&em=jane%40shop.example.net', id);
    expect(found).toContainEqual({ kind: 'email', value: 'jane@shop.example.net' });
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
    const jane = { kind: 'email', value: 'jane@shop.example.net' };
    expect(scan('d=%22jane@shop.example.net%22', id)).toEqual([jane]);
    expect(scan('dt=Order+for+jane@shop.example.net', id)).toEqual([jane]);
  });

  it('finds a foreign email in base64 after path segments', () => {
    const payload = Buffer.from('{"email":"jane@shop.example.net"}').toString('base64url');
    for (const url of [`https://collector.pingwright.invalid/r/${payload}`, `/data/${payload}`]) {
      expect(scan(url, id), url).toContainEqual({ kind: 'email', value: 'jane@shop.example.net' });
    }
  });

  it('finds a foreign email in base64 JSON with non-ASCII text', () => {
    const json = JSON.stringify({ page_title: 'Ærøskøbing Østergård', email: 'jane@shop.example.net' });
    const found = scan(`dtdc=${Buffer.from(json, 'utf8').toString('base64')}`, id);
    expect(found).toContainEqual({ kind: 'email', value: 'jane@shop.example.net' });
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

describe('scan fixes', () => {
  const foreign = sha256('someone@shop.example.net');
  const jane = { kind: 'email', value: 'jane@shop.example.net' };

  it('finds base64 glued to text (#27)', () => {
    const payload = Buffer.from('{"email":"jane@shop.example.net"}').toString('base64url');
    for (const text of [`x=v_${payload}`, `x=v-${payload}`, `x=ab${payload}`, `x=a${payload}`, `x=abc${payload}`]) {
      expect(scan(text, id), text).toContainEqual(jane);
    }
    expect(scan(`x=v_${Buffer.from('nothing to see here').toString('base64url')}`, id)).toEqual([]);
  });

  it('flags foreign base64 and base64url hashes and not the own ones (#29)', () => {
    expect(scan(`em=tv.1~em.${foreign.base64url}`, id)).toEqual([{ kind: 'hash', value: foreign.base64url }]);
    expect(scan(`em=${encodeURIComponent(foreign.base64)}`, id)).toEqual([{ kind: 'hash', value: foreign.base64 }]);
    const own = [hashEmail(id.email), hashPhone(id.phone)].flatMap((h) => [h.base64, h.base64url]);
    expect(scan(own.join('&em='), id)).toEqual([]);
  });

  it('does not flag 43-character tokens that are not hashes (#29)', () => {
    const text = [
      'slug=this-is-a-long-lowercase-slug-for-an-article-x',
      `ulid=${newId('hit')}${newId('hit')}`.slice(0, 60),
      'gcd=13l3l3l3l1l1l3l3l3l3l1l1l3l3l3l3l1l1l3l3l3l3l1l1&gcs=G111',
      'cid=1234567890.1730200000',
      'assets=logo@2x.png',
    ].join('&');
    expect(scan(text, id)).toEqual([]);
  });

  it('flags formatted international phone numbers and compares by number (#30)', () => {
    for (const text of ['ph=+44 20 7946 0958', 'ph=+45 12 34 56 78', 'ph=%2B45+12+34+56+78', 'ph=+45-12-34-56-78']) {
      expect(scan(text, id), text).toHaveLength(1);
      expect(scan(text, id)[0]?.kind).toBe('phone');
    }
    const spaced = id.phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 $1 $2 $3');
    expect(scan(`ph=${spaced}`, id)).toEqual([]);
  });

  it('does not read a form-encoded plus-space before a number as a phone (#31)', () => {
    expect(scan('dt=Order+100012345&en=purchase', id)).toEqual([]);
    expect(scan('dt=order_+100012345', id)).toEqual([]);
    expect(scan('ts=1730200000+12345678', id)).toEqual([]);
  });

  it('picks assigned area codes only (#33)', () => {
    const bad = new Set([211, 311, 411, 511, 611, 711, 811, 911, 290, 398]);
    for (let seed = 0; seed < 300; seed++) {
      expect(bad.has(Number(createIdentity(seed).phone.slice(2, 5)))).toBe(false);
    }
  });

  it('scans long token runs in linear time (#34)', () => {
    const started = performance.now();
    scan('a'.repeat(200_000), id);
    scan(`${'a.'.repeat(50_000)}@`, id);
    scan('a-'.repeat(50_000), id);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(scan(`${'a'.repeat(100_000)} em=jane@shop.example.net`, id)).toContainEqual(jane);
  });

  it('keeps the tag of a plus-addressed foreign email (#35)', () => {
    const found = scan('em=jane+shop@shop.example.net', id);
    expect(found).toContainEqual({ kind: 'email', value: 'jane+shop@shop.example.net' });
    expect(scan(`dt=Order+${id.email}`, id)).toEqual([]);
  });

  it('does not flag random ids and hashed client ids under identifier keys (#114)', () => {
    const random = sha256('random-controller').hex;
    for (const key of ['uid', 'user_id', 'external_id', 'client_id_hash', 'controllerId']) {
      expect(scan(`${key}=${random}`, id), key).toEqual([]);
      expect(scan(JSON.stringify({ [key]: random }), id), key).toEqual([]);
    }
    expect(scan(`uid=${foreign.base64url}`, id)).toEqual([]);
  });

  it('still flags the same hashes under identity keys and with no key (#114)', () => {
    expect(scan(`em=${foreign.hex}`, id)).toEqual([{ kind: 'hash', value: foreign.hex }]);
    expect(scan(`ud[em]=${foreign.hex}`, id)).toHaveLength(1);
    expect(scan(JSON.stringify({ user_data: { em: foreign.hex } }), id)).toHaveLength(1);
    expect(scan(`uid=1&em=${foreign.hex}`, id)).toHaveLength(1);
    expect(scan(foreign.hex, id)).toHaveLength(1);
  });

  it('keeps the country option as a label only (#32)', () => {
    expect(createIdentity(1, { country: 'DK' }).phone).toMatch(/^\+1/);
  });
});
