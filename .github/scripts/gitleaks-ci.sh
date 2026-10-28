#!/usr/bin/env bash
# Gitleaks checks that gitleaks/gitleaks-action cannot perform.
#
#   gitleaks-ci.sh canary
#     Fails unless the effective configuration reports a generated GitHub token,
#     so an empty rule set cannot produce a green scan.
#
#   gitleaks-ci.sh merge-group TARGET HEAD_SHA
#     Scans every non-merge commit in TARGET..HEAD_SHA. Pass the queue's target
#     branch, not the merge group's parent commit: a group's parent may be the
#     preceding queue entry, whose commits would otherwise go unscanned.
#
# Run from the repository root. Gitleaks exits 0 when git rejects the log range,
# so the range is validated before scanning.

set -euo pipefail

fail() {
  printf '::error::%s\n' "$1"
  exit 1
}

if [ -n "${GITLEAKS_CONFIG:-}${GITLEAKS_CONFIG_TOML:-}" ]; then
  fail "GITLEAKS_CONFIG and GITLEAKS_CONFIG_TOML are not supported; configure .gitleaks.toml."
fi

config=()
if [ -f .gitleaks.toml ]; then
  config=(--config "$PWD/.gitleaks.toml")
fi

canary() {
  local dir status=0
  dir="$(mktemp -d)"
  printf 'token = "ghp_%s"\n' "$(openssl rand -hex 18)" >"$dir/canary.txt"
  gitleaks dir --no-banner --redact --exit-code 3 ${config[@]+"${config[@]}"} "$dir" >"$dir/gitleaks.log" 2>&1 || status=$?

  case "$status" in
    3)
      echo "Gitleaks rules are active: a generated GitHub token was detected."
      ;;
    0)
      fail "Gitleaks detected nothing in a generated GitHub token; check that .gitleaks.toml extends the default rules."
      ;;
    *)
      cat "$dir/gitleaks.log"
      fail "Gitleaks canary scan failed with exit code $status."
      ;;
  esac
  rm -rf "$dir"
}

merge_group() {
  local target="$1" head="$2" count

  git rev-parse --verify --quiet "${target}^{commit}" >/dev/null || fail "Target $target is not available."
  git rev-parse --verify --quiet "${head}^{commit}" >/dev/null || fail "Merge group head $head is not available."
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "${head}^{commit}")" ] || fail "The checkout is not the merge group head."
  git merge-base --is-ancestor "$target" "$head" || fail "$target is not an ancestor of the merge group."

  count="$(git rev-list --count --no-merges "$target..$head")"
  [ "$count" -gt 0 ] || fail "The merge group has no commits to scan."

  echo "Scanning $count commit(s) in $target..$head"
  gitleaks git --no-banner --redact --exit-code 1 ${config[@]+"${config[@]}"} \
    --log-opts="--no-merges $target..$head" .
}

case "${1:-}" in
  canary)
    [ "$#" -eq 1 ] || fail "Usage: gitleaks-ci.sh canary"
    canary
    ;;
  merge-group)
    [ "$#" -eq 3 ] || fail "Usage: gitleaks-ci.sh merge-group TARGET HEAD_SHA"
    merge_group "$2" "$3"
    ;;
  *)
    fail "Usage: gitleaks-ci.sh canary | merge-group TARGET HEAD_SHA"
    ;;
esac
