export type Theme = 'dark' | 'light';

/** Starlight's own key, so the home page and the docs share one choice. */
export const THEME_KEY = 'starlight-theme';

/** Dark is the default. Starlight stores '' for "auto", which also means dark here. */
export const parseTheme = (stored: string | null | undefined): Theme => (stored === 'light' ? 'light' : 'dark');

/**
 * Runs inline in <head> before the first paint, so the page never shows the wrong theme.
 * It defines StarlightThemeProvider because Starlight's scripts call it.
 */
export const themeInitScript = `(() => {
  let stored = null;
  try { stored = localStorage.getItem(${JSON.stringify(THEME_KEY)}); } catch {}
  document.documentElement.dataset.theme = stored === 'light' ? 'light' : 'dark';
  window.StarlightThemeProvider = { updatePickers() {} };
})();`;
