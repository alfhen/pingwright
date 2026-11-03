# Project layout

Tagreeve does not make you use a folder layout. These are the folders to use if you want runs to be easy to find and safe to commit. Tagreeve does not create them for you in this release.

```text
your-repo/
  .gitignore                    # holds /tagreeve/runs/
  tagreeve/
    scenarios/                  # committed
      checkout.yml
      server/                   # not run by suite
        server-checkout.yml
    baselines/                  # committed
      checkout.json
    runs/                       # ignored
      2026-11-03-ca-307-live/
```

## What to commit

- `tagreeve/scenarios/` holds your scenario files. Commit them.
- `tagreeve/baselines/` holds the files from `tagreeve baseline save`. Commit them, so a review shows when the expected behaviour changes.
- `tagreeve/runs/` holds records, reports and suite folders. A record has the pages you visited and the requests they made, so do not commit it. Add this line to `.gitignore`:

```text
/tagreeve/runs/
```

## What stays outside the repo

A GTM override file holds the `gtmAuth` value of a workspace. A server container config is a secret too. Keep both files outside the repo, for example in your home folder, and give them mode 0600:

```bash
chmod 600 ~/secrets/workspace-override.json
```

Tagreeve never prints either value or writes it to a record.

## Where runs go

The default for `--out` is still `runs` in this release. Write the folder out on every command, so records land in the ignored folder:

```bash
tagreeve run tagreeve/scenarios/checkout.yml --site https://staging.example.com \
  --out tagreeve/runs/2026-11-03-ca-307-live
```

## Naming a run folder

Use `<date>-<ticket or topic>-<target>`. The date is the day of the run. The target says what was tested:

- `2026-11-03-ca-307-live` is a run for ticket CA-307 against the published containers.
- `2026-11-10-ca-311-ws` is a run for ticket CA-311 against a workspace, before publishing it.

## Suite reads one level

`tagreeve suite tagreeve/scenarios/` runs the `*.yml` and `*.yaml` files at the top level of the folder. It does not look into subfolders. Put scenarios that need a server container, or a person at a handoff, in a subfolder such as `server/` and run them with `tagreeve run`. They are skipped by the suite without a message.
