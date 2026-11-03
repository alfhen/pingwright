function setUp(block: HTMLElement) {
  const lines = [...block.querySelectorAll<HTMLElement>('.annotated-line')];
  const notes = [...block.querySelectorAll<HTMLElement>('.annotated-note')];

  function show(line: HTMLElement) {
    const part = line.dataset.part;
    for (const other of lines) {
      other.classList.toggle('is-active', other.dataset.part === part);
      other.tabIndex = other === line ? 0 : -1;
    }
    for (const note of notes) note.hidden = note.dataset.part !== part;
  }

  const lineOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('.annotated-line') : null);

  // Not pointerover: Chrome fires it when the page scrolls under a still mouse, which would undo a keyboard move.
  block.addEventListener('pointermove', (event) => {
    const line = lineOf(event.target);
    if (line) show(line);
  });
  block.addEventListener('focusin', (event) => {
    const line = lineOf(event.target);
    if (line) show(line);
  });
  block.addEventListener('keydown', (event) => {
    const index = lines.indexOf(lineOf(event.target)!);
    if (index === -1) return;
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: lines.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    lines[Math.max(0, Math.min(lines.length - 1, next))]!.focus();
  });
}

for (const block of document.querySelectorAll<HTMLElement>('.annotated-summary')) setUp(block);
