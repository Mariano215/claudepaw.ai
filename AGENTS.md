# Agent Instructions

These instructions are for coding agents working in this repository.

The release-note guidance below is for the open-source mirror and OSS-facing changes. It does not require a release note for every private operational change, local deploy, or day-to-day internal iteration.

## Release Notes

- Keep [`CHANGELOG.md`](./CHANGELOG.md) up to date for notable user-facing changes when a task materially changes product behavior, setup, UX, reliability, or contributor workflow.
- Add entries under `## Unreleased` using concise bullets in `Added`, `Changed`, `Fixed`, or `Removed`.
- Do not add changelog entries for tiny internal-only edits unless the user asks for exhaustive tracking.
- When a change is private-only or will not ship to the OSS mirror, skip the changelog unless the user asks otherwise.

## Release Boundaries

- Do not create a version tag, GitHub Release, or bump package versions unless the user explicitly asks.
- If a task looks release-worthy but no version was requested, update `CHANGELOG.md` and tell the user a release can be cut later.
- If the right version number is ambiguous, ask before choosing it.

## Default Versioning Guidance

- Prefer `0.x` versions while the project is moving quickly and interfaces are still changing.
- Treat release notes as user-facing summaries, not commit logs.
