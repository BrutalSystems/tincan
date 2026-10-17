#!/usr/bin/env bash
# Blocks a push that would publish something that should stay private:
# personal home paths, email addresses, credentials, and any terms in a local,
# uncommitted list.
#
#   scripts/check-public.sh                 as a pre-push hook: reads git's ref lines on stdin
#   scripts/check-public.sh --range A..B    checks the commits in A..B
#   scripts/check-public.sh --tree [REV]    checks every tracked file at REV (default HEAD)
#
# Checked: added diff lines, commit messages and pushed ref names (--range and
# hook), or file contents (--tree).
#
# Patterns: the generic ones below, plus the local terms file, one extended
# regex per line, `#` comments and blank lines ignored, matched
# case-insensitively. The terms file is never committed; it is found at
# $PUBLIC_TERMS_FILE, else `git config public.termsFile`, else
# ~/.config/public-terms.txt. When one of the first two names a file that does
# not exist, the check fails; a missing default file is a warning, and only the
# generic patterns run.
#
# Exit: 0 clean, 1 hits found (push blocked), 2 the check itself could not run
# (bad pattern, unreadable file, bad arguments). A check that cannot run is
# never reported as clean.
#
# Uses /usr/bin/grep, not a `grep` from PATH or a shell function: it must
# honour \b, which some greps (macOS `git grep -E`) silently ignore.

set -u
GREP=/usr/bin/grep
[ -x "$GREP" ] || GREP=/bin/grep
[ -x "$GREP" ] || { echo "check-public: no system grep at /usr/bin/grep or /bin/grep" >&2; exit 2; }

ZERO=0000000000000000000000000000000000000000
work=$(mktemp -d "${TMPDIR:-/tmp}/check-public.XXXXXX") || exit 2
trap 'rm -rf "$work"' EXIT

# --- patterns ---------------------------------------------------------------

generic="$work/generic"
cat >"$generic" <<'EOF'
(/Users|/home)/[A-Za-z0-9._-]+
[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}
AKIA[0-9A-Z]{16}
gh[pousr]_[A-Za-z0-9]{20,}
github_pat_[A-Za-z0-9_]{20,}
npm_[A-Za-z0-9]{30,}
sk-ant-[A-Za-z0-9_-]{8,}
xox[abprs]-[A-Za-z0-9-]{8,}
BEGIN [A-Z ]*PRIVATE KEY
EOF

# Matches of the generic patterns that are fine to publish: example home
# directories, placeholder and no-reply addresses.
allowed="$work/allowed"
cat >"$allowed" <<'EOF'
^(/Users|/home)/(example|dev|user|username|you|me|x|other|someone|alice|bob|runner|[a-z]|\$[A-Za-z_]+|<[^>]*>)$
@(example\.(com|org|net)|users\.noreply\.github\.com)$
^(noreply@anthropic\.com|noreply@github\.com|npm-oidc-no-reply@github\.com|git@github\.com)$
EOF

terms="$work/terms"
: >"$terms"
explicit=${PUBLIC_TERMS_FILE:-$(git config --get public.termsFile 2>/dev/null || true)}
if [ -n "$explicit" ]; then
  src=${explicit/#\~/$HOME}
  [ -r "$src" ] || { echo "check-public: terms file not readable: $src" >&2; exit 2; }
else
  src="$HOME/.config/public-terms.txt"
  [ -r "$src" ] || { echo "check-public: no terms file at $src; checking generic patterns only" >&2; src=; }
fi
if [ -n "$src" ]; then
  # Status 1 just means the file has no patterns in it.
  "$GREP" -vE '^[[:space:]]*(#|$)' "$src" >"$terms"
  [ $? -le 1 ] || { echo "check-public: could not read $src" >&2; exit 2; }
fi

# Fail on a pattern grep cannot compile, rather than letting it read as no match.
for p in "$generic" "$allowed" "$terms"; do
  [ -s "$p" ] || continue
  echo | "$GREP" -iE -f "$p" >/dev/null 2>"$work/err"
  [ $? -le 1 ] || { echo "check-public: bad pattern in ${p##*/}: $(cat "$work/err")" >&2; exit 2; }
done

# --- what to check ----------------------------------------------------------

text="$work/text"
: >"$text"

add_range() { # $1 = rev-list arguments
  # Added lines only, from every commit, so a term added and removed again in
  # the same push is still caught; plus each full commit message.
  git log --format=%B $1 >>"$text" \
    || { echo "check-public: git log failed for $1" >&2; exit 2; }
  git log --no-color --no-ext-diff -p --format= $1 >"$work/patch" \
    || { echo "check-public: git log -p failed for $1" >&2; exit 2; }
  "$GREP" -E '^\+' "$work/patch" | "$GREP" -vE '^\+\+\+ ' >>"$text"
  local s=("${PIPESTATUS[@]}")
  [ "${s[0]}" -le 1 ] && [ "${s[1]}" -le 1 ] || exit 2
}

case "${1:-}" in
  --range)
    [ -n "${2:-}" ] || { echo "usage: $0 --range A..B" >&2; exit 2; }
    add_range "$2"
    ;;
  --tree)
    rev=${2:-HEAD}
    git grep -I -h -e '' "$rev" -- >"$text" 2>"$work/err"
    [ $? -le 1 ] || { echo "check-public: git grep failed: $(cat "$work/err")" >&2; exit 2; }
    ;;
  '')
    # pre-push: "<local ref> <local sha> <remote ref> <remote sha>" per line.
    while read -r lref lsha rref rsha; do
      [ "$lsha" = "$ZERO" ] && continue # a deletion publishes nothing new
      printf '%s\n%s\n' "$lref" "$rref" >>"$text"
      if [ "$rsha" = "$ZERO" ]; then
        add_range "$lsha --not --remotes"
      else
        add_range "$rsha..$lsha"
      fi
    done
    ;;
  *)
    echo "usage: $0 [--range A..B | --tree [REV]]" >&2
    exit 2
    ;;
esac

# --- match ------------------------------------------------------------------

hits="$work/hits"
: >"$hits"

if [ -s "$terms" ]; then
  "$GREP" -niE -f "$terms" "$text" >>"$hits"
  [ $? -le 1 ] || { echo "check-public: grep failed on the terms file" >&2; exit 2; }
fi

"$GREP" -noE -f "$generic" "$text" >"$work/generic-hits"
[ $? -le 1 ] || { echo "check-public: grep failed on the generic patterns" >&2; exit 2; }
# Keep a generic match unless the matched text itself is allowed.
while IFS= read -r line; do
  match=${line#*:}
  printf '%s\n' "$match" | "$GREP" -qE -f "$allowed"
  case $? in
    0) ;;
    1) printf '%s\n' "$line" >>"$hits" ;;
    *) exit 2 ;;
  esac
done <"$work/generic-hits"

if [ -s "$hits" ]; then
  echo "check-public: BLOCKED — this would publish text that matches a private or generic pattern:" >&2
  # Line numbers are into the combined text checked, not any one file.
  sed 's/^/  /' "$hits" | cut -c1-200 >&2
  echo "Reword it (or, for a true false positive, narrow the pattern), then push again." >&2
  exit 1
fi
echo "check-public: clean" >&2
exit 0
