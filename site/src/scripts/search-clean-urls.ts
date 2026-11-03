import { cleanUrl, isSiteUrl } from '../lib/clean-urls.ts';

// Pagefind indexes the built files, so its results link to /docs/cli.html. The UI re-renders and can reuse a link, hence the href filter.
const results = document.getElementById('starlight__search');
const clean = () => {
  for (const link of results?.querySelectorAll('a[href]') ?? []) {
    const href = link.getAttribute('href')!;
    if (isSiteUrl(href) && cleanUrl(href) !== href) link.setAttribute('href', cleanUrl(href));
  }
};
if (results) new MutationObserver(clean).observe(results, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
