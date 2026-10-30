import { defineAsyncComponent, h } from 'vue';
import DefaultTheme from 'vitepress/theme-without-fonts';
import '@fontsource/jost/latin-500.css';
import '@fontsource/jost/latin-600.css';
import './brand.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-footer-before': () =>
        h('p', { class: 'docs-version' }, 'Docs for main. To read the docs of a release, open the repo at its tag.'),
    }),
  enhanceApp({ app }: { app: { component: (name: string, component: unknown) => void } }) {
    app.component('Mermaid', defineAsyncComponent(() => import('./Mermaid.vue')));
  },
};
