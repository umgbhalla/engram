# RLM substrate topic sweep

## Goal
Map RLM implementations by execution substrate usage, with emphasis on what runtime,
state, sandboxing, broker, checkpoint, and fork-like features are actually used.

## Success Criteria
- Discover repositories under the GitHub recursive-language-models topic plus the
  previously named RLM repos.
- Clone or refresh the relevant repositories into a scratch research directory.
- Inspect source files that implement execution, sandboxing, persistence, or
  recursive subcall plumbing.
- Produce a concise substrate matrix and identify which substrate features are
  common, rare, absent, and potentially differentiating for Engram.

## Current Context
The user wants substrate analysis, not RLM algorithm/design explanation. Repo-local
Engram docs already contain an earlier RLM execution-environment survey; this pass
extends it with GitHub topic coverage.

## Constraints
- Research-only: no deploys, no code changes to Engram runtime.
- Avoid speculative claims; mark shallowly inspected repos as such.
- Keep cloned third-party repositories outside the Engram worktree.

## Risks
- Topic repos vary in quality and may be demos or unrelated despite tags.
- Some repos may be unavailable, large, or require dependencies to inspect deeply.

## Approval Required
No approval required for public read-only clone/inspect operations into /tmp.

## Work Packets
- Packet A: enumerate topic repos through GitHub and clone/fetch them.
- Packet B: inspect canonical and high-signal implementations for substrate code.
- Packet C: inspect topic-tail repos enough to classify substrate usage.
- Packet D: integrate into a substrate feature matrix and Engram implications.

## Integration Policy
Prefer direct code evidence over README claims. If a repo is only shallowly checked,
label it as topic-derived or low-confidence.

## Verification
- Verify clone coverage against the GitHub topic API result.
- Verify classifications with grep/source-file evidence for executor, sandbox,
  persistence, broker, and timeout paths.

## Reusable Artifacts
The final report can become a reusable RLM substrate landscape note if useful.
