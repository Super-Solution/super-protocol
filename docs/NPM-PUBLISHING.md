# Publishing to npm

`@supersolutions/super-protocol` (`implementations/typescript`) is released by the manual workflow
**Publish npm package** (`.github/workflows/npm-publish.yml`) with npm Trusted Publishing (OIDC): no
npm token and no repository secret. The repository is public, so every release carries provenance.
Go and Python are not published by this workflow.

## One-time setup (npm maintainer, with account 2FA)

npm only lets you configure a package that already exists, so the first release needs a placeholder
version published by hand. Then, in the package's npm settings (or with
`npm trust github @supersolutions/super-protocol --file npm-publish.yml --repo Super-Solution/super-protocol --allow-publish`,
npm 11.15 or newer), add a trusted publisher: organization `Super-Solution`, repository
`super-protocol`, workflow filename `npm-publish.yml`, environment empty. Configure it close to the
release: a new configuration expires if it has not completed a publish within two days.

## Releasing

1. Commit the version in `implementations/typescript/package.json` and run `bash scripts/check-all.sh`.
2. Run **Publish npm package** on `main` with that exact version (`X.Y.Z` publishes to `latest`,
   `X.Y.Z-next.N` to `next`).

The workflow checks the manifest, installs the locked dependencies, builds, typechecks and tests,
confirms the conformance data regenerates byte for byte, packs, and publishes with provenance. A
published version cannot be overwritten.

This package must be on npm before `super-editor` and `super-chart` can install (they pin it) and
before `super-chat`'s packages that depend on it resolve for consumers.
