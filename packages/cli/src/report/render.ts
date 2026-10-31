import type { ExpectationView, Mark, ReportModel, Segment } from './model.ts';

export const CSP = "default-src 'none'; style-src 'unsafe-inline'";

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const MARK_NAME: Record<Mark, string> = {
  full: 'full',
  ping: 'ping',
  nothing: 'nothing',
  leak: 'leak',
  unchecked: 'unchecked',
  mixed: 'mixed',
};

const LEGEND: Record<Mark, string> = {
  full: 'hits sent with every known signal granted, or before an answer',
  ping: 'hit sent while denied, no identifiers recorded',
  nothing: 'no hit',
  leak: 'identifier names sent while their signal was denied, or named by a failed consent-scoped mustNot',
  unchecked: 'denied, but the body was not fully recorded, so the hit cannot be called clean',
  mixed: 'some signals denied, or granted and denied hits in one segment',
};

const GLYPHS: Record<Mark, string> = {
  full: '<circle cx="7" cy="7" r="5.5" fill="currentColor"/>',
  ping: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/>',
  nothing: '<line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="2"/>',
  leak: '<polygon points="7,1 13,13 1,13" fill="currentColor"/>',
  unchecked: '<polygon points="7,1 13,7 7,13 1,7" fill="none" stroke="currentColor" stroke-width="2"/>',
  mixed: '<path d="M7 1.5a5.5 5.5 0 0 0 0 11z" fill="currentColor"/><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
};

function glyph(mark: Mark): string {
  return `<svg class="glyph" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">${GLYPHS[mark]}</svg>`;
}

function segmentCell(segment: Segment): string {
  const label = segment.label ? `<span class="why">${escapeHtml(segment.label)}</span>` : '';
  const count = segment.hits ? `<span class="count">${segment.hits} hit${segment.hits === 1 ? '' : 's'}</span>` : '';
  return `<td class="m-${segment.mark}">${glyph(segment.mark)}<span class="name">${MARK_NAME[segment.mark]}</span>${count}${label}</td>`;
}

