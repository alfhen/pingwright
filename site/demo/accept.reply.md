## plan

I'll run Tagreeve as a visitor who accepts the cookie banner, to see what fires before and after the answer.

## verdict

Accept works. Waiting doesn't

Everything fires after Accept, but Meta and Ads jump the gun before it.

## reply

After Accept, everything works: GA4, Meta AddToCart and the Ads add_to_cart all fire as expected.

The problem is before the answer: Meta and Google Ads send hits while the banner is still open (2 hits). That explains Legal's complaints.

Evidence: hit_…RMGR, hit_…PXVA.
