# Publishing is blocked

This repository is private and unpublished. `package.json` has `private: true`.
`prepublishOnly`, `preversion`, `version`, `alpha`, and `release` all exit with
a failure. No workflow publishes a package or creates a release.

Do not enable publishing until a fresh production release review gives an
affirmative GO. The review must confirm every P0/P1 item, deterministic race and
oracle coverage, packed clean-consumer codegen/query/mutation, genuine
two-client reactivity, and the 100,000-row live-write benchmark.

After that approval, the first permitted artifact is `0.1.0-alpha.1` on the
`alpha` dist-tag. A limited non-authoritative Ente integration must precede any
production-authoritative use.

The eventual release gate is mandatory:

```sh
npm ci
npm run format
npm run lint
npm run typecheck
npm test
npm run test:race
npm run test:coverage
npm run build
npm run test:consumer
npm run test:scale
```

Do not describe a skipped or failing command as passing. Do not publish directly
with `npm publish`; release automation must fail closed unless every required
check has a recorded successful run and the review approval is linked.
