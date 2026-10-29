#!/usr/bin/env bash
# Usage: scripts/release.sh [--no-tag] <version>
# Builds a release commit with dist/ (and no build script) on a detached HEAD and tags it v<version>.
# The commit is reachable only from its tag and is never merged to main.
set -euo pipefail

tag=1
if [ "${1:-}" = "--no-tag" ]; then
  tag=0
  shift
fi
if [ $# -ne 1 ]; then
  echo "usage: scripts/release.sh [--no-tag] <version>" >&2
  exit 2
fi
version="$1"

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing: the working tree is not clean" >&2
  exit 1
fi

# --no-tag runs in CI clones, where HEAD is a branch commit that is not on main.
if [ "$tag" = 1 ]; then
  git fetch -q origin main
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "refusing: HEAD is not origin/main" >&2
    exit 1
  fi
fi

current=$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')
if [ "$current" != "$version" ]; then
  echo "refusing: package.json version is $current, not $version" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm build

identity=(-c "user.name=${GIT_AUTHOR_NAME:-Pingwright Release}" -c "user.email=${GIT_AUTHOR_EMAIL:-release@example.com}")

git checkout -q --detach
# npm runs a nested install for git dependencies whose scripts include build, which races with the outer global install.
npm pkg delete scripts.build
git add -f dist package.json
git "${identity[@]}" commit -q -m "Release v$version" -- dist package.json

if [ "$tag" = 1 ]; then
  git "${identity[@]}" tag -a "v$version" -m "Release v$version"
  echo "Tagged v$version. Publish it with:"
  echo "  git push origin v$version"
else
  echo "Built release commit $(git rev-parse HEAD) without a tag."
fi
