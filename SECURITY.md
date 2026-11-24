# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/aadu2324/company-hq/security/advisories/new)
rather than in a public issue. You can expect a first reply within a week.

## What the plugin does

- **The mod** (`hooks/`) reads files under the project's `.company/` folder, the bundled `engine/catalog.json`
  and `~/.claude/company/catalog.json`. It runs `node <plugin>/engine/bin/hq.js` with fixed arguments for the
  `/hq` commands, and `node <plugin>/engine/hooks/delegation-log.cjs` (JSON on stdin) to record chat subagents.
  It makes no network requests and no model calls.
- **The engine** (`engine/`) starts headless `claude -p` processes with an argument array (never a shell) and
  passes prompts over stdin. It writes only inside `<project>/.company/` and `~/.claude/company/state/`.

## Trust boundaries

- `.company/org.json` may arrive with a cloned repository and becomes part of the CEO's and managers' prompts.
  Custom (inline) roles in it always run as `general-purpose`, never as an agent the file names, and their title
  and charter are length-limited. Review an `org.json` you did not write before the first run in that project.
- Task ids from the CEO's plan and run ids from the command line are checked against a safe pattern before
  they are used in paths.
- Background managers use `permissionMode: acceptEdits`, so shell commands outside your Claude Code
  allow-list are refused.

## In scope

Anything that makes the plugin read, write or run something outside the above, or lets the contents of
`.company/` files, `installed_plugins.json` or a plan steer it into doing so.
