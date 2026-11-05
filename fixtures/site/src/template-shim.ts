import { readFileSync } from 'node:fs';
import { readTemplateSections } from '../../../packages/recorder/src/gtm-templates/tpl.ts';

const templatePath = new URL('../../../packages/recorder/src/gtm-templates/web-tag-reporter.tpl', import.meta.url);

export interface FixtureTag {
  id: string;
  status: string;
  executionTime: number;
  /** Absent for a tag whose Additional Tag Metadata does not include its name. */
  name?: string;
}

export interface ShimConfig {
  container: string;
  version: string;
  tags: FixtureTag[];
  /** Receives a copy of each `callInWindow` argument, so the fixture has its own log to compare the record with. */
  logUrl: string;
}

// The browser stand-ins for the sandboxed APIs the shipped template requires. Each one is granted only what the
// template's permissions list, as GTM does, so a template that asks for more than it declares fails here too.
const API_PERMISSION = {
  addEventCallback: 'read_event_metadata',
  callInWindow: 'access_globals',
  copyFromDataLayer: 'read_data_layer',
  getContainerVersion: 'read_container_data',
};

/** JavaScript that adds `pwContainer.reportTags(events)`. It runs the shipped template's sandboxed code once per event. */
export function templateShim(config: ShimConfig): string {
  const { sandboxedJs, permissions } = readTemplateSections(readFileSync(templatePath, 'utf8'));
  const granted = Object.fromEntries(permissions.map((p) => [p.id, p.keys]));
  const setup = { ...config, templateJs: sandboxedJs, granted, apiPermission: API_PERMISSION };
  return `(function () {
  var cfg = ${JSON.stringify(setup)};
  var uniqueId = 0;
  function allowed(api, key) {
    var keys = cfg.granted[cfg.apiPermission[api]];
    if (!keys) throw new Error(api + ' is not granted by the template permissions');
    if (key !== undefined && keys.indexOf(key) < 0) throw new Error(api + ' has no permission for ' + key);
  }
  function runTag(eventName) {
    var callbacks = [];
    uniqueId += 1;
    var dataLayerValues = { event: eventName, 'gtm.uniqueEventId': uniqueId };
    var apis = {
      addEventCallback: function (callback) {
        callbacks.push(callback);
      },
      callInWindow: function (name) {
        allowed('callInWindow', name);
        var args = Array.prototype.slice.call(arguments, 1);
        try {
          fetch(cfg.logUrl, { method: 'POST', mode: 'no-cors', body: JSON.stringify(args[0]) }).catch(function () {});
        } catch (e) {}
        var fn = window[name];
        return typeof fn === 'function' ? fn.apply(window, args) : undefined;
      },
      copyFromDataLayer: function (key) {
        allowed('copyFromDataLayer', key);
        return dataLayerValues[key];
      },
      getContainerVersion: function () {
        return { version: cfg.version };
      }
    };
    var require = function (name) {
      allowed(name);
      return apis[name];
    };
    var data = { nameKey: 'name', gtmOnSuccess: function () {}, gtmOnFailure: function () {} };
    new Function('require', 'data', cfg.templateJs)(require, data);
    // GTM calls the callback after the event's tags have run.
    setTimeout(function () {
      var tags = cfg.tags.map(function (tag) {
        return { id: tag.id, status: tag.status, executionTime: tag.executionTime, name: tag.name };
      });
      callbacks.forEach(function (callback) {
        callback(cfg.container, { tags: tags });
      });
    }, 20);
  }
  window.pwContainer.reportTags = function (events) {
    (events || ['gtm.js', 'container_event']).forEach(runTag);
  };
})();`;
}
