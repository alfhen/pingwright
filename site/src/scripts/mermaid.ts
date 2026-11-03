import type { MermaidConfig } from 'mermaid';

const diagrams = [...document.querySelectorAll<HTMLElement>('.mermaid-diagram[data-code]')];
const fontFamily = "'Geist', ui-sans-serif, system-ui, sans-serif";

const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

/** Mermaid's colour maths reads hex and rgb only, and the tokens use oklch. */
function toHex(color: string): string {
  if (!canvas) return color;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`;
}

function themeVariables(): MermaidConfig['themeVariables'] {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => toHex(css.getPropertyValue(name).trim());
  return {
    background: token('--panel'),
    primaryColor: token('--bg2'),
    primaryTextColor: token('--ink'),
    primaryBorderColor: token('--mint'),
    secondaryColor: token('--panel'),
    tertiaryColor: token('--panel'),
    lineColor: token('--mint'),
    textColor: token('--ink'),
    mainBkg: token('--bg2'),
    nodeBorder: token('--mint'),
    clusterBkg: token('--panel'),
    clusterBorder: token('--line'),
    edgeLabelBackground: token('--panel'),
    noteBkgColor: token('--panel'),
    noteTextColor: token('--ink'),
    noteBorderColor: token('--line'),
    fontFamily,
  };
}

let renders = 0;

async function draw() {
  const run = ++renders;
  // Only pages with a diagram load the mermaid package.
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: themeVariables(),
    fontFamily,
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'linear' },
    timeline: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });
  for (const [index, diagram] of diagrams.entries()) {
    const source = decodeURIComponent(diagram.dataset.code ?? '');
    try {
      const { svg } = await mermaid.render(`mermaid-${run}-${index}`, source);
      if (run !== renders) return;
      const box = document.createElement('div');
      box.className = 'mermaid-svg';
      box.innerHTML = svg;
      diagram.replaceChildren(box);
    } catch {
      if (!diagram.querySelector('.mermaid-error')) {
        const error = document.createElement('p');
        error.className = 'mermaid-error';
        error.textContent = 'The diagram could not be drawn. Its source is shown instead.';
        diagram.append(error);
      }
    }
  }
}

if (diagrams.length) {
  void draw();
  new MutationObserver(() => void draw()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
