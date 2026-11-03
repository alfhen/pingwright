import { newId } from '@tagreeve/core';
import { describe, expect, test, vi } from 'vitest';
import { decodeRequest } from '@tagreeve/decoders';
import {
  captureServerContainerCall,
  createForward,
  defaultServerContainerImage,
  MAX_QUIET_WAIT_MS,
  QUIET_MS,
  resolveUpstreamOrigin,
  serverContainerAnswer,
  waitForQuiet,
  type CaptureContext,
} from './capture.ts';
import type { ProxyRequest } from './proxy.ts';

const TOKEN = 'pw-fixture-access-token';
const PROOF = 'pw-fixture-proof-value';
const runId = newId('run');
const stepId = newId('step');
const context: CaptureContext = { runId, stepId };

function call(over: Partial<Omit<ProxyRequest, 'body'>> & { body?: string } = {}): ProxyRequest {
  const { body, ...rest } = over;
  return {
    method: 'POST',
    url: 'https://graph.facebook.com/v21.0/100000000000001/events',
    headers: {},
    body: Buffer.from(body ?? ''),
    bodyComplete: true,
    receivedAt: 1500,
    ...rest,
  };
}

describe('redaction before the record exists', () => {
  test.each([
    ['access_token first in the query', `https://graph.facebook.com/v21.0/1/events?access_token=${TOKEN}&a=1`],
    ['access_token last in the query', `https://graph.facebook.com/v21.0/1/events?a=1&access_token=${TOKEN}`],
    ['appsecret_proof in the query', `https://graph.facebook.com/v21.0/1/events?appsecret_proof=${PROOF}&a=1`],
    ['both in the query', `https://graph.facebook.com/v21.0/1/events?access_token=${TOKEN}&appsecret_proof=${PROOF}`],
  ])('%s', (_name, url) => {
    const request = captureServerContainerCall(call({ url }), context);
    expect(request.url).not.toContain(TOKEN);
    expect(request.url).not.toContain(PROOF);
    expect(request.url).toContain('=[redacted]');
  });

  test.each([
    ['a form body, secret first', `access_token=${TOKEN}&appsecret_proof=${PROOF}&a=1`],
    ['a form body, secret last', `a=1&access_token=${TOKEN}`],
    ['a JSON body, secret first', `{"access_token":"${TOKEN}","appsecret_proof":"${PROOF}","data":[]}`],
    ['a JSON body, secret last', `{"data":[],"access_token": "${TOKEN}"}`],
    ['a JSON body with the secret before an array', `{"appsecret_proof":"${PROOF}","data":[{"a":1}],"access_token":"${TOKEN}"}`],
  ])('%s', (_name, body) => {
    const request = captureServerContainerCall(call({ body }), context);
    expect(request.postData).not.toContain(TOKEN);
    expect(request.postData).not.toContain(PROOF);
    expect(request.postData).toContain('[redacted]');
  });

  test('a JSON body stays valid JSON and keeps its other fields', () => {
    const request = captureServerContainerCall(call({ body: `{"access_token":"${TOKEN}","data":[{"event_name":"Purchase"}]}` }), context);
    expect(JSON.parse(request.postData!)).toEqual({ access_token: '[redacted]', data: [{ event_name: 'Purchase' }] });
  });

  test.each(['access-token', 'x-api-key', 'Authorization', 'Cookie'])('the %s header', (name) => {
    const request = captureServerContainerCall(call({ headers: { [name]: TOKEN, accept: 'application/json' } }), context);
    expect(request.headers[name]).toBe('[redacted]');
    expect(request.headers.accept).toBe('application/json');
    expect(JSON.stringify(request)).not.toContain(TOKEN);
  });

  test('the decoders read the redacted record, so no hit holds the secret', () => {
    const request = captureServerContainerCall(
      call({ url: `https://graph.facebook.com/v21.0/100000000000001/events?access_token=${TOKEN}`, body: JSON.stringify({ data: [{ event_name: 'Purchase', event_id: 'e-1' }] }) }),
      context,
    );
    const hits = decodeRequest(request);
    expect(hits.map((h) => h.vendor)).toEqual(['meta-capi']);
    expect(JSON.stringify(hits)).not.toContain(TOKEN);
  });

  test('an input without a secret is not changed', () => {
    const url = 'https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001';
    expect(captureServerContainerCall(call({ url, body: 'en=Purchase' }), context)).toMatchObject({ url, postData: 'en=Purchase' });
  });
});

describe('the rebuilt request', () => {
  test('has the fields a browser request has, with the proxy time and the container markers', () => {
    const request = captureServerContainerCall(call({ method: 'GET', url: 'https://www.googleadservices.com/pagead/conversion/1/?label=x', headers: { host: 'www.googleadservices.com', 'x-pw-multi': ['a', 'b'] } }), context);
    expect(request).toMatchObject({
      type: 'request',
      runId,
      t: 1500,
      method: 'GET',
      resourceType: 'fetch',
      frameUrl: null,
      initiator: 'serverContainer',
      outcome: 'stubbed',
      captured: 'serverContainer',
      postData: null,
      headers: { host: 'www.googleadservices.com', 'x-pw-multi': 'a, b' },
    });
  });

  test('t is the receive time of the proxy, on the clock of the recorder', () => {
    expect(captureServerContainerCall(call({ receivedAt: 123456 }), context).t).toBe(123456);
  });
});

