import { h } from 'vue';
import DefaultTheme from 'vitepress/theme-without-fonts';
import './brand.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'doc-footer-before': () =>
        h('p', { class: 'docs-version' }, 'Docs for main. To read the docs of a release, open the repo at its tag.'),
    }),
};
