import assert from "node:assert/strict";

// npm creates latest during the first publication even with --tag alpha.
// Freeze that registry-created baseline; later alphas must never promote it.
// https://github.com/npm/cli/issues/8490
export const initialAlpha = Object.freeze({
  version: "0.1.0-alpha.1",
  publishedCommit: "23baf0b01586177b940b1e9543cf672cf186468d",
  sha256: "ad158c34757d5829959b2b7ffb391fbf501482fd88ccb081ce0be0e219a38fa6",
  integrity:
    "sha512-jXsZe3QHU/h23+oi9YrV4P19xts/CnEGioEctUisKLpYsEl11wPwSAiDCpgWaml95hRpvyHppaHhms/IfVDBTA==",
});

export function checkAlphaTags(metadata, version) {
  assert.match(version, /^0\.1\.0-alpha\.[1-9]\d*$/);
  assert.equal(
    metadata["dist-tags"].alpha,
    version,
    "alpha must point to the inspected release",
  );
  const latest = metadata["dist-tags"].latest;
  if (latest === undefined) return "absent";
  assert.equal(
    latest,
    initialAlpha.version,
    "An alpha release must not move latest beyond npm's first-publication baseline",
  );
  assert.equal(
    metadata.versions[initialAlpha.version]?.dist?.integrity,
    initialAlpha.integrity,
    "The latest baseline must retain the reviewed first alpha's integrity",
  );
  return "npm-first-publication-baseline";
}
