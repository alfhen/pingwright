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

A GTM override file holds the `gtmAuth` value of a workspace. A server container config is a secret too. Keep both files outside the repo, for example in `~/.config/tagreeve/`, and give them mode 0600. The [server container guide](server-container.md) shows how to save the config:

```bash
chmod 600 ~/.config/tagreeve/workspace-override.json
```

Tagreeve never prints either value or writes it to a record.

## Where runs go

Without `--out`, a run writes to `tagreeve/runs/<YYYY-MM-DD>/`, which is in the ignored folder. A suite writes its `suite_<id>/` folder there. Give `--out` to choose a folder yourself:

```bash
tagreeve run tagreeve/scenarios/checkout.yml --site https://staging.example.com \
  --out tagreeve/runs/2026-11-03-ca-307-live
```

If `./runs/` holds records from an older version, `run` and `suite` print a note. Pass `--out runs` to keep using that folder.

## Naming a run folder

Give the run a label with `--label`, such as `--label ca-307-live`. Tagreeve puts the date in front: `tagreeve/runs/2026-11-03-ca-307-live/`. The label is also stored in the record. Use `<ticket or topic>-<target>`. The target says what was tested:

- `ca-307-live` is a run for ticket CA-307 against the published containers.
- `ca-311-ws` is a run for ticket CA-311 against a workspace, before publishing it.

## Suite reads one level

`tagreeve suite tagreeve/scenarios/` runs the `*.yml` and `*.yaml` files at the top level of the folder. It does not look into subfolders. Put scenarios that need a server container in a subfolder such as `server/` and run them with `tagreeve run`. The suite skips the subfolder without a message. Scenarios with a handoff step can stay at the top level: the suite shows them as SKIPPED, and runs them with `--with-handoff`.
