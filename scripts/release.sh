#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
export GIT_TERMINAL_PROMPT=0

usage() {
  echo "Usage: scripts/release.sh MAJOR.MINOR.PATCH"
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

RELEASE_VERSION="$1"
if [[ ! "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Error: release version must be a canonical stable semantic version (x.y.z)." >&2
  exit 1
fi

RELEASE_TAG="v${RELEASE_VERSION}"
TARGET_BRANCH="main"
ORIGIN_NAME="origin"
EXPECTED_PACKAGE_NAME="@ngelik/brain-hands"
EXPECTED_REPOSITORY="github.com/ngelik/brain-hands"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: unable to locate repository root." >&2
  exit 1
}
cd "$REPO_ROOT"
RELEASE_FILES=(
  package.json
  package-lock.json
  .codex-plugin/plugin.json
  .agents/skills/brain-hands/SKILL.md
)

normalize_git_url() {
  printf '%s' "$1" | sed -E \
    -e 's#^git\+##' \
    -e 's#^https?://##' \
    -e 's#^ssh://git@##' \
    -e 's#^git@([^:]+):#\1/#' \
    -e 's#\.git/*$##' \
    -e 's#/*$##' | tr '[:upper:]' '[:lower:]'
}

validate_identity() {
  node --input-type=module - "$REPO_ROOT" "$EXPECTED_PACKAGE_NAME" "$EXPECTED_REPOSITORY" <<'NODE'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [root, expectedName, expectedRepository] = process.argv.slice(2);
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const rawRepository = typeof packageJson.repository === "string"
  ? packageJson.repository
  : packageJson.repository?.url;
const repository = String(rawRepository ?? "")
  .replace(/^git\+/, "")
  .replace(/^https?:\/\//, "")
  .replace(/^ssh:\/\/git@/, "")
  .replace(/^git@([^:]+):/, "$1/")
  .replace(/\.git\/?$/, "")
  .replace(/\/+$/, "")
  .toLowerCase();
if (packageJson.name !== expectedName) throw new Error(`package.json name must be exactly ${expectedName}`);
if (repository !== expectedRepository) throw new Error(`package.json repository must be exactly ${expectedRepository}`);
NODE
}

verify_version_sync() {
  node --input-type=module - "$REPO_ROOT" "$RELEASE_VERSION" <<'NODE'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [root, expected] = process.argv.slice(2);
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const packageJson = readJson("package.json");
const lockfile = readJson("package-lock.json");
const plugin = readJson(".codex-plugin/plugin.json");
const skill = readFileSync(resolve(root, ".agents/skills/brain-hands/SKILL.md"), "utf8");
const range = /^\s+codex_flow:\s*["']?([^"'\s]+)["']?\s*$/mu.exec(skill)?.[1];
if (packageJson.version !== expected || lockfile.version !== expected ||
    lockfile.packages?.[""]?.version !== expected || plugin.version !== expected ||
    range !== `^${expected}`) process.exit(1);
NODE
}

has_only_release_file_changes() {
  local line path
  local found=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    found=1
    path="${line:3}"
    case "$path" in
      package.json|package-lock.json|.codex-plugin/plugin.json|.agents/skills/brain-hands/SKILL.md) ;;
      *) return 1 ;;
    esac
  done < <(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)
  [[ "$found" -eq 1 ]]
}

local_tag_type=""
local_tag_commit=""
local_tag_object=""
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/tags/$RELEASE_TAG"; then
  local_tag_type="$(git -C "$REPO_ROOT" cat-file -t "refs/tags/$RELEASE_TAG")"
  local_tag_commit="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$RELEASE_TAG^{commit}")"
  local_tag_object="$(git -C "$REPO_ROOT" rev-parse "refs/tags/$RELEASE_TAG")"
fi

remote_tag_object=""
remote_tag_commit=""
read_remote_tag() {
  local hash ref
  remote_tag_object=""
  remote_tag_commit=""
  while IFS=$'\t' read -r hash ref; do
    [[ "$ref" == "refs/tags/$RELEASE_TAG" ]] && remote_tag_object="$hash"
    [[ "$ref" == "refs/tags/$RELEASE_TAG^{}" ]] && remote_tag_commit="$hash"
  done < <(git -C "$REPO_ROOT" ls-remote --tags "$ORIGIN_NAME" \
    "refs/tags/$RELEASE_TAG" "refs/tags/$RELEASE_TAG^{}")
}

