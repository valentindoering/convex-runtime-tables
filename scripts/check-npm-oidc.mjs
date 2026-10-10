import assert from "node:assert/strict";

// Exercise the real npm token exchange without publishing or saving tokens.
// https://api-docs.npmjs.com/#tag/OIDC
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(
  process.env.GITHUB_REPOSITORY,
  "valentindoering/convex-runtime-tables",
);
assert.equal(process.env.GITHUB_REF, "refs/heads/main");
assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
const request = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
assert.equal(request.protocol, "https:");
request.searchParams.set("audience", "npm:registry.npmjs.org");
const identity = await fetch(request, {
  headers: {
    Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
  },
  signal: AbortSignal.timeout(30_000),
});
assert.equal(identity.status, 200, "GitHub must issue the npm OIDC identity");
const { value } = await identity.json();
assert.ok(value, "GitHub response must contain an identity token");
const exchange = await fetch(
  "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/convex-runtime-tables",
  {
    method: "POST",
    headers: { Authorization: `Bearer ${value}` },
    signal: AbortSignal.timeout(30_000),
  },
);
assert.equal(exchange.status, 201, "npm must accept this trusted publisher");
const credential = await exchange.json();
const { token, token_type, expires } = credential;
console.log(
  JSON.stringify({
    responseFields: Object.keys(credential),
    token_type,
    expires,
    created: credential.created,
    currentTime: new Date().toISOString(),
  }),
);
assert.equal(token_type, "oidc");
assert.ok(token, "npm response must contain a package-scoped token");
assert.ok(Date.parse(expires) > Date.now(), "npm token must be unexpired");
console.log(
  "npm accepted GitHub OIDC for convex-runtime-tables; token discarded",
);
