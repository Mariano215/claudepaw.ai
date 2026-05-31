# Security Policy

## Reporting a Vulnerability

Please do **not** open a public issue or pull request for security vulnerabilities.
Public disclosure of an unpatched flaw puts every user at risk.

Report privately through either channel:

1. **GitHub Private Vulnerability Reporting** (preferred) —
   go to the **Security** tab → **Report a vulnerability**. This opens a private
   advisory thread and lets us collaborate on a fix and CVE in a private fork.
2. **Email** — `mariano215@gmail.com` with subject line `SECURITY: <short summary>`.

### What to include

- A clear description of the issue and its impact
- Steps to reproduce, or a proof-of-concept (source-level analysis is fine)
- Affected component/file and version or commit if known
- Any suggested remediation

If you have a regression test or patch, attach it — but please hold any public
PR until the fix has shipped.

## Our commitment

- **Acknowledgement:** within 3 business days
- **Triage + severity assessment:** within 7 business days
- **Coordinated disclosure:** we aim to release a fix before any public
  disclosure, and will credit you in the advisory unless you prefer otherwise.
  Default coordination window is up to 90 days.

## Scope

In scope: the bot, the dashboard server (`server/`), and the published
open-source mirror. Out of scope: third-party services, social-engineering,
and findings that require already-compromised host access.

## Safe harbor

Good-faith research conducted under this policy — staying within scope, not
exfiltrating data beyond what's needed to demonstrate the issue, and not
degrading service — will not be pursued or reported. Thank you for helping keep
the project and its users safe.