export function timeline(model: ReportModel): string {
  if (model.rows.length === 0) return '<p class="empty">No vendor hits were recorded.</p>';
  const head = model.columns.map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`).join('');
  const body = model.rows
    .map((row) => `<tr><th scope="row">${escapeHtml(row.vendor)}</th>${row.segments.map(segmentCell).join('')}</tr>`)
    .join('');
  const legend = (Object.keys(LEGEND) as Mark[])
    .map((m) => `<li class="m-${m}">${glyph(m)}<strong>${m}</strong> ${escapeHtml(LEGEND[m])}</li>`)
    .join('');
  return `<div class="scroll"><table class="timeline"><thead><tr><th scope="col">Vendor</th>${head}</tr></thead><tbody>${body}</tbody></table></div><ul class="legend">${legend}</ul>`;
}

function expectation(e: ExpectationView): string {
  const status = e.status.toLowerCase().replace(' ', '-');
  const evidence = e.evidenceCount
    ? `<span class="evidence">evidence: ${e.evidence.map(escapeHtml).join(', ')}${e.evidenceCount > e.evidence.length ? ` and ${e.evidenceCount - e.evidence.length} more` : ''} (${e.evidenceCount})</span>`
    : '';
  const note = e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : '';
  const severity = `<span class="severity">severity: ${escapeHtml(e.severity)}</span>`;
  return `<li class="s-${status}"><span class="status">${escapeHtml(e.status)}</span><code>${escapeHtml(e.text)}</code>${severity}${note}${evidence}</li>`;
}

export function expectations(model: ReportModel): string {
  if (model.expectations.length === 0) return '<p class="empty">The scenario has no expectations.</p>';
  return `<ul class="results">${model.expectations.map(expectation).join('')}</ul>`;
}

export function flags(model: ReportModel): string {
  if (model.flags.length === 0) return '<p class="empty">No flags.</p>';
  const rows = model.flags
    .map((f) => `<tr><td>${escapeHtml(f.kind)}</td><td>${f.count}</td><td>${f.hosts.map(escapeHtml).join(', ')}</td></tr>`)
    .join('');
  return `<div class="scroll"><table><thead><tr><th scope="col">Kind</th><th scope="col">Count</th><th scope="col">Hosts</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function fields(model: ReportModel): string {
  if (!model.fields) return `<p class="empty">not recorded (record schema version ${model.header.schemaVersion})</p>`;
  if (model.fields.length === 0) return '<p class="empty">No hit was sent while a signal was denied.</p>';
  const items = model.fields
    .map((v) => `<li><strong>${escapeHtml(v.vendor)}</strong> ${v.names.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</li>`)
    .join('');
  return `<ul class="fields">${items}</ul>`;
}

export const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--card:#f6f8fa;--full:#1a7f37;--ping:#9a6700;--nothing:#6e7781;--leak:#cf222e;--unchecked:#8250df;--mixed:#bc4c00}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d;--card:#161b22;--full:#3fb950;--ping:#d29922;--nothing:#8b949e;--leak:#ff7b72;--unchecked:#d2a8ff;--mixed:#ffa657}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1.15rem;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
dl.header{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;margin:12px 0;color:var(--muted)}
dl.header dd{margin:0;color:var(--fg);overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
thead th{background:var(--card)}
td .name{font-weight:600;margin-left:6px}
td .count,td .why{display:block;color:var(--muted);font-size:.85rem}
.glyph{vertical-align:-2px}
.m-full{color:var(--full)}.m-ping{color:var(--ping)}.m-nothing{color:var(--nothing)}.m-leak{color:var(--leak)}.m-unchecked{color:var(--unchecked)}.m-mixed{color:var(--mixed)}
.legend{list-style:none;padding:0;margin:12px 0;display:grid;gap:4px;font-size:.9rem}
.legend strong{margin:0 4px}
.legend li{color:var(--fg)}
.legend .glyph{color:inherit}
.results,.fields{list-style:none;padding:0;margin:0;display:grid;gap:8px}
.results li,.fields li{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;overflow-wrap:anywhere}
.results .status{font-weight:700;margin-right:8px}
.s-pass .status{color:var(--full)}.s-warn .status{color:var(--ping)}.s-fail .status{color:var(--leak)}.s-cannot-evaluate .status{color:var(--unchecked)}
.results .note,.results .evidence,.results .severity{display:block;color:var(--muted);font-size:.85rem}
code{font:13px ui-monospace,monospace}
.empty{color:var(--muted)}
.caveat{color:var(--muted);font-size:.85rem;margin-top:32px}
.warn-box{color:var(--ping);border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--card);margin:8px 0}
h3{font-size:1rem;margin:20px 0 6px}
h4{font-size:.95rem;margin:16px 0 6px;color:var(--muted)}
`;

export function definitionList(pairs: [string, string][]): string {
  return `<dl class="header">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;
}

export function runHeader(h: ReportModel['header']): [string, string][] {
  const header: [string, string][] = [
    ['Run', h.runId],
    ['Started', h.startedAt],
    ['Network mode', h.networkMode],
    ['Site host', h.host],
    ['Pingwright', h.pingwrightVersion],
    ['Record schema', String(h.schemaVersion)],
  ];
  if (h.variant) header.splice(1, 0, ['Variant', h.variant]);
  return header;
}

export function runSections(model: ReportModel, level: 'h2' | 'h4'): string {
  return `<${level}>Timeline per vendor</${level}>
${timeline(model)}
<${level}>Expectations</${level}>
${expectations(model)}
<${level}>Flags</${level}>
${flags(model)}
<${level}>Fields seen while a signal was denied</${level}>
${fields(model)}`;
}

export function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pingwright report</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
<p class="caveat">Names and counts only. A mark describes what Pingwright recorded. It is not a statement of legal compliance.</p>
</main>
</body>
</html>
`;
}

export function renderReport(model: ReportModel): string {
  return page(`<h1>${escapeHtml(model.header.scenario)}</h1>
${definitionList(runHeader(model.header))}
${runSections(model, 'h2')}`);
}
