# Engram System Audit and Hardening

## Objective

Audit Engram end to end across deployed runtime, repository code, and test infrastructure, then continuously execute the highest-value safe verified improvement slices without breaking existing features.

## Original Request

Audit and test infra, existing deployed and code, everything; goal mode; extract anything efficiently possible in the system without breaking any feature; dynamic task creation. Also include `improve-codebase-architecture` as a later skill requirement.

## Intake Summary

- Input shape: `audit`
- Audience: Engram owner/operator and future maintainers
- Authority: `requested`
- Proof type: `test`, `review`, `metric`, `artifact`
- Completion proof: A final Judge or PM audit maps completed receipts to deployed/runtime confidence, test/CI reliability, and product/code correctness; all required Worker tasks are done or explicitly blocked/deferred with receipts; current verification is recorded.
- Likely misfire: GoalBuddy could perform a broad read-only audit or one opportunistic cleanup and stop without proving deployed behavior, verification coverage, or safe follow-through.
- Blind spots considered: deployed Cloudflare state may drift from repo docs; live credentials or production access may be unavailable; broad architecture improvements can accidentally break feature behavior; test commands may be expensive or flaky; named skills must be scheduled for the execution run, not loaded during prep.
- Existing plan facts: Use a local live visual board. Cover runtime/deploy confidence, test/CI reliability, and product/code correctness. Proceed without further intake. Record `improve-codebase-architecture` for the later `/goal` run.

## Goal Kind

`audit`

## Current Tranche

Discover the current truth of Engram's repo, tests, and deployed surfaces; identify efficient safe improvements; execute successive bounded Worker slices that preserve existing behavior; verify each slice; and keep advancing until a final audit proves the original broad outcome is complete or records concrete blockers.

## Non-Negotiable Constraints

- Follow all AGENTS.md instructions in this repo, especially accepting concurrent outside changes without reverting them.
- Do not break existing deployed or local features.
- Do not commit secrets. Cloudflare credentials, if needed, must come from existing ignored local configuration.
- Start with read-only evidence gathering before implementation.
- Treat live production or destructive operations as requiring explicit approval; staging/read-only checks may proceed when credentials and repo scripts support them.
- Preserve user intent for dynamic task creation: Scouts and Judges should spawn concrete follow-up tasks when they find efficient safe work.
- During the later `/goal` run, load/use `improve-codebase-architecture` only when the active task calls for architecture improvement analysis.

## Stop Rule

Stop only when a final audit proves the full original outcome is complete.

Do not stop after planning, discovery, or Judge selection if a safe Worker task can be activated.

Do not stop after a single verified Worker slice when the broader owner outcome still has safe local follow-up slices. After each slice audit, advance the board to the next highest-leverage safe Worker task and continue.

Do not stop because a slice needs owner input, credentials, production access, destructive operations, or policy decisions. Mark that exact slice blocked with a receipt, create the smallest safe follow-up or workaround task, and continue all local, non-destructive work that can still move the goal toward the full outcome.

## Canonical Board

Machine truth lives at:

`docs/goals/engram-system-audit-hardening/state.yaml`

If this charter and `state.yaml` disagree, `state.yaml` wins for task status, active task, receipts, verification freshness, and completion truth.

## Run Command

```text
/goal Follow docs/goals/engram-system-audit-hardening/goal.md.
```

## PM Loop

On every `/goal` continuation:

1. Read this charter.
2. Read `state.yaml`.
3. Run the bundled GoalBuddy update checker when available and mention a newer version without blocking.
4. Re-check the intake: original request, input shape, authority, proof, blind spots, existing plan facts, and likely misfire.
5. Work only on the active board task.
6. Assign Scout, Judge, Worker, or PM according to the task.
7. Write a compact task receipt.
8. Update the board.
9. If Judge selected a safe Worker task with `allowed_files`, `verify`, and `stop_if`, activate it and continue unless blocked.
10. If a problem, suggestion, or follow-up should become a repo artifact, create an approved issue/PR or ask the operator whether to create one.
11. Treat a slice audit as a checkpoint, not completion, unless it explicitly proves the full original outcome is complete.
12. Finish only with a Judge/PM audit receipt that maps receipts and verification back to the original user outcome and records `full_outcome_complete: true`.

Issue and PR handoffs are supporting artifacts. `state.yaml` remains authoritative, and every external artifact decision must be recorded in a task receipt.
