export type TemplatePermission = {
  id: string;
  keys: string[];
};

export type TemplateSections = {
  sections: Record<string, string>;
  sandboxedJs: string;
  permissions: TemplatePermission[];
};

const MARKER = /^___([A-Z_]+)___[ \t]*$/;

type ParamValue = {
  type?: number;
  string?: string;
  listItem?: ParamValue[];
  mapValue?: ParamValue[];
};
type PermissionEntry = {
  instance: { key: { publicId: string }; param?: { key: string; value: ParamValue }[] };
};

export function readTemplateSections(text: string): TemplateSections {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (current !== null) sections[current] = lines.join('\n').trim();
  };
  for (const line of text.split(/\r?\n/)) {
    const m = MARKER.exec(line);
    if (m) {
      flush();
      current = m[1]!;
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  const sandboxedJs =
    sections['SANDBOXED_JS_FOR_WEB_TEMPLATE'] ?? sections['SANDBOXED_JS_FOR_SERVER'] ?? '';
  const raw = sections['WEB_PERMISSIONS'] ?? sections['SERVER_PERMISSIONS'];
  const entries = raw ? (JSON.parse(raw) as PermissionEntry[]) : [];
  return { sections, sandboxedJs, permissions: entries.map(parsePermission) };
}

function parsePermission(entry: PermissionEntry): TemplatePermission {
  const keys: string[] = [];
  for (const param of entry.instance.param ?? []) {
    for (const item of param.value.listItem ?? []) {
      if (item.string !== undefined) keys.push(item.string);
      else if (item.mapValue?.[0]?.string !== undefined) keys.push(item.mapValue[0].string);
    }
  }
  return { id: entry.instance.key.publicId, keys };
}
