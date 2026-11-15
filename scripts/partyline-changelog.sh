#!/usr/bin/env bash
#
# Post this deploy's new Partyline changes to room #updates.
# Mirrors amiexpress-web deploy/changelog-bulletin.sh: the last posted sha is
# kept in a state file, each deploy posts the commit subjects after it. The
# image has no git, so this runs on the host after `docker compose up`.
# First run (no state): records HEAD, posts nothing.
#
# Sourced by the deploy workflow for `partyline_changelog_update`;
# `partyline_changelog_subjects` is pure so it can be tested on a scratch repo.

PARTYLINE_CHANGELOG_PATHS="src/partyline src/chat"

# partyline_changelog_subjects <repo> <from-sha> <to-sha>  (oldest first)
partyline_changelog_subjects() {
  # shellcheck disable=SC2086
  git -C "$1" log --no-merges --reverse --format='%s' "$2..$3" -- $PARTYLINE_CHANGELOG_PATHS
}

# partyline_changelog_update <repo> <to-sha> [service]
partyline_changelog_update() {
  local repo="$1" to="$2" service="${3:-doorserver}" state from subjects
  state="$repo/.partyline-changelog-sha"
  from=$(cat "$state" 2>/dev/null || true)
  if [ -n "$from" ] && [ "$from" != "$to" ] && git -C "$repo" cat-file -e "${from}^{commit}" 2>/dev/null; then
    subjects=$(partyline_changelog_subjects "$repo" "$from" "$to")
    if [ -n "$subjects" ]; then
      printf '%s\n' "$subjects" | (cd "$repo" && docker compose exec -T "$service" node dist/scripts/partyline-changelog.js "$to") || return 1
    fi
  fi
  printf '%s' "$to" > "$state"
}
