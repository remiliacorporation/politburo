#!/usr/bin/env bash
# Measure committed HEAD against refs/remotes/upstream/main. If that ref is
# absent, fetch main from FORK_THINNESS_UPSTREAM (local path or HTTP(S)/file
# URL), or from Vercel's board. Requires Git 2.43+ and GNU timeout.
# Each Git command gets 60s (FORK_THINNESS_TIMEOUT_SECONDS can override it).
# Known limit: input probes and local fetches can follow repository config
# includes outside the temporary home. A --no-local clone would still read
# source config via upload-pack. Use trusted repositories; reads are bounded.
# Binary entries and gitlinks count as zero. Gitlink type changes are rejected.
# Renames count at their destination.
set +x
set -euo pipefail

fail() {
  printf 'fork-thinness: %s\n' "$1" >&2
  exit 1
}

[[ $# -le 1 ]] || fail 'usage: fork-thinness.sh [repo-path]'
git_timeout=${FORK_THINNESS_TIMEOUT_SECONDS-60}
[[ $git_timeout =~ ^[1-9][0-9]*$ ]] || fail 'FORK_THINNESS_TIMEOUT_SECONDS must be a positive integer'
tmp=$(mktemp -d /tmp/fork-thinness.XXXXXXXX) || fail 'cannot create temporary directory'
trap 'rm -rf -- "$tmp"' EXIT
trap 'fail "interrupted"' HUP INT TERM

# Inherited Git settings can redirect writes, enable tracing, or change history.
unset "${!GIT_@}" SSLKEYLOGFILE
export HOME="$tmp" TMPDIR="$tmp" LC_ALL=C
export XDG_CONFIG_HOME="$tmp" XDG_CACHE_HOME="$tmp" XDG_DATA_HOME="$tmp"
export XDG_STATE_HOME="$tmp" XDG_RUNTIME_DIR="$tmp"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1
export GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_ALLOW_PROTOCOL=

# Use fixed diagnostics: Git can include credentials in its own errors.
run_git() { { timeout -k 2s "${git_timeout}s" git "$@"; } 2>/dev/null; }
judge_git() { run_git -C "$tmp" --git-dir="$tmp/repo.git" "$@"; }
git_fail() {
  case $1 in
    124|137) fail 'git command timed out' ;;
    *) fail "$2" ;;
  esac
}
is_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }
is_count() { [[ $1 =~ ^(0|[1-9][0-9]*)$ ]]; }

repo=${1-}
if [[ -z $repo ]]; then
  repo=$(dirname -- "${BASH_SOURCE[0]}") || fail 'cannot locate script directory'
fi
shallow=$(run_git -C "$repo" rev-parse --is-shallow-repository) || git_fail "$?" 'not a git repository'
[[ $shallow == false ]] || fail 'input repository is shallow'
if run_git -C "$repo" config --includes --get-regexp \
  '^(extensions\.partialclone|remote\..*\.(promisor|partialclonefilter))$' >/dev/null; then
  fail 'input repository is partial or promisor'
else
  status=$?
  [[ $status == 1 ]] || git_fail "$status" 'cannot check input partial clone configuration'
