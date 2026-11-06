import vm from 'node:vm';
import type { TemplatePermission } from './tpl.ts';

type Fn = (...args: unknown[]) => unknown;

const API_PERMISSION: Record<string, string> = {
  addEventCallback: 'read_event_metadata',
  callInWindow: 'access_globals',
  copyFromDataLayer: 'read_data_layer',
  getContainerVersion: 'read_container_data',
};

// APIs that need no permission in GTM.
const OPEN_APIS = new Set(['makeString']);

export type SandboxHost = {
  data: Record<string, unknown>;
  dataLayer?: Record<string, unknown>;
  containerVersion?: Record<string, unknown>;
  windowFunctions?: Record<string, Fn>;
};

export type SandboxRun = {
  required: string[];
  callbacks: Fn[];
  windowCalls: { name: string; args: unknown[] }[];
  successCalls: number;
  fireEvent(containerId: string, eventData: unknown): void;
};

export function runSandbox(
  js: string,
  permissions: TemplatePermission[],
  host: SandboxHost,
): SandboxRun {
  const run: SandboxRun = {
    required: [],
    callbacks: [],
    windowCalls: [],
    successCalls: 0,
    fireEvent(containerId, eventData) {
      for (const cb of run.callbacks) cb(containerId, eventData);
    },
  };
  const granted = new Map(permissions.map((p) => [p.id, p]));
  const keysOf = (api: string) => granted.get(API_PERMISSION[api]!)?.keys ?? [];

  const apis: Record<string, Fn> = {
    addEventCallback: (cb) => {
      run.callbacks.push(cb as Fn);
    },
    callInWindow: (name, ...args) => {
      if (!keysOf('callInWindow').includes(name as string)) {
        throw new Error(`callInWindow: no execute permission for ${String(name)}`);
      }
      run.windowCalls.push({ name: name as string, args });
      return host.windowFunctions?.[name as string]?.(...args);
    },
    copyFromDataLayer: (key) => {
      if (!keysOf('copyFromDataLayer').includes(key as string)) {
        throw new Error(`copyFromDataLayer: no permission for ${String(key)}`);
      }
      return host.dataLayer?.[key as string];
    },
    getContainerVersion: () => host.containerVersion ?? {},
    makeString: (value) => (value === null || value === undefined ? '' : String(value)),
  };

  const require = (name: string): Fn => {
    run.required.push(name);
    const api = apis[name];
    if (api && OPEN_APIS.has(name)) return api;
    const permission = API_PERMISSION[name];
    if (!api || !permission || !granted.has(permission)) {
      throw new Error(`require('${name}'): API not granted by the permissions`);
    }
    return api;
  };

  const data = {
    ...host.data,
    gtmOnSuccess: () => {
      run.successCalls += 1;
    },
    gtmOnFailure: () => {},
  };
  const context = vm.createContext({ require, data });
  vm.runInContext(js, context, { timeout: 1000 });
  return run;
}
