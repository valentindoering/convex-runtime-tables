# Alpha publishing

The repository is public. `convex-runtime-tables@0.1.0-alpha.1` was published
from commit `23baf0b01586177b940b1e9543cf672cf186468d` on October 10, 2026. Use
the `alpha` distribution tag. Alpha approval does not establish readiness for
authoritative production data.

Follow [the release procedure](docs/npm-release.md). Each new candidate requires
a fresh review, successful CI, and the hosted two-client and 100k live-write
gates for its exact remote-main commit. Previous results cannot certify a new
commit. `scripts/check-release.mjs` and `scripts/publish-alpha.mjs` enforce
these requirements.

The `Publish alpha` GitHub Actions workflow publishes through npm trusted
publishing with OIDC and provenance. It requires the reviewed SHA and a link to
the review evidence. It does not publish automatically on a push or infer a
review approval from a passing test. The `npm-release` environment permits only
`main`; no long-lived npm write token is stored in GitHub.

Do not weaken checks, force-push, assign `latest`, or describe a skipped or
failing gate as passing.
