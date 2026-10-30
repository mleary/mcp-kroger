#!/usr/bin/env bash
# PreToolUse hook: block any Bash command that runs `git push`, whatever the
# flags or ordering (git -C repo push, cd x && git push, git -c k=v push ...).
# Exit 2 blocks the call and sends stderr back to Claude as the reason.
# Deliberately blunt: a command mentioning both `git` and `push` as words is
# blocked. `git stash push` is allowed. Push yourself from your own terminal.

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# allow `git stash push`
check=$(printf '%s' "$cmd" | sed -E 's/stash[[:space:]]+push//g')

word() { printf '%s' "$check" | grep -Eq "(^|[^[:alnum:]_.-])$1([^[:alnum:]_.-]|\$)"; }

if word git && word push; then
  echo "Blocked by block-git-push hook: agents don't push. Leave the commit for Matt to review and push." >&2
  exit 2
fi
exit 0
