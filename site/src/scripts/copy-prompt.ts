/**
 * A copy button names what it copies: `data-copy-from` (an element's text) or `data-copy-text`.
 * After a copy it either writes to the `data-copy-status` element, or swaps its own label for
 * `data-copied-label` for `data-copied-ms`.
 */
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function show(target: HTMLElement, text: string, restore: string, ms: number) {
  target.textContent = text;
  clearTimeout(timers.get(target));
  timers.set(
    target,
    setTimeout(() => (target.textContent = restore), ms),
  );
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy-from], button[data-copy-text]')) {
  const label = button.textContent ?? '';
  button.addEventListener('click', async () => {
    const from = button.dataset.copyFrom && document.getElementById(button.dataset.copyFrom);
    const text = from ? (from.textContent ?? '') : (button.dataset.copyText ?? '');
    const status = button.dataset.copyStatus ? document.getElementById(button.dataset.copyStatus) : null;
    let copied = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      copied = false;
    }
    if (status) {
      show(status, copied ? 'Copied' : 'Copy did not work. Select the prompt below and copy it.', '', 4000);
    } else {
      const done = copied ? (button.dataset.copiedLabel ?? 'Copied') : 'Copy did not work';
      show(button, done, label, Number(button.dataset.copiedMs ?? 2200));
    }
  });
}