fi
head=$(run_git -C "$repo" rev-parse --verify HEAD) || git_fail "$?" 'input repository has no HEAD commit'
is_sha "$head" || fail 'invalid HEAD SHA (expected SHA-1)'
objects=$(run_git -C "$repo" rev-parse --path-format=absolute --git-path objects) || git_fail "$?" 'cannot locate input object store'
[[ $objects == /* && $objects != *$'\n'* && -d $objects ]] || fail 'invalid input object directory'
judge_git init --bare --object-format=sha1 --template= >/dev/null || git_fail "$?" 'cannot initialize temporary repository'

upstream_ref=refs/remotes/upstream/main
if run_git -C "$repo" show-ref --exists "$upstream_ref"; then
  upstream=$(run_git -C "$repo" show-ref --verify --hash "$upstream_ref") || git_fail "$?" 'cannot read upstream/main'
else
  status=$?
  [[ $status == 2 ]] || git_fail "$status" 'cannot check for upstream/main'
  source=${FORK_THINNESS_UPSTREAM:-https://github.com/vercel/board}
  case $source in
    /*|http://*|https://*|file://*) ;;
    *) source=$PWD/$source ;;
  esac
  # Fetch before attaching the input's objects, so the input cannot mask a
  # shallow fetch. Do not persist the source URL, even in FETCH_HEAD.
  GIT_ALLOW_PROTOCOL=file:http:https judge_git -c credential.helper= fetch \
    --no-tags --no-auto-maintenance --no-write-fetch-head --update-shallow -- "$source" \
    refs/heads/main:refs/remotes/upstream/main >/dev/null || git_fail "$?" 'cannot fetch upstream main (missing or inaccessible)'
  shallow=$(judge_git rev-parse --is-shallow-repository) || git_fail "$?" 'cannot check upstream history'
  [[ $shallow == false ]] || fail 'fetched upstream repository is shallow'
  upstream=$(judge_git show-ref --verify --hash "$upstream_ref") || git_fail "$?" 'fetch did not produce upstream/main'
fi
is_sha "$upstream" || fail 'invalid upstream SHA (expected SHA-1)'

# Only Git's object lookup uses the alternate. Refs, index, config and any
# Git writes belong to the judge's temporary repository.
printf '%s\n' "$objects" > "$tmp/repo.git/objects/info/alternates" || fail 'cannot attach input object store'
for tip in "$head" "$upstream"; do
  type=$(judge_git cat-file -t "$tip") || git_fail "$?" 'a tip object is missing'
  [[ $type == commit ]] || fail 'a tip is not a commit'
done
# Walk both tips, including their common history: a range excluding the
# merge base could miss unchanged blobs (and every blob in an empty diff).
judge_git rev-list --objects --no-object-names --missing=print "$head" "$upstream" \
  > "$tmp/object-list" || git_fail "$?" 'incomplete object history'
if grep -q '^?' "$tmp/object-list"; then
  fail 'incomplete object history'
else
  [[ $? == 1 ]] || fail 'cannot check object list'
fi
base=$(judge_git merge-base --all "$head" "$upstream") || git_fail "$?" 'no merge base or incomplete history'
is_sha "$base" || fail 'expected exactly one SHA-1 merge base'
behind=$(judge_git rev-list --count "$head..$upstream") || git_fail "$?" 'cannot count commits behind upstream'
ahead=$(judge_git rev-list --count "$upstream..$head") || git_fail "$?" 'cannot count commits ahead of upstream'
if ! is_count "$behind" || ! is_count "$ahead"; then
  fail 'invalid commit count'
fi

src=packages/board/src
# --ignore-submodules does not suppress file/gitlink type changes. Reject
# those pairs before Git can count a synthetic "Subproject commit" line.
judge_git diff --raw -z --no-renames --no-ext-diff --no-textconv \
  --ignore-submodules=none --diff-filter=T "$base" "$head" -- "$src" \
  > "$tmp/type-changes" || git_fail "$?" 'cannot check board source type changes'
while IFS= read -r -d '' change; do
  IFS= read -r -d '' change_path && [[ -n $change_path ]] || fail 'malformed type change entry'
  if [[ $change == ':160000 '* || $change == :??????' 160000 '* ]]; then
    fail 'gitlink type change in board source'
  fi
done < "$tmp/type-changes"
[[ -z $change ]] || fail 'unterminated type change entry'

hot=("$src/conformance/index.ts" "$src/cli/main.ts" "$src/server/tasks.ts"
     "$src/cli/commands.ts" "$src/api/routes.ts" "$src/server/serve.ts")
counts=(0 0 0 0 0 0)
board_total=0 hot_total=0
GIT_ATTR_SOURCE="$head" judge_git diff --numstat -z --no-ext-diff --no-textconv \
  --ignore-submodules=all "$base" "$head" -- "$src" > "$tmp/numstat" || git_fail "$?" 'cannot diff board source'

# Parse NUL-delimited records so unusual filenames cannot change the total.
# A rename record has an empty inline path, then two NUL-delimited paths.
while IFS= read -r -d '' record; do
  added=${record%%$'\t'*}
  rest=${record#*$'\t'}
  deleted=${rest%%$'\t'*}
  path=${rest#*$'\t'}
  [[ $rest != "$record" && $path != "$rest" ]] || fail 'malformed numstat entry'
  if [[ -z $path ]]; then
    if ! IFS= read -r -d '' old_path || ! IFS= read -r -d '' path; then
      fail 'malformed numstat rename'
    fi
    [[ -n $old_path && -n $path ]] || fail 'missing numstat rename path'
  fi
  if [[ $added == - && $deleted == - ]]; then
    added=0
  else
    if ! is_count "$added" || ! is_count "$deleted"; then
      fail 'invalid numstat line count'
    fi
  fi
  next=$((board_total + added))
  if (( next < board_total )) || [[ $((added)) != "$added" ]]; then
    fail 'line count overflow'
  fi
  board_total=$next
  for i in "${!hot[@]}"; do
    if [[ $path == "${hot[i]}" ]]; then
      counts[i]=$((counts[i] + added))
      hot_total=$((hot_total + added))
    fi
  done
done < "$tmp/numstat"
[[ -z $record ]] || fail 'unterminated numstat entry'
if ! is_count "$board_total" || ! is_count "$hot_total"; then
  fail 'invalid line total'
fi

hot_json=
for i in "${!hot[@]}"; do
  is_count "${counts[i]}" || fail 'invalid hot-file count'
  printf -v hot_json '%s%s"%s":%s' "$hot_json" "${hot_json:+,}" "${hot[i]}" "${counts[i]}"
done
printf '{"metric":"fork-thinness","added_lines_board_src":%s,"added_lines_hot_files":%s,"hot_files":{%s},"commits_behind_upstream":%s,"commits_ahead_upstream":%s,"merge_base":"%s","head":"%s","upstream":"%s"}\n' \
  "$board_total" "$hot_total" "$hot_json" "$behind" "$ahead" "$base" "$head" "$upstream"
