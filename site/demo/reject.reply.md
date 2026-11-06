## plan

I'll run Tagreeve as a visitor who rejects the cookie banner, then browses on. Stub mode, so no real hits reach Meta.

## verdict

Meta ignores "Reject"

2 hits before the answer, and 2 more after the visitor said no.

## reply

Found it. Two problems on staging:

1. Meta and Google Ads fire before the visitor answers the banner (2 hits). That's what Legal is hearing about.
2. After the visitor clicks Reject, Meta still sends PageView and AddToCart.

No identifiers leak, and the fake visitor's data is clean. Evidence: hit_…CT6W, hit_…SSGW, hit_…FDNE, hit_…FDNH.
