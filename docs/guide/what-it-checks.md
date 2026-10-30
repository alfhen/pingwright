# What Pingwright checks

A website often sends data to other companies. For example, it tells Google Analytics that a visitor opened a page. These messages are tracking requests. Each tracking request goes to a vendor, such as Google or Meta.

Visitors can say no to some tracking. A cookie banner asks them. The answer is the visitor's consent. A site must not send some requests until the visitor says yes.

A tracking setup can break and show no error. A small change can make a vendor receive data it should not get. Pingwright plays a visitor in a real browser, records every tracking request, and checks them against your expectations. An expectation is a rule about which requests the site may send, and when.

## The idea

```mermaid
flowchart TB
  scenario["Scenario"] --> browser["Pingwright plays<br/>the visitor in Chromium"]
  site["Your site"] <--> browser
  browser --> record["Record of every<br/>tracking request"]
  record --> check["Check against<br/>your expectations"]
  check --> result["Pass or fail,<br/>with evidence"]
```

Pingwright plays a scenario in a browser, records the tracking requests, checks them against your expectations and reports pass or fail.

A scenario is a short YAML file. It lists what the visitor does and what you expect. [Your first run](./first-run.md) shows one.

## Tracking requests

Pingwright reads each tracking request and turns it into a hit. A hit has the vendor, the event and the consent values the request carries. An event is the action the site reports, such as `page_view`. Pingwright decodes hits for GA4, Google Ads, Meta, Pinterest and Stape. It also recognises a short list of other trackers.

## Consent states

The visitor's consent changes over time. Pingwright calls each period an epoch. A period starts when the consent state changes.

```mermaid
flowchart TB
  u["Undecided<br/>banner shown, no answer"] -->|visitor accepts| g["Granted"]
  u -->|visitor rejects| d["Denied"]
  g -->|visitor withdraws| w["Denied again<br/>label: withdrawn"]
```

Every visitor starts undecided, then accepts or rejects. An accepting visitor can withdraw later.

You write expectations per state. For example: "Meta must send nothing while the visitor is undecided." Pingwright checks each hit against the epoch it falls in. Google hits carry their own consent values, so Pingwright reads those values instead.

[Reading a run's results](./reading-results.md) shows how epochs appear in the output.

## Stub mode

By default, a run is in stub mode. In stub mode, Pingwright records each known tracking request and then answers it itself. Your test visits do not add fake traffic to real reports.

```mermaid
flowchart TB
  page["Site in the browser"] -->|tracking request| pw["Pingwright"]
  pw -->|"answers itself<br/>(stub)"| page
  pw -.->|"not sent"| vendor["Vendor"]
```

In stub mode, Pingwright records a known tracking request and answers it itself, so the vendor does not get it.

Scripts and pages still load. For example, the Google tag script and the Meta pixel script come from the vendor as usual. Only the tracking requests are answered locally.

A few rare requests can still get through. One example is a request that a sandboxed iframe sends while it is still loading. The [design](../design.md#_5-3-network-modes) lists these cases.

Pingwright sends a request it does not know on to its host. It flags that request as an unknown destination, and the run fails unless you allow it. Live mode (`--network live`) sends every request on. Use live mode only when you want test hits to reach a real vendor account.

## Fake identity

A scenario can fill forms, for example at checkout. Pingwright never uses a real person's data. It makes a fake identity for each run: a name, an email address and a phone number that belong to no one.

Because Pingwright knows what it typed, it can check what the site sends. Many sites turn an email address into a hash before they send it. A hash is a fixed code made from the address. The same address always gives the same hash. Pingwright can compute the hash of the fake email address, so it can tell if the site sent another value. If the record file holds an email address or phone number that is not the fake one, Pingwright reports it as possible real data.

Pingwright never automates a payment or a log-in on a site on the internet. Those are handoff steps. A person does them in a visible window while Pingwright keeps recording.

## Go deeper

- [Your first run](./first-run.md) installs Pingwright and runs a scenario.
- [Reading a run's results](./reading-results.md) explains the output.
- [The design](../design.md) has every detail, including how Pingwright captures requests from sandboxed iframes.
