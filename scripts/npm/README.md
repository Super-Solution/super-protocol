# npm bootstrap (one-time, run by a maintainer)

`bootstrap-npm.mjs` (Windows, macOS, Linux; needs only Node and npm) and `bootstrap-npm.sh` (bash) do the same thing for all 34 `@supersolutions` packages across super-protocol, super-chat, super-router, super-editor and super-chart:

- `placeholders [repo]` publishes an empty `0.0.0` placeholder (tag `placeholder`) for each package that is not on npm yet. npm only lets you configure trust on a package that exists.
- `trust <repo>` adds the GitHub Actions trusted publisher to each package of that repo. Run it on the day you release that repo, because a new trust expires after 2 days without a publish.
- `list [repo]` prints the package table.

```
node scripts/npm/bootstrap-npm.mjs placeholders
node scripts/npm/bootstrap-npm.mjs trust super-protocol
```

Needs npm >= 11.15 and a prior `npm login` with 2FA on (a bypass-2FA token cannot configure trust). `DRY_RUN=1` changes nothing on npm. See `docs/NPM-PUBLISHING.md` for the release steps.
