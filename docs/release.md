# Releasing

Releases are git tags. Each tag points at a commit that carries a built `dist/`. That commit is reachable only from its tag and is never merged to main.

1. Bump `version` in `package.json` and merge the change to main.
2. Check out main at the merge commit, with a clean tree.
3. Run `scripts/release.sh <version>`. It builds, commits `dist/` on a detached HEAD and creates the annotated tag `v<version>`.
4. Push the tag with the command the script prints: `git push origin v<version>`.

The script refuses to run if the tree is dirty, HEAD is not origin/main, or `package.json` does not match `<version>`. It does not push and it does not create a GitHub release.

CI runs `scripts/release.sh --no-tag` in a temporary clone and installs the result, so a broken release commit shows up before a tag exists.
