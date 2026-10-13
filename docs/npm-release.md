# npm alpha releases

Prepared name/version: `convex-runtime-tables@0.1.0-alpha.1`. Distribution tag:
`alpha`. The GitHub repository must be public before publication; the npm
tarball discloses the source and generated code included in its file list.
Package publication and permission to use authoritative production data are
separate decisions.

## Prepare and inspect

```sh
npm ci
npm run format
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run check:codegen
npm run test:race
npm run test:consumer
npm run release:prepare
```

`release:prepare` builds the component and packs it into `.release/`. It checks
that every export and required manual is present and rejects test modules,
environment files, example code, scripts, and dependency directories. The JSON
manifest records SHA-256, npm integrity, file list, source commit, and any dirty
working-tree state. This is package inspection, not a substitute for the clean
consumer or hosted gates. No preparation command publishes the package.

## Required release gates

1. Restore a valid `CONVEX_DEPLOY_KEY` GitHub Actions secret for the isolated
   development test deployment and check the matching `CONVEX_TEST_URL`
   variable. Do not point these tests at the showcase production deployment or
   Ente.
2. Run CI and the manual nightly workflow on the committed release candidate.
   Require the packed-consumer subscription, 100k live-write oracles, and exact
   cleanup to pass. Link both logs in release evidence.
3. Complete a fresh release review of the exact candidate. Do not claim a
   prerelease approval establishes production-authoritative readiness.
4. Record the approved full commit SHA and a link to the release review. The
   publisher is the repository's `release.yml` workflow through npm OIDC.

## Publish after the gates pass

The guarded release command verifies the alpha manifest, a clean checkout,
public GitHub visibility, exact remote-main SHA, and successful CI plus hosted
workflow runs for that SHA. It also requires `CRT_RELEASE_REVIEW_SHA` to equal
the commit explicitly approved by the release reviewer. Commit all candidate
changes before running the gates. Do not bypass the guard with
`--ignore-scripts`.

Inspect the candidate tarball and manifest, then run
`CRT_RELEASE_REVIEW_SHA=<approved-full-commit-sha> npm run alpha`. This
rebuilds, packs, verifies the artifact hash and publishes that exact tarball
under `alpha` with public access. Verify the registry version, integrity, and
dist-tag, then install the published version into a clean consumer and run the
query, mutation, and subscription smoke tests.

## CI publishing

Dispatch `release.yml` on `main` after completing the fresh review and both
workflows for the candidate:

```sh
gh workflow run release.yml --ref main \
  -f operation=publish \
  -f reviewed_sha=<approved-full-commit-sha> \
  -f review_url=<https-link-to-release-review>
```

The workflow rejects an absent or different reviewed SHA. It runs the existing
release guard and guarded publisher, verifies registry tags and tarball hashes,
and installs the published version into the two-client consumer. npm provenance
is enabled for this path. Do not set `NODE_AUTH_TOKEN` or add an `NPM_TOKEN`
secret; npm authenticates using GitHub's short-lived OIDC identity.

The npm trusted publisher is scoped to `valentindoering/convex-runtime-tables`,
workflow filename `release.yml`, and environment `npm-release`. The GitHub
environment restricts deployment branches to `main`. Configure it once using
`npm trust github convex-runtime-tables --repo valentindoering/convex-runtime-tables --file release.yml --env npm-release --allow-publish --yes`;
npm requires the maintainer's security key for this setup. Subsequent CI
publications require no interactive npm login. See
[npm's trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/).

To check the trust configuration without publishing, dispatch
`gh workflow run release.yml --ref main -f operation=check-auth`. This exercises
the real GitHub-to-npm token exchange and discards the token. It does not run
the release gates and cannot certify a package candidate.

To verify the already published package without publishing again, run
`gh workflow run release.yml --ref main -f operation=verify-existing`. It checks
the registry tarball, tags, integrity, clean installation, codegen and
two-client reactivity. It saves verification evidence and cannot publish or
approve a new candidate. The report distinguishes the inspected checkout from
the original published commit.

## npm first-publication tag behavior

npm assigns `latest` on a package's first publication even with `--tag alpha`. A
matching [npm issue](https://github.com/npm/cli/issues/8490) reports the same
HTTP 400 on removal. This package's removal attempts failed with both
interactive 2FA and authenticated OIDC, including the October 13 retry.
Authentication is working; additional login attempts do not resolve the tag
rejection.

The registry policy therefore allows either no `latest` tag or the exact
`0.1.0-alpha.1` baseline with its reviewed integrity. Later alpha releases must
keep `latest` at that first version; pointing it at another alpha, a stable
version, or a placeholder fails verification. All releases still require `alpha`
to point to the inspected candidate and its tarball hashes to match. Promotion
to stable requires a separate release decision and policy change. An unversioned
install resolves to npm's initial alpha; applications must pin an exact alpha
version.

Never republish an existing version. Advance the alpha version and changelog,
then rerun CI, hosted gates, and review for the resulting main commit.

Do not promote `latest` or describe the alpha as production-authoritative before
the separate stable release review and limited non-authoritative integration
have passed.
