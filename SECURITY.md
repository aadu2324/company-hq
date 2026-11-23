# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/aadu2324/company-hq/security/advisories/new)
rather than in a public issue. You can expect a first reply within a week.

## Scope

The mod reads files under the current project's `.company/` folder and `~/.claude/company/catalog.json`,
and runs `node ~/.claude/company/hq/bin/hq.js` with fixed arguments when you use an `/hq` command. A report
that shows it reading or running anything else, or being steered by the contents of those files into doing
so, is in scope.
