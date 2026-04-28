# Version Upgrade Guide

This is a short checklist for bumping the SiYuan Agent release version.

## Required files

- `plugin.json`: update `version`. If the release changes user-facing capabilities, also review `description`, `displayName`, `keywords`, and `minAppVersion`.
- `package.json`: update `version`. If dependencies changed, make sure the dependency list is intentional.
- `package-lock.json`: update the root `version` and `packages[""].version`. Prefer letting `npm install` or `npm version --no-git-tag-version` keep this file consistent.
- `CHANGELOG.md`: add a new section at the top. Keep English first; add a short Chinese translation when the release is user-facing.

## Recommended files

- `README.md`: update English feature, configuration, and usage notes.
- `README_zh_CN.md`: update the Chinese version with the same user-visible changes.
- `.ai/*`: add or update investigation notes when the release fixes a bug or documents a technical decision.

## Validation

Run these before publishing:

```bash
npm run build
npx vitest run
```

`npm run build` regenerates `dist/` and `package.zip`. Check the build output for unexpected errors; existing Webpack size warnings are acceptable unless the bundle changed significantly.

## Release notes

For each release, include:

- User-facing additions or behavior changes.
- Bug fixes, with issue links when available.
- Development-only changes that explain why dependencies or build output changed.
