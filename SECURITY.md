# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's
**Report a vulnerability** button on the repository's Security tab
(Security > Advisories > Report a vulnerability). Include the plugin version,
your operating system, and the steps to reproduce.

Do not include real credentials, tokens or personal data in a report.

## What to expect

This is a small, independently maintained project. Reports are read on a
best-effort basis and there is no guaranteed response time. Confirmed problems
are fixed in a new patch version; released versions and their tags are never
rewritten.

## Scope

In scope: the plugin files in `plugin-dist/`, including its hooks and the
guards that screen shell commands and migrations.

The guards are safety nets with documented limits (see the README). A command
that evades a guard is a useful report, but the guards are not a security
boundary and should not replace review of destructive operations.

Out of scope: vulnerabilities in Claude Code itself, in third-party MCP servers
named in the catalog, or in services the plugin can be configured to connect to.
Report those to their owners.
