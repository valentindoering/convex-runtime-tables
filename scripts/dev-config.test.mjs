// @vitest-environment node

import { describe, expect, test } from "vitest";
import {
  assertLocalRuntime,
  assertLoopbackUrl,
  deriveRuntimeConfig,
  localDevArgs,
  parseWorktreePaths,
} from "./dev-config.mjs";

describe("local development configuration", () => {
  test("assigns stable, distinct identities and ports to git worktrees", () => {
    const paths = ["/repo/main", "/repo/worktrees/feature"];
    const common = "/repo/main/.git";
    const first = deriveRuntimeConfig({
      repository: paths[0],
      commonGitDir: common,
      branch: "main",
      worktreePaths: paths,
    });
    const repeated = deriveRuntimeConfig({
      repository: paths[0],
      commonGitDir: common,
      branch: "main",
      worktreePaths: [...paths].reverse(),
    });
    const feature = deriveRuntimeConfig({
      repository: paths[1],
      commonGitDir: common,
      branch: "codex/showcase",
      worktreePaths: paths,
    });

    expect(repeated).toEqual(first);
    expect(feature.instanceName).not.toBe(first.instanceName);
    expect(
      new Set([...Object.values(first.ports), ...Object.values(feature.ports)])
        .size,
    ).toBe(6);
    expect(feature.deployment).toBe(`anonymous:${feature.instanceName}`);
  });

  test("parses worktree porcelain output", () => {
    expect(
      parseWorktreePaths(
        "worktree /repo/main\nHEAD abc\n\nworktree /repo/wt\nHEAD def\n",
      ),
    ).toEqual(["/repo/main", "/repo/wt"]);
  });

  test.each([
    "https://example.com",
    "http://192.168.1.2:3210",
    "ws://127.0.0.1:3210",
    "http://user:password@127.0.0.1:3210",
  ])("rejects non-local target %s", (target) => {
    expect(() => assertLoopbackUrl("test", target)).toThrow(/Refusing/);
  });

  test("rejects a cloud deployment even with loopback URLs", () => {
    expect(() =>
      assertLocalRuntime({
        deployment: "dev:cloud-name",
        instanceName: "cloud-name",
        convexUrl: "http://127.0.0.1:3210",
        siteUrl: "http://127.0.0.1:3211",
        showcaseUrl: "http://127.0.0.1:5173/",
      }),
    ).toThrow(/non-anonymous/);
  });

  test("uses explicit --local only on Convex CLIs that support it", () => {
    const options = {
      envFile: "/repo/.convex/worktree.env.local",
      ports: { convex: 3210, site: 3211 },
      once: true,
    };
    expect(localDevArgs({ ...options, version: "1.40.3" })).toContain(
      "--local",
    );
    expect(localDevArgs({ ...options, version: "1.45.0" })).not.toContain(
      "--local",
    );
  });
});
