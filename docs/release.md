# Releasing

Releases are git tags. Each tag points at a commit that carries a built `dist/`. That commit is reachable only from its tag and is never merged to main.

1. Bump `version` in `package.json` and merge the change to main.
2. Check out main at the merge commit, with a clean tree.
3. Run `scripts/release.sh <version>`. It builds, then commits `dist/` and a `package.json` without the `build` script on a detached HEAD and creates the annotated tag `v<version>`. The commit and tag use the maintainer's identity (`user.name` and `user.email`, or `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`). The committer and tagger default to the same identity unless `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` are set. The script stops if none is set.
4. Push the tag with the command the script prints: `git push origin v<version>`.

The script refuses to run if the tree is dirty, HEAD is not origin/main, or `package.json` does not match `<version>`. It does not push and it does not create a GitHub release.

The release commit drops the `build` script because npm runs a nested install for git dependencies that have one, and that install races with the outer one.

CI runs `scripts/release.sh --no-tag` in a temporary clone and installs the result, so a broken release commit shows up before a tag exists.

## Public Suffix List

The `serverHosts` check and the first-party check use the Public Suffix List that ships inside `tldts`. Nothing fetches it at run time. Before each release, bump `tldts` in the root package, `packages/recorder` and `packages/expect` to the newest version that is at least two weeks old. A bump needs no code change.
