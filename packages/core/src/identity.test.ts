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

  it('does not flag plus-joined digit groups inside readable text', () => {
    const id = createIdentity(42);
    for (const text of ['cd[content_name]=Shoe+-+38+39+40+41', 'dt=Events+-+29+10+2026', 'Sizes:+36+38+40+42', 'Ref:+2026+1029+0001', 'p=+55.676098+012.568337']) {
      expect(scan(text, id)).toEqual([]);
    }
  });

  it('flags a plus-grouped phone that is a whole value', () => {
    const id = createIdentity(42);
    expect(scan('ph=%2B45+12+34+56+78&x=1', id)).toEqual([{ kind: 'phone', value: '+45+12+34+56+78' }]);
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

  it('finds base64 behind long prefixes and before trailing junk (#27)', () => {
    const payload = Buffer.from('{"email":"jane@shop.example.net"}').toString('base64url');
    for (const text of [`x=abcd${payload}`, `x=evt42${payload}`, `x=abcdefg${payload}`, `x=${payload}xyz`, `x=abcd_${payload}`, `x=abcd-${payload}`]) {
      expect(scan(text, id), text).toContainEqual(jane);
    }
    expect(scan(`x=abcd${Buffer.from('nothing to see here').toString('base64url')}`, id)).toEqual([]);
  });

  it('still finds short base64 values of 8 to 11 bytes', () => {
    expect(scan(`ph=${b64('+4512345678')}`, id)).toContainEqual({ kind: 'phone', value: '+4512345678' });
    expect(scan(`ph=${b64('jo@s.test')}`, id)).toContainEqual({ kind: 'email', value: 'jo@s.test' });
    expect(scan(`ph=${b64('ab@x.test')}`, id)).toContainEqual({ kind: 'email', value: 'ab@x.test' });
  });

  it('finds base64 behind each separator the design lists', () => {
    const payload = Buffer.from('{"em":"jane@shop.example.net"}').toString('base64url');
    for (const sep of ['/', '_', '-', '+']) {
      for (const text of [`d=abcdefgh${sep}${payload}`, `d=session1234567${sep}${payload}`, `d=${payload}${sep}tail1234567890`]) {
        expect(scan(text, id), text).toContainEqual(jane);
      }
    }
  });

  it('does not flag 43-character URL paths as hashes (#114)', () => {
    const urls = [
      'https://shop.localhost/products/BlueShirt-2024/Variant9X',
      'https://shop.localhost/api/Orders/Recent/2024-10-29T1000',
    ];
    for (const url of urls) {
      expect(scan(url, id), url).toEqual([]);
      expect(scan(`v=2&dl=${encodeURIComponent(url)}`, id), url).toEqual([]);
    }
  });

  it('does not flag 43-character relative paths under dp, ep.page_path and JSON keys (#114)', () => {
    const path = '/products/BlueShirt-2024/Variant9X12345abcd';
    expect(path).toHaveLength(43);
    expect(scan(`dp=${path}`, id)).toEqual([]);
    expect(scan(JSON.stringify({ page_path: path }), id)).toEqual([]);
    expect(scan(`ep.page_path=${encodeURIComponent(path)}`, id)).toEqual([]);
  });

  it('does not flag base64 text that happens to be 32 bytes long (#29)', () => {
    const path = '/gtag/js?id=G-PWTEST0001&l=dl123';
    expect(Buffer.from(path)).toHaveLength(32);
    expect(scan(`https://sgtm.localhost/abc123?k=${Buffer.from(path).toString('base64url')}`, id)).toEqual([]);
    const fragment = Buffer.from('{"event":"purchase","value":"123"}'.slice(0, 32)).toString('base64');
    expect(scan(`d=${encodeURIComponent(fragment)}`, id)).toEqual([]);
  });

  it('flags foreign base64 and base64url hashes and not the own ones (#29)', () => {
    expect(scan(`em=tv.1~em.${foreign.base64url}`, id)).toEqual([{ kind: 'hash', value: foreign.base64url }]);
    expect(scan(`em=${encodeURIComponent(foreign.base64)}`, id)).toEqual([{ kind: 'hash', value: foreign.base64 }]);
    const own = [hashEmail(id.email), hashPhone(id.phone)].flatMap((h) => [h.base64, h.base64url]);
    expect(scan(own.join('&em='), id)).toEqual([]);
  });

  it('does not flag 43-character tokens that are not hashes (#29)', () => {
    const tokens = [
      'this-is-a-long-lowercase-slug-for-an-article',
      'THIS-IS-A-LONG-UPPERCASE-TOKEN-FOR-AN-ARTICLE',
      '01HZX3K9Q8W2V5N7M4B6C1D0E3F8G2H5J7K9M1N3P5Q',
      'abcdefghij0123456789klmnopqrstuvwxyz01234567',
    ].map((t) => t.slice(0, 43));
    for (const token of tokens) {
      expect(token).toHaveLength(43);
      expect(scan(`x=${token}`, id), token).toEqual([]);
    }
    const text = [
      `ulid=${newId('hit')}${newId('hit')}`,
      'gcd=13l3l3l3l1l1l3l3l3l3l1l1l3l3l3l3l1l1l3l3l3l3l1l1&gcs=G111',
      'cid=1234567890.1730200000',
      'assets=logo@2x.png',
    ].join('&');
    expect(scan(text, id)).toEqual([]);
  });

  it('ignores random 32-byte tokens under state, nonce and csrf keys (#29)', () => {
    const token = 'CzBVep_E6Q4zWH2ix-wRNluApcrvFDleg6jN8hc8YYY';
    expect(scan(`state=${token}`, id)).toEqual([]);
    expect(scan(`nonce=${token}&csrf=${token}`, id)).toEqual([]);
    expect(scan(`em=${token}`, id)).toEqual([{ kind: 'hash', value: token }]);
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

  it('ignores random hashes under GA4 ep. keys and still flags identity keys (#114)', () => {
    const h = sha256('random-controller').hex;
    expect(scan(`ep.user_id=${h}&ep.client_id_hash=${h}&epn.external_id=${h}&cd[user_id]=${h}`, id)).toEqual([]);
    expect(scan(`em=${h}`, id)).toEqual([{ kind: 'hash', value: h }]);
    expect(scan(`ud[em]=${h}`, id)).toEqual([{ kind: 'hash', value: h }]);
  });

  it('keeps the country option as a label only (#32)', () => {
    expect(createIdentity(1, { country: 'DK' }).phone).toMatch(/^\+1/);
  });
});

describe('own identity is never flagged', () => {
  const glue = ['', 'test', 'abc', 'Q', 'abcd', 'Zz9'];
  const wrap = (me: ReturnType<typeof createIdentity>) => [
    me.email,
    me.phone,
    `em=${me.email}&ph=${me.phone}`,
    JSON.stringify({ email: me.email, phone: me.phone }),
  ];

  it('holds for 200 seeds across encodings and placements', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const me = createIdentity(seed);
      const values = [me.email, me.phone, ...Object.values(hashEmail(me.email)), ...Object.values(hashPhone(me.phone))];
      for (const value of values) {
        const encoded = [Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')];
        for (const form of [value, ...encoded]) {
          const texts = [`/u/${form}/collect`, `a=${form}+${form}`];
          if (form !== value) texts.push(`v_${form}`, `/u/${form}xyz`, `x=abcd${form}`, `x=${form}qrstuvwxyzabcdefghijkl`);
          for (const text of texts) expect(scan(text, me), `${seed} ${text}`).toEqual([]);
        }
      }
    }
  });

  it('holds for own base64 emails with random junk glued on', () => {
    const junk = 'OoAg2yme Mu0gcWUW Ag2mGaqW ~ZW + _x- 9Zq'.split(' ');
    for (const text of [
      'd=~ZWRlbi5oYW5lLnZnamNAZXhhbXBsZS5jb20OoAg2yme',
      'd=+ZWRlbi5oYW5lLnZnamNAZXhhbXBsZS5jb20Mu0gcWUW',
      'd=WUiq~Y2hldC5tb2VuLjh3d3dAZXhhbXBsZS5jb20Ag2mGaqW',
    ]) {
      expect(scan(text, createIdentity(48)), text).toEqual([]);
    }
    for (let seed = 1; seed <= 300; seed++) {
      const me = createIdentity(seed);
      for (const j of junk) {
        const form = Buffer.from(me.email).toString('base64').replace(/=+$/, '') + j;
        for (const text of [`d=${form}`, `q=${encodeURIComponent(form)}`]) {
          expect(scan(text, me), `${seed} ${text}`).toEqual([]);
        }
      }
    }
  });

  it('holds with glue text on either side of encoded values', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const me = createIdentity(seed);
      for (const value of wrap(me)) {
        for (const form of [Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) {
          for (const pre of glue) {
            for (const post of glue) {
              for (const text of [`d=${pre}${form}${post}`, `/u/${pre}${form}${post}`, `q=${encodeURIComponent(`${pre}${form}${post}`)}`]) {
                expect(scan(text, me), `${seed} ${text}`).toEqual([]);
              }
            }
          }
        }
      }
    }
  });
});

