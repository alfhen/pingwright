export const README_SCENARIO = `
# scenarios/undecided-visitor.yml
start: /products/{product}
vars:
  product: fake-tee
steps:
  - consent: none          # the banner must appear, and gets no answer
  - wait: 4s
  - visit: /collections/all
expect:
  mustNot:
    - { vendor: [pinterest, meta, tiktok], before: consent }
    - { vendor: ga4, ids.user_id: present, consent.analytics: denied }
  must:
    - { vendor: ga4, event: page_view, consent.analytics: denied, count: ">=2" }
`;
