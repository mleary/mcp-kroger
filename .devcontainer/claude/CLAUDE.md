# User-level instructions for Claude Code (dev container)

You're running inside a VS Code dev container, not directly on Matt's Mac.

- Only the project folder is mounted (under `/workspaces`). Matt's Mac files, Keychain and other repos aren't reachable, on purpose.
- There are no GitHub credentials in here. Don't push or look for a way around that. Leave commits for Matt to review and push from the Mac.
- Don't deploy (e.g. `wrangler deploy`) or log in to outside services unless Matt asks.
