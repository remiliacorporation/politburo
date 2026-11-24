#!/usr/bin/env bash
set -euo pipefail
exec 3>&2 2>/dev/null
fail() { printf 'error: %s\n' "$1" >&3; exit 1; }
trap 'fail "swarm lines measurement failed"' ERR

unset CDPATH
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
head_ref=HEAD
while (($#)); do
  case "$1" in
    --repo|--head)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail "missing option value"
      if [[ $1 == --repo ]]; then repo=$2; else head_ref=$2; fi
      shift 2 ;;
    *) fail "unknown argument" ;;
  esac
done

unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE
for key in "${!GIT_TRACE@}"; do unset "$key"; done
export GIT_ALLOW_PROTOCOL= GIT_NO_LAZY_FETCH=1 LC_ALL=C
g() { git --no-replace-objects -C "$repo" "$@"; }
head=$(g rev-parse --verify --end-of-options "$head_ref^{commit}") || fail "could not resolve head"
[[ $head =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "invalid head SHA"

count_lines() {
  g ls-tree -rz --full-tree "$head" -- "packages/swarm/$1/" |
    {
      while IFS= read -r -d '' entry; do
        path=${entry#*$'\t'}
        [[ $path == *.ts ]] || continue
        read -r mode type object <<< "${entry%%$'\t'*}"
        [[ $mode == 100* && $type == blob ]] || continue
        g cat-file blob "$object" || return 1
      done
    } | wc -l
}
src=$(count_lines src) || fail "could not count source lines"
tests=$(count_lines test) || fail "could not count test lines"
printf '{"metric":"swarm_lines","value":%d,"unit":"lines of TypeScript in packages/swarm/src (tests counted separately)","lines_src":%d,"lines_test":%d,"head":"%s"}\n' \
  "$src" "$src" "$tests" "$head"
