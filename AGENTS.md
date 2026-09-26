<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`example/convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Codex worktrees

The checked-in environment runs `npm ci` and starts this worktree's isolated
local Convex and showcase. Use `node scripts/worktree-dev.mjs status` for its
URL, `start` to reuse it, and `stop` to stop only its processes. Runtime
configuration and logs stay ignored.
