# OSS Release Guide

Use this when you want to publish a meaningful open-source release. You do not need to do this for every commit or every push.

## Recommended Rhythm

- Commit and push normally as you build.
- Keep `CHANGELOG.md` updated under `Unreleased` for OSS-facing changes.
- Cut a release when the OSS mirror has a meaningful milestone worth announcing.

## Before You Release

1. Make sure the important OSS-facing changes are summarized in `CHANGELOG.md`.
2. Sync the private repo to the OSS repo.
3. Verify the OSS repo is clean and tests pass.
4. Choose the next version, usually in `0.x` for now.

Example versions:

- `v0.1.0` for a new milestone or meaningful bundle of features
- `v0.1.1` for a bug-fix release
- `v0.2.0` for the next larger milestone

## Suggested Workflow

From this private repo:

```bash
npm run sync:oss
```

Then in the OSS repo:

```bash
cd /Volumes/T7/Projects/claudepaw-oss
git status
npm test
```

If everything looks good:

1. Move the `Unreleased` notes in `CHANGELOG.md` into a versioned heading like `## v0.1.0 - 2026-04-08`.
2. Commit that release prep in the OSS repo.
3. Create an annotated tag:

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

4. In GitHub, create a Release from tag `v0.1.0`.
5. Paste the same changelog summary into the GitHub Release notes.

## Agent Behavior

Coding agents should:

- update `CHANGELOG.md` for notable OSS-facing changes
- avoid choosing a version number unless asked
- avoid creating tags or GitHub Releases unless asked
- ask when a release boundary or version number is unclear

## Keep It Light

Early open-source projects usually do best with simple, irregular releases. Weekly or milestone-based releases are normal. Daily commits are normal too.
