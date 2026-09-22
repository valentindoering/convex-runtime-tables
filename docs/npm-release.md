# First npm release

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
4. Recheck the intended npm publisher immediately before publication. The latest
   September 22 check succeeded as `valentindoering`; the package name returned
   E404 and has not been published.

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

Do not assign `latest` or describe the alpha as production-authoritative before
the release review and limited non-authoritative integration have passed.
