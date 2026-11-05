import { readFileSync } from 'node:fs';
import type { Io } from './run.ts';

export const WEB_TEMPLATE_FILE_NAME = 'tagreeve-tag-reporter.tpl';

// The build copies the template to dist/templates/; sources read it from the recorder package.
const WEB_TEMPLATE_PATHS = [
  new URL(`./templates/${WEB_TEMPLATE_FILE_NAME}`, import.meta.url),
  new URL('../../recorder/src/gtm-templates/web-tag-reporter.tpl', import.meta.url),
];

function readWebTemplate(): string {
  for (const path of WEB_TEMPLATE_PATHS) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      continue;
    }
  }
  throw new Error('The web tag reporter template is missing from this install.');
}

const WEB_STEPS = [
  'In a GTM workspace, import the text in "template" as a custom tag template.',
  'Add one tag of that type with the trigger in "setup.trigger" (a custom event trigger on the event name ".*" with regex matching on) and the consent setting in "setup.consent".',
  'Turn on "Include tag name" with the key "name" in the Additional Tag Metadata of each tag you want named, or list the names in expectedTags.',
  'Never publish the version.',
  'Run Tagreeve with --gtm-override.',
  'Check that tags[<container>].reports in the --json output is greater than 0. An entry with reports 0 and a hint means the install failed.',
];

export function webTemplateJson(): object {
  return {
    templateVersion: 1,
    name: 'web',
    fileName: WEB_TEMPLATE_FILE_NAME,
    template: readWebTemplate(),
    setup: {
      trigger: { type: 'customEvent', eventName: '.*', regex: true },
      consent: 'noAdditionalConsentRequired',
      tagMetadata: { includeTagName: true, key: 'name' },
      publish: false,
    },
    steps: WEB_STEPS,
  };
}

export function templateCommand(io: Io, json: boolean): number {
  io.stdout(json ? `${JSON.stringify(webTemplateJson(), null, 2)}\n` : readWebTemplate());
  return 0;
}
