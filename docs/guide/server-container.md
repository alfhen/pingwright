# Run your server container locally

Tagreeve can run your own server-side Google Tag Manager container on your machine and record the calls it makes to vendors. This guide sets that up. You need a working [first run](./first-run.md), Docker, and a published server container.

The container is opt-in. A run without `--server-container` never looks for Docker.

## Set up

1. Install Docker and start it. If Docker is not running, a run with `--server-container` exits 2 before any browser starts and says `Docker is needed for --server-container`. The build command on arm64 says the same when Docker does not answer.
2. Get the image. Run:

   ```bash
   tagreeve server-container build
   ```

   On amd64 the command prints Google's image reference and builds nothing. Pull that reference with `docker pull`. Without the pull, the first run exits 2 because the image is missing.

   When a `tagreeve-sgtm` image is missing, the message lists the `tagreeve-sgtm` tags that exist on your machine, or says `none`. After an upgrade you see the old tag there and need the new one. `suite --server-container` checks the image once, before any scenario starts, and exits 2 if it is missing.

   On Apple silicon (arm64), Google's image is amd64 only, so the command rebuilds it for arm64 in your own Docker. The image tag holds the Tagreeve version, so run the command again after each Tagreeve upgrade. Tagreeve never pushes an image.
3. Get the container config. In the Google Tag Manager admin, open your server container, then Admin, then Container settings, then "Manually provision tagging server". The page shows a long config string. Copy it. Below, `<container-config>` stands for that string.
4. Save the config to a file that only you can read, in a folder outside any repository. A folder under your home directory works:

   ```bash
   mkdir -p -m 700 ~/.config/tagreeve
   (umask 077; cat > ~/.config/tagreeve/sgtm-config.txt)
   ```

   Paste the config, press Enter, then press Ctrl-D. On macOS, `(umask 077; pbpaste > ~/.config/tagreeve/sgtm-config.txt)` copies it from the clipboard. You can also save it from an editor and run `chmod 600 ~/.config/tagreeve/sgtm-config.txt`.

   Do not put the config in a command line, and do not run `export TAGREEVE_SERVER_CONTAINER_CONFIG=...`. Your shell keeps both in its history. Tagreeve refuses a config file that other users can read. If you use the environment variable `TAGREEVE_SERVER_CONTAINER_CONFIG`, set it from a source that your shell history does not keep.
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
   tagreeve run scenario.yml --site https://test.example.com --network server --server-container --server-container-config ~/.config/tagreeve/sgtm-config.txt
   ```

   Use a test identity and a test copy of your site. The container may pass visitor data to Tagreeve's recording proxy, and the run records it.

## Test an unpublished workspace

The config from step 3 makes the container serve the published version. To test a server workspace that is not published, use a config built from that workspace's preview environment. Both configs are the base64 of one string:

| Config | String before base64 |
| --- | --- |
| Live container | `id=GTM-PWTEST1&env=<env id>&auth=<auth>` |
| Workspace preview | `id=GTM-PWTEST1&env=<env id>&auth=<auth>` |

For the live container, `env` and `auth` come from the "Manually provision tagging server" page. For a workspace, they come from its preview environment, so `<env id>` and `<auth>` differ from the live ones. The preview environment must exist. A quick preview on the workspace in Tag Manager creates it.

The workspace's preview URL, or its share-preview link, holds both values. The `gtm_preview` parameter is `env-<n>`: `<env id>` is the number `<n>`, as in the live string. The `gtm_auth` parameter is `<auth>`. Treat the URL as a secret too.

Build the config without putting `<auth>` in a command line, where your shell keeps it:

1. In an editor, write the plain string from the table into `plain.txt`, in a folder outside any repository. Set its mode to 0600.
2. Encode it into the config file:

   ```bash
   (umask 077; tr -d '\r\n' < plain.txt | base64 > ~/.config/tagreeve/sgtm-workspace-config.txt)
   ```

   The `tr` drops the editor's final newline, which would otherwise become part of the auth value. On Linux, use `base64 -w0` so the output is one line.
3. Delete `plain.txt`.

Pass the config file with `--server-container-config`, as in step 6. Keep it as secret as in step 4: mode 0600, outside any repository. Tagreeve gives the config to the container as it is, so the run serves the workspace build.

## What happens in a run

Requests from the browser to a host in `serverHosts` go to the local container instead of your live one. Loads are not sent to it: scripts such as `gtm.js`, stylesheets, fonts and pages from those hosts use the network. The container sends its own calls to vendors, for example GA4, Google Ads or the Meta Conversions API. Tagreeve's proxy records each call and answers it as `stub` mode would. The call is not sent on.

The run waits up to 5 seconds after the last step for late calls.

## What leaves your machine

The container downloads its configuration from Google, as it always does. Tagreeve forwards three kinds of request to `www.googletagmanager.com` for this, and nothing else:

- `GET` or `HEAD` for paths that start with `/static/serverjs/`
- `GET` or `HEAD` for `/server.js`
- `GET` or `HEAD` for `/s/gtag/destination`

Nothing else leaves the machine from the container. The browser's hits are stubbed as in any other run. Requests to a host in `serverHosts` go to the local container and stay on your machine, except loads: scripts such as `gtm.js`, stylesheets, fonts and pages from those hosts use the network. As in any stub run, the site's own requests and requests that are not tracking hits also use the network.

## Read the results

The summary has a `Server container` line. It shows whether the image started, how many vendor calls the container made, how many link to a browser hit, and how many requests were forwarded to Google. For example:

```text
Server container: image ok; 7 vendor calls, 5 linked exactly, 1 probable, 1 unlinked; 3 requests forwarded to Google
```

The report gives each server vendor its own row, for example `Google Ads (google-ads), sent by the server container`. Each call in a row is placed in the consent epoch of the browser hit it is linked to, so one row can span several epochs. Calls with no link are in an unlinked column after the last epoch. Notes on a result tell you how far to trust that link:

- `serverSendProbableLink`: the call was linked to a browser hit by a value both hold, such as a client ID, and not proven. A probable link can warn but cannot fail a run. A client ID link is exact only when the call has the same client ID and event name as one browser hit whose request to the container was still waiting for its answer. That needs a container that answers after its tags send. If an earlier browser hit with the same client ID and event name was sent before the call, answered or not, the link stays probable. A container that answers first never gives an exact link.
- `serverSendUnlinked`: no browser hit was found for the call. A check that depends on consent cannot judge it, so that check warns.

A rule that should judge only the browser, or only the container, takes `sentBy: browser` or `sentBy: server`. A browser-only `mustNot` on a Google host then ignores the container's own calls. See [Rules by sender](../cli.md#rules-by-sender).

With `--json`, the same counts are in the `serverContainer` field. If the container fails to start or stops during the run, the record is still written and the run exits with code 2. See the [CLI reference](../cli.md) for the details, and [Reading a run's results](./reading-results.md) for the rest of the summary.

## What it does not show

- Stape-only hosting features: the custom loader and its domain features, Cookie Keeper, the geo and bot headers Stape adds in front of the container, store ID headers, request logs and the CDN. A cookie that Cookie Keeper would set, or a header a tag reads from the hosting layer, is missing.
- Unpublished workspaces with the live config. The container loads the published version. For a workspace, use a config from its preview environment (see "Test an unpublished workspace").
- Sends from `pagehide` or `visibilitychange`. The page gets the answer, also for a `serverHosts` host, so the container never receives the hit and makes no vendor call for it.
- Calls to a host that no decoder knows. They are recorded and flagged as unknown destinations.

Tags that Stape ships as templates, such as the Data Client and the Facebook client, are part of your container and do run. The calls of template tags such as Meta Conversions API, Pinterest and Criteo are not yet proven to reach the proxy.

A suite with `--server-container` starts one container for each run, so it is slow.

## Keep the config secret

The config lets anyone run your container. Treat it like a password. Keep it out of:

- the repository, including scenario files and fixtures (keep the config file outside it, for example under `~/.config/tagreeve/`)
- issues, pull requests and chat messages
- CI logs and command lines in shared logs
- screenshots

Tagreeve does not print the config and does not write it to a record or a log line. Delete the file when you no longer need it.

If a crash leaves a container or network behind, the next run removes the ones whose owner process is gone. Objects that carry another host's label, for example on a shared remote Docker, you remove by hand with `docker rm` and `docker network rm`. They are named `tagreeve-sgtm-*` and carry the labels `tagreeve.owner.pid` and `tagreeve.owner.host`.