describe('step of a call', () => {
  test('is the step the recorder named when the call arrived', () => {
    expect(captureServerContainerCall(call(), context).stepId).toBe(stepId);
  });

  test('is null before any step', () => {
    expect(captureServerContainerCall(call(), { runId, stepId: null }).stepId).toBeNull();
  });
});

describe('serverContainerAnswer', () => {
  test('answers the Conversions API like stub mode and everything else with 204', () => {
    expect(serverContainerAnswer({ url: 'https://graph.facebook.com/v21.0/1/events' }).status).toBe(200);
    expect(serverContainerAnswer({ url: 'https://www.google-analytics.com/g/collect' }).status).toBe(204);
  });
});

describe('resolveUpstreamOrigin', () => {
  const stand = '/bin/sh';
  const seam = { TAGREEVE_TEST_SERVER_CONTAINER_CMD: stand };

  test('is Google without the seam value', () => {
    expect(resolveUpstreamOrigin({}, ['127.0.0.1'])).toBe('https://www.googletagmanager.com');
    expect(resolveUpstreamOrigin({ TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: '' }, ['sgtm.example.com'])).toBe('https://www.googletagmanager.com');
  });

  test('takes a loopback http origin when the stand-in runs on loopback hosts', () => {
    expect(resolveUpstreamOrigin({ ...seam, TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: 'http://127.0.0.1:4010' }, ['127.0.0.1'])).toBe('http://127.0.0.1:4010');
  });

  test.each([
    ['without the stand-in command', {}, ['127.0.0.1'], 'http://127.0.0.1:4010'],
    ['with a hosted serverHosts host', seam, ['sgtm.example.com'], 'http://127.0.0.1:4010'],
    ['for a non-loopback host', seam, ['127.0.0.1'], 'http://upstream-secret.example.com'],
    ['for https', seam, ['127.0.0.1'], 'https://127.0.0.1:4010'],
    ['with a path', seam, ['127.0.0.1'], 'http://127.0.0.1:4010/x'],
    ['with credentials', seam, ['127.0.0.1'], 'http://user:pass@127.0.0.1:4010'],
    ['that is not a URL', seam, ['127.0.0.1'], 'not-a-url-secret'],
  ])('is refused %s, and the message holds no value', (_name, extra, hosts, value) => {
    let message = '';
    try {
      resolveUpstreamOrigin({ ...extra, TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: value }, hosts);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('is not usable');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('4010');
  });
});

describe('createForward', () => {
  const matched = (url: string): ProxyRequest => ({ method: 'GET', url, headers: { cookie: 'pw-cookie', 'x-secret': 'pw-header' }, body: Buffer.alloc(0), bodyComplete: true, receivedAt: 1 });

  test('takes only the path and query from the matched request and uses the given origin', async () => {
    const doFetch = vi.fn(async () => new Response('file', { status: 200, headers: { 'content-type': 'text/javascript', 'set-cookie': 'a=b', 'content-encoding': 'gzip' } }));
    const answer = await createForward('http://127.0.0.1:4010', doFetch as unknown as typeof fetch)(matched('https://www.googletagmanager.com/server.js?id=GTM-PWTEST1'));
    const [target, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(target).toBe('http://127.0.0.1:4010/server.js?id=GTM-PWTEST1');
    expect(init.method).toBe('GET');
    expect(JSON.stringify(init.headers)).not.toContain('pw-');
    expect(answer.status).toBe(200);
    expect(answer.headers).toEqual({ 'content-type': 'text/javascript' });
    expect(Buffer.from(answer.body as Uint8Array).toString()).toBe('file');
  });

  test('builds the Google origin from a constant, not from the request host', async () => {
    const doFetch = vi.fn(async () => new Response('x'));
    await createForward('https://www.googletagmanager.com', doFetch as unknown as typeof fetch)(matched('https://www.googletagmanager.com/s/gtag/destination?id=G-1'));
    expect((doFetch.mock.calls[0] as unknown as [string])[0]).toBe('https://www.googletagmanager.com/s/gtag/destination?id=G-1');
  });
});

describe('waitForQuiet', () => {
  function clock() {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => void (now += ms) };
  }

  test('waits one quiet period when no call arrives', async () => {
    const c = clock();
    await waitForQuiet(() => 0, c);
    expect(c.now()).toBe(QUIET_MS);
  });

  test('a call during the wait restarts the quiet period', async () => {
    const c = clock();
    await waitForQuiet(() => (c.now() >= 500 ? 500 : 0), c);
    expect(c.now()).toBe(500 + QUIET_MS);
  });

  test('stops at the maximum while calls keep coming', async () => {
    const c = clock();
    await waitForQuiet(() => c.now(), c);
    expect(c.now()).toBe(MAX_QUIET_WAIT_MS);
  });
});

describe('defaultServerContainerImage', () => {
  test('is the local build on arm64 and Google image elsewhere', () => {
    expect(defaultServerContainerImage('0.5.0', {}, 'arm64')).toBe('tagreeve-sgtm:0.5.0');
    expect(defaultServerContainerImage('0.5.0', {}, 'x64')).toMatch(/^gcr\.io\/cloud-tagging-10302018\/gtm-cloud-image@sha256:[0-9a-f]{64}$/);
  });
});
