# First npm release

Prepared name/version: `convex-runtime-tables@0.1.0-alpha.1`. Distribution tag:
`alpha`. The GitHub repository can stay private; the npm tarball will disclose
the source and generated code included in its file list. Package publication and
permission to use authoritative production data are separate decisions.

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

## Remaining release gates

1. Restore a valid `CONVEX_DEPLOY_KEY` GitHub Actions secret for the isolated
   development test deployment and check the matching `CONVEX_TEST_URL`
   variable. Do not point these tests at the showcase production deployment or
   Ente.
2. Run CI and the manual nightly workflow on the committed release candidate.
   Require the packed-consumer subscription, 100k live-write oracles, and exact
   cleanup to pass. Link both logs in release evidence.
3. Complete the fresh production release review requested in the original
   hardening brief. No affirmative review is recorded in this checkout.
4. Authenticate the intended npm publisher with `npm login`, or configure npm
   trusted publishing. The September 22 authentication check returned E401.

## Publish after the gates pass

In a reviewed release-enablement change, remove `private: true` and replace the
blocking lifecycle scripts and corresponding CI assertion with enforced release
checks. Configure `publishConfig` with public access, `alpha` tag, and the npm
registry. Do not bypass the current blocker with `--ignore-scripts` to publish.
Commit that change and rerun the gates for the final commit before packing
again.

Inspect the final tarball and its manifest, then publish that exact artifact
with `npm publish <tarball> --access public --tag alpha`. Verify the registry
version, integrity, and dist-tag, then install the published version into a
clean consumer and run the query, mutation, and subscription smoke tests.

Do not assign `latest` or describe the alpha as production-authoritative before
the release review and limited non-authoritative integration have passed.
