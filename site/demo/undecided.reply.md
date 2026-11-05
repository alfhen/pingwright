## plan

I'll run Tagreeve as a visitor who sees the cookie banner but never answers it, and check what's sent while they're undecided.

## verdict

5 hits before consent

Meta and Google Ads fire while the banner is still open.

## reply

Legal is right. While the banner is still open, two marketing tags already fire: Meta PageView and Google Ads (5 hits, all before any answer).

GA4 behaves: it sends page_view with consent denied, as it should.

Evidence: hit_…NT5X, hit_…8J9D, hit_…8J9H, hit_…DBKY, hit_…DBKZ. Most likely a Meta and an Ads tag on All Pages without a consent check.
