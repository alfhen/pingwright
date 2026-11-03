# Run your server container locally

Tagreeve can run your own server-side Google Tag Manager container on your machine and record the calls it makes to vendors. This guide sets that up. You need a working [first run](./first-run.md), Docker, and a published server container.

The container is opt-in. A run without `--server-container` never looks for Docker.

## Set up

1. Install Docker and start it. If Docker is not running, a run with `--server-container` exits 2 before any browser starts and says `Docker is needed for --server-container`.
2. On Apple silicon (arm64), build the image once:

   ```bash
   tagreeve server-container build
   ```

   Google's image is amd64 only, so Tagreeve rebuilds it for arm64 in your own Docker. It never pushes an image. On amd64 the command prints the Google image to pull and no build is needed.
3. Get the container config. In the Google Tag Manager admin, open your server container, then Admin, then Container settings, then "Manually provision tagging server". The page shows a long config string. Copy it. Below, `<container-config>` stands for that string.
4. Save the config to a file that only you can read:

   ```bash
   umask 077
   printf '%s' '<container-config>' > sgtm-config.txt
   chmod 600 sgtm-config.txt
   ```

   Tagreeve refuses a config file that other users can read. You can also put the config in the environment variable `TAGREEVE_SERVER_CONTAINER_CONFIG`.
5. In the scenario, use server mode and name your container's domain in `serverHosts`:

   ```yaml
   start: /
   options:
     network: server
     serverHosts: [sgtm.example.com]
   steps:
     - consent: reject
     - wait: 4s
   ```

6. Run it:

   ```bash
   tagreeve run scenario.yml --site https://test.example.com --network server --server-container --server-container-config sgtm-config.txt
   ```

   Use a test identity and a test copy of your site. The container may pass visitor data to Tagreeve's recording proxy, and the run records it.

## What happens in a run

Requests from the browser to a host in `serverHosts` go to the local container instead of your live one. Loads of scripts, such as `gtm.js`, are not sent to it. The container sends its own calls to vendors, for example GA4, Google Ads or the Meta Conversions API. Tagreeve's proxy records each call and answers it as `stub` mode would. The call is not sent on.

The run waits up to 5 seconds after the last step for late calls.

## What leaves your machine

The container downloads its configuration from Google, as it always does. Tagreeve forwards three kinds of request to `www.googletagmanager.com` for this, and nothing else:

- `GET` or `HEAD` for paths that start with `/static/serverjs/`
- `GET` or `HEAD` for `/server.js`
- `GET` or `HEAD` for `/s/gtag/destination`

Nothing else leaves the machine from the container. The browser's hits are stubbed as in any other run, except for the hosts you named in `serverHosts`.

## Read the results

The summary has a `Server container` line. It shows whether the image started, how many vendor calls the container made, how many link to a browser hit, and how many requests were forwarded to Google. For example:

```text
Server container: image ok; 7 vendor calls, 5 linked exactly, 1 probable, 1 unlinked; 3 requests forwarded to Google
```

The report shows each vendor call as its own row, for example `Google Ads conversion, sent by the server container`. The row sits in the consent period of the browser hit that led to it. Notes on a result tell you how far to trust that link:

- `serverSendProbableLink`: the call was linked to a browser hit by a value both hold, such as a client ID, and not by an event ID. A probable link can warn but cannot fail a run.
- `serverSendUnlinked`: no browser hit was found for the call. A check that depends on consent cannot judge it, so that check warns.

With `--json`, the same counts are in the `serverContainer` field. If the container fails to start or stops during the run, the record is still written and the run exits with code 2. See the [CLI reference](../cli.md) for the details, and [Reading a run's results](./reading-results.md) for the rest of the summary.

## What it does not show

- Stape-only hosting features: the custom loader and its domain features, Cookie Keeper, the geo and bot headers Stape adds in front of the container, store ID headers, request logs and the CDN. A cookie that Cookie Keeper would set, or a header a tag reads from the hosting layer, is missing.
- Unpublished workspaces. The container loads the published version.
- Calls to a host that no decoder knows. They are recorded and flagged as unknown destinations.

Tags that Stape ships as templates, such as the Data Client and the Facebook client, are part of your container and do run. The calls of template tags such as Meta Conversions API, Pinterest and Criteo are not yet proven to reach the proxy.

A suite with `--server-container` starts one container for each run, so it is slow.

## Keep the config secret

The config lets anyone run your container. Treat it like a password. Keep it out of:

- the repository, including scenario files and fixtures
- issues, pull requests and chat messages
- CI logs and command lines in shared logs
- screenshots

Tagreeve does not print the config and does not write it to a record or a log line. Delete the file when you no longer need it.

If a crash leaves a container or network behind, the next run removes the ones whose owner process is gone. Objects that carry another host's label, for example on a shared remote Docker, you remove by hand with `docker rm` and `docker network rm`. They are named `tagreeve-sgtm-*` and carry the labels `tagreeve.owner.pid` and `tagreeve.owner.host`.