describe('foreign digests in base64', () => {
  it('flags digests before ~ and ; and not the own ones', () => {
    const me = createIdentity(1);
    const a = sha256('a@shop.example.net').base64url;
    const b = sha256('b@shop.example.net').base64url;
    for (const text of [`em=tv.1~em.${a}~ph.${b}`, `em=tv.1~em.${encodeURIComponent(a)}~ph.${encodeURIComponent(b)}`, `ud[em]=${a}&ud[ph]=${b}`]) {
      expect(scan(text, me).map((l) => l.value).sort(), text).toEqual([a, b].sort());
    }
    const own = [hashEmail(me.email).base64url, hashPhone(me.phone).base64url];
    expect(scan(`em=tv.1~em.${own[0]}~ph.${own[1]}`, me)).toEqual([]);
  });

  it('flags standard-base64 digests that start with + or /', () => {
    const me = createIdentity(1);
    let plus = 0;
    let slash = 0;
    for (let i = 0; plus < 5 || slash < 5; i++) {
      const form = sha256(`lead${i}@shop.example.net`).base64.replace(/=+$/, '');
      if (form.startsWith('+')) plus++;
      else if (form.startsWith('/')) slash++;
      else continue;
      expect(scan(`em=${form}`, me), form).toEqual([{ kind: 'hash', value: form }]);
      expect(scan(`em=${encodeURIComponent(form)}`, me).map((l) => l.value), form).toEqual([form]);
    }
  });

  it('flags every random SHA-256 digest as base64 and base64url', () => {
    const me = createIdentity(1);
    for (let i = 0; i < 400; i++) {
      const bytes = Buffer.from(sha256(`foreign${i}@shop.example.net`).hex, 'hex');
      for (const form of [bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url')]) {
        expect(scan(`em=${form}`, me), form).toEqual([{ kind: 'hash', value: form }]);
      }
    }
  });

  it('flags digests under every identity key and inside tv.1~ values', () => {
    const me = createIdentity(1);
    const keys = ['em', 'ph', 'fn', 'ln', 'ud[em]', 'ud[ph]', 'ud[fn]', 'ud[ln]', 'ud[ct]', 'sha256_email_address', 'sha256_phone_number', 'sha256_first_name', 'sha256_last_name', 'user_data.sha256_email_address'];
    for (let i = 0; i < 60; i++) {
      const bytes = Buffer.from(sha256(`key${i}@shop.example.net`).hex, 'hex');
      for (const form of [bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url'), bytes.toString('base64')]) {
        const bare = form.replace(/=+$/, '');
        for (const key of keys) {
          expect(scan(`${key}=${form}`, me).map((l) => l.value), `${key}=${form}`).toEqual([form]);
          expect(scan(`${encodeURIComponent(key)}=${encodeURIComponent(form)}`, me).map((l) => l.value)).toEqual([form]);
          expect(scan(JSON.stringify({ [key]: form }), me).map((l) => l.value)).toEqual([form]);
        }
        expect(scan(`tv.1~em.${form}~ph.${form}`, me).map((l) => l.value)).toEqual([form]);
        for (const key of ['utm_campaign', 'dp', 'ep.item_id', 'item_em', 'ep.em']) {
          expect(scan(`${key}=${bare}`, me), `${key}=${bare}`).toEqual([]);
        }
        expect(scan(JSON.stringify({ page_path: bare }), me)).toEqual([]);
        expect(scan(bare, me)).toEqual([]);
      }
    }
  });

  it('does not flag readable 43-character values', () => {
    const me = createIdentity(1);
    const values = ['SummerSale2024-EmailBlast-Newsletter-Week1', 'Product-Variant-Blue-Large-Edition-Item-12345', '/products/BlueShirt-2024/Variant9X12345abcd'];
    for (const v of values) {
      const value = v.slice(0, 43);
      for (const text of [`utm_campaign=${value}`, `dp=${value}`, `ep.item_id=${value}`, JSON.stringify({ page_path: value }), value]) {
        expect(scan(text, me), text).toEqual([]);
      }
    }
  });
});
