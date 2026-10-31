export const UNLOAD_BINDING = '__pingwrightUnloadSend';
export const UNLOAD_FLUSH = '__pingwrightFlushUnload';

export interface UnloadSendPayload {
  key: string;
  method: string;
  url: string;
  resourceType: 'ping' | 'fetch';
  postData: string | null;
  headers?: Record<string, string>;
  frameUrl: string;
  queuedAt: number;
}

/**
 * Stub and server mode (not live). Unload-time sends to serverHosts are answered here too, so they set no cookies. Chromium neither routes nor reports requests a page sends from pagehide or
 * visibilitychange, and binding calls made from those handlers are lost. While the page is hidden or
 * unloading, sendBeacon and keepalive fetch are answered in the page. Each one is queued in
 * sessionStorage until the binding call is acknowledged, and the next document in the tab replays the queue.
 * A send is not recorded if the tab never loads another document of the same origin and is not flushed by close().
 * A frame without sessionStorage (a sandboxed one without allow-same-origin) cannot queue, so its sends are lost:
 * swallowed, and not recorded.
 */
export const unloadInitScript = `(() => {
  const binding = ${JSON.stringify(UNLOAD_BINDING)};
  const STORE = '__pingwrightUnloadQueue';
  let leaving = false;
  const isLeaving = () => leaving || document.visibilityState === 'hidden';
  addEventListener('pagehide', () => { leaving = true; }, true);
  addEventListener('beforeunload', () => { leaving = true; }, true);
  addEventListener('pageshow', () => { leaving = false; }, true);
  const load = () => {
    try { return JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch { return []; }
  };
  const save = (queue) => {
    try { sessionStorage.setItem(STORE, JSON.stringify(queue)); } catch {}
  };
  const deliver = (entry) => {
    const send = window[binding];
    if (typeof send !== 'function') return;
    send(entry).then(() => save(load().filter((e) => e.key !== entry.key)), () => {});
  };
  window.${UNLOAD_FLUSH} = () => { for (const entry of load()) deliver(entry); };
  const serialise = (body) => {
    if (typeof body === 'string') return { postData: body, headers: {} };
    if (body == null) return { postData: null, headers: {} };
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const boundary = '----pingwright' + Math.random().toString(36).slice(2);
      let text = '';
      for (const [name, value] of body) {
        const file = typeof value === 'string' ? null : value;
        text += '--' + boundary + '\\r\\nContent-Disposition: form-data; name="' + name + '"' +
          (file ? '; filename="' + file.name + '"\\r\\nContent-Type: ' + (file.type || 'application/octet-stream') : '') +
          '\\r\\n\\r\\n' + (file ? '[file]' : value) + '\\r\\n';
      }
      return { postData: text + '--' + boundary + '--\\r\\n', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary } };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return { postData: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } };
    }
    return { postData: '[non-text body]', headers: {} };
  };
  const enqueue = (method, url, resourceType, body, contentType) => {
    const { postData, headers } = serialise(body);
    if (contentType && !(typeof FormData !== 'undefined' && body instanceof FormData)) headers['content-type'] = contentType;
    const entry = {
      key: Math.random().toString(36).slice(2) + Date.now().toString(36),
      method,
      url: new URL(String(url), location.href).href,
      resourceType,
      postData,
      headers,
      frameUrl: location.href,
      queuedAt: Date.now(),
    };
    save([...load(), entry]);
    deliver(entry);
  };
  const beacon = navigator.sendBeacon;
  navigator.sendBeacon = function (url, data) {
    if (!isLeaving()) return beacon.call(this, url, data);
    enqueue('POST', url, 'ping', data, null);
    return true;
  };
  // A Request body is a stream that cannot be read synchronously while the page unloads, so the constructor keeps the source body.
  const requestBodies = new WeakMap();
  const NativeRequest = window.Request;
  window.Request = new Proxy(NativeRequest, {
    construct(target, args, newTarget) {
      const request = Reflect.construct(target, args, newTarget);
      const init = args[1];
      const body = init && init.body != null ? init.body : args[0] instanceof NativeRequest ? requestBodies.get(args[0]) : undefined;
      if (body !== undefined) requestBodies.set(request, body);
      return request;
    },
  });
  const nativeClone = NativeRequest.prototype.clone;
  NativeRequest.prototype.clone = function () {
    const copy = nativeClone.call(this);
    if (requestBodies.has(this)) requestBodies.set(copy, requestBodies.get(this));
    return copy;
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const keepalive = (init && init.keepalive) || (input instanceof Request && input.keepalive);
    if (!keepalive || !isLeaving()) return nativeFetch.apply(this, arguments);
    const url = input instanceof Request ? input.url : input;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    let contentType = null;
    try { contentType = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined)).get('content-type'); } catch {}
    const body = init && init.body != null ? init.body : input instanceof Request ? requestBodies.get(input) ?? (input.body ? input.body : null) : null;
    enqueue(method.toUpperCase(), url, 'fetch', body, contentType);
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  window.${UNLOAD_FLUSH}();
})();`;
