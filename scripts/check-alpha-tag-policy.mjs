import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAlphaTags, initialAlpha } from "./alpha-tag-policy.mjs";

const metadata = (
  alpha,
  latest = initialAlpha.version,
  integrity = initialAlpha.integrity,
) => ({
  "dist-tags": { alpha, ...(latest === undefined ? {} : { latest }) },
  versions: { [initialAlpha.version]: { dist: { integrity } } },
});

test("the first alpha accepts only its reviewed npm-created baseline", () => {
  assert.equal(
    checkAlphaTags(metadata(initialAlpha.version), initialAlpha.version),
    "npm-first-publication-baseline",
  );
  assert.throws(() =>
    checkAlphaTags(
      metadata(initialAlpha.version, initialAlpha.version, "sha512-changed"),
      initialAlpha.version,
    ),
  );
});

test("later alphas preserve latest at the first alpha", () => {
  assert.equal(
    checkAlphaTags(metadata("0.1.0-alpha.2"), "0.1.0-alpha.2"),
    "npm-first-publication-baseline",
  );
  for (const latest of ["0.1.0-alpha.2", "0.1.0", "0.0.0-stage"]) {
    assert.throws(() =>
      checkAlphaTags(metadata("0.1.0-alpha.2", latest), "0.1.0-alpha.2"),
    );
  }
});

test("a registry without latest is accepted", () => {
  const value = metadata("0.1.0-alpha.2");
  delete value["dist-tags"].latest;
  assert.equal(checkAlphaTags(value, "0.1.0-alpha.2"), "absent");
});

test("missing or incorrect alpha and non-alpha releases fail", () => {
  assert.throws(() =>
    checkAlphaTags(metadata(undefined), initialAlpha.version),
  );
  assert.throws(() =>
    checkAlphaTags(metadata("0.1.0-alpha.2"), initialAlpha.version),
  );
  assert.throws(() => checkAlphaTags(metadata("0.1.0"), "0.1.0"));
});
