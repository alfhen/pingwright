import { parseTheme, THEME_KEY } from '../lib/theme.ts';

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
  button.addEventListener('click', () => {
    const next = parseTheme(document.documentElement.dataset.theme) === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Without storage the choice lasts until the next page load.
    }
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-menu-toggle]')) {
  const menu = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (!menu) continue;
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? '✕' : '☰';
    menu.hidden = !open;
  });
}
