#!/usr/bin/env bash
# Exercises gitleaks-ci.sh against throwaway repositories. Requires gitleaks
# (the version pinned in .github/workflows/gitleaks.yml) and openssl on PATH.
#
#   bash .github/scripts/gitleaks-ci.test.sh

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/.github/scripts/gitleaks-ci.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
git() { command git -c core.hooksPath=/dev/null -c init.defaultBranch=main "$@"; }

failures=0

# expect STATUS PATTERN DESCRIPTION -- COMMAND...
expect() {
  local want="$1" pattern="$2" description="$3" status=0
  shift 4
  "$@" >"$work/out" 2>&1 || status=$?
  if [ "$status" -eq "$want" ] && grep -Eq -- "$pattern" "$work/out"; then
    echo "PASS $description"
  else
    echo "FAIL $description (exit $status, wanted $want and /$pattern/)"
    sed 's/^/    /' "$work/out"
    failures=$((failures + 1))
  fi
}

token() { printf 'ghp_%s' "$(openssl rand -hex 18)"; }

commit() {
  git add -A
  git commit -q --allow-empty -m "$1"
  git rev-parse HEAD
}

# A repository with main and a two-entry queue branch: entry 1 adds a secret,
# entry 2 removes it, so the group's final tree is clean.
new_repo() {
  local dir="$work/$1"
  git init -q "$dir"
  cd "$dir"
  cp "$root/.gitleaks.toml" .gitleaks.toml
  echo base >base.txt
  base="$(commit base)"
  git checkout -q -b queue
}

in_dir() { (cd "$1" && shift && "$@"); }

# --- canary --------------------------------------------------------------

mkdir -p "$work/canary"
cd "$work/canary"

cp "$root/.gitleaks.toml" .gitleaks.toml
expect 0 "rules are active" "canary: repository configuration detects a secret" -- bash "$script" canary

printf '[allowlist]\n  regexes = ["unused"]\n' >.gitleaks.toml
expect 1 "detected nothing" "canary: configuration without default rules fails" -- bash "$script" canary

printf '[extend]\n  useDefault = true\n[allowlist]\n  paths = [".*"]\n' >.gitleaks.toml
expect 1 "detected nothing" "canary: configuration allowlisting every path fails" -- bash "$script" canary

printf 'x = [\n' >.gitleaks.toml
expect 1 "canary scan failed" "canary: invalid configuration fails" -- bash "$script" canary

rm .gitleaks.toml
expect 0 "rules are active" "canary: default rules without a configuration pass" -- bash "$script" canary

expect 1 "not supported" "canary: configuration from the environment fails" -- \
  env GITLEAKS_CONFIG=/dev/null bash "$script" canary

# --- merge group ---------------------------------------------------------

new_repo group
echo "token = \"$(token)\"" >leak.txt
entry1="$(commit "entry 1 adds a secret")"
rm leak.txt
entry2="$(commit "entry 2 removes it")"

expect 1 "leaks found: 1" "merge group: secret added and removed within the group is found" -- \
  bash "$script" merge-group main "$entry2"
expect 0 "no leaks found" "merge group: parent-commit range misses it (why TARGET is the branch)" -- \
  gitleaks git --no-banner --exit-code 1 --log-opts="--no-merges $entry1..$entry2" .

git checkout -q "$entry1"
expect 1 "not the merge group head" "merge group: checkout other than the head fails" -- \
  bash "$script" merge-group main "$entry2"
git checkout -q queue

git branch -q -f merged "$entry1"
expect 0 "Scanning 1 commit" "merge group: commits already on the target are not rescanned" -- \
  bash "$script" merge-group merged "$entry2"

expect 1 "Target origin/main is not available" "merge group: missing target fails" -- \
  bash "$script" merge-group origin/main "$entry2"
expect 1 "head 0+ is not available" "merge group: missing head fails" -- \
  bash "$script" merge-group main 0000000000000000000000000000000000000000
expect 1 "no commits to scan" "merge group: empty range fails" -- \
  bash "$script" merge-group queue "$entry2"

git checkout -q main
echo diverged >diverged.txt
commit "pushed to main outside the queue" >/dev/null
git checkout -q queue
expect 1 "not an ancestor" "merge group: target that diverged from the group fails" -- \
  bash "$script" merge-group main "$entry2"

git clone -q --depth 1 --branch queue "file://$work/group" "$work/shallow"
expect 1 "not available|not an ancestor" "merge group: shallow clone without the target fails" -- \
  in_dir "$work/shallow" bash "$script" merge-group "$base" "$entry2"

new_repo clean
echo "fixture = \"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\"" >fixture.txt
commit "entry 1 adds the allowlisted fixture" >/dev/null
echo ok >other.txt
head="$(commit "entry 2")"
expect 0 "Scanning 2 commit.*|no leaks found" "merge group: clean group with allowlisted fixture passes" -- \
  bash "$script" merge-group main "$head"

expect 1 "Usage" "usage errors fail" -- bash "$script" merge-group main

if [ "$failures" -gt 0 ]; then
  echo "$failures test(s) failed"
  exit 1
fi
echo "All gitleaks-ci.sh tests passed"