run_release_gates() {
  npm run verify:funnel
  npm pack --dry-run --json --ignore-scripts
}

validate_identity
branch="$(git -C "$REPO_ROOT" branch --show-current)"
if [[ "$branch" != "$TARGET_BRANCH" ]]; then
  echo "Error: release must run from ${TARGET_BRANCH}." >&2
  exit 1
fi

origin_url="$(git -C "$REPO_ROOT" config --get "remote.${ORIGIN_NAME}.url" || true)"
if [[ "$(normalize_git_url "$origin_url")" != "$EXPECTED_REPOSITORY" ]]; then
  echo "Error: origin remote must be exactly ${EXPECTED_REPOSITORY}." >&2
  exit 1
fi

git -C "$REPO_ROOT" fetch --quiet "$ORIGIN_NAME" "$TARGET_BRANCH"
remote_main="$(git -C "$REPO_ROOT" rev-parse "refs/remotes/$ORIGIN_NAME/$TARGET_BRANCH")"
head_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
read_remote_tag

if [[ -n "$local_tag_type" && "$local_tag_type" != "tag" ]]; then
  echo "Error: existing ${RELEASE_TAG} is not an annotated tag." >&2
  exit 1
fi
if [[ -n "$remote_tag_object" && -z "$remote_tag_commit" ]]; then
  echo "Error: remote ${RELEASE_TAG} is not an annotated tag." >&2
  exit 1
fi

dirty="$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)"
if [[ -n "$dirty" ]] && { ! has_only_release_file_changes || ! verify_version_sync; }; then
  echo "Error: repository has unrelated or invalid uncommitted changes." >&2
  exit 1
fi

if [[ "$head_commit" == "$remote_main" && -n "$local_tag_commit" && -n "$remote_tag_commit" ]]; then
  if [[ "$local_tag_commit" != "$head_commit" || "$remote_tag_commit" != "$head_commit" ||
        "$local_tag_object" != "$remote_tag_object" ]] || ! verify_version_sync; then
    echo "Error: local and remote release tag state conflicts with ${RELEASE_TAG}." >&2
    exit 1
  fi
  echo "Release ${RELEASE_TAG} already dispatched. GitHub Actions is responsible for npm publication:"
  echo "https://github.com/ngelik/brain-hands/actions/workflows/publish-npm.yml"
  exit 0
fi

resume=false
if [[ "$head_commit" != "$remote_main" ]]; then
  if [[ -n "$dirty" || -z "$local_tag_commit" || -n "$remote_tag_object" ||
        "$local_tag_commit" != "$head_commit" ||
        "$(git -C "$REPO_ROOT" rev-parse "${head_commit}^")" != "$remote_main" ||
        "$(git -C "$REPO_ROOT" log -1 --pretty=%s)" != "chore(release): ${RELEASE_TAG}" ]] ||
        ! verify_version_sync; then
    echo "Error: local main is behind, diverged, or not an exact resumable release commit." >&2
    exit 1
  fi
  resume=true
elif [[ -n "$local_tag_commit" || -n "$remote_tag_object" ]]; then
  echo "Error: conflicting release tag ${RELEASE_TAG} already exists." >&2
  exit 1
fi

if [[ "$resume" == false ]]; then
  if [[ -z "$dirty" ]]; then
    node "$REPO_ROOT/scripts/release-version.mjs" sync "$RELEASE_VERSION" --root "$REPO_ROOT"
  fi
  verify_version_sync || {
    echo "Error: release version synchronization failed." >&2
    exit 1
  }
fi

run_release_gates
validate_identity
verify_version_sync

if [[ "$resume" == false ]]; then
  git -C "$REPO_ROOT" add -- "${RELEASE_FILES[@]}"
  git -C "$REPO_ROOT" commit -m "chore(release): ${RELEASE_TAG}"
  head_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  git -C "$REPO_ROOT" tag -a "$RELEASE_TAG" -m "Release ${RELEASE_TAG}" "$head_commit"
fi

git -C "$REPO_ROOT" push --atomic "$ORIGIN_NAME" \
  "$TARGET_BRANCH" "refs/tags/$RELEASE_TAG"

echo "Release ${RELEASE_TAG} dispatched. GitHub Actions is responsible for npm publication:"
echo "https://github.com/ngelik/brain-hands/actions/workflows/publish-npm.yml"
