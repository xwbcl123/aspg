# ASPG Implement Review

Date: 2026-03-10
Reviewer: OpenCode
Scope: native vendor de-dup MVP (`codex` / `opencode` as native, `claude` as bridge)

## Verdict

The implementation is in good shape and is broadly aligned with the PRD.

- `npm test` passed: 45 / 45
- `npm run build` passed
- `src/vendors.ts` now acts as the vendor topology SSOT
- `init` and `apply` only operate on bridge vendors
- `doctor` and `clean` correctly understand native-vendor legacy bridge scenarios

I would classify the current state as:

`ready to merge after one small fix`

## What Looks Good

### 1. Topology ownership is now centralized

`src/vendors.ts` is the right abstraction boundary for:

- `SSOT_DIR`
- vendor classification
- bridge/native filtering helpers

This is the most important architectural improvement in the patch.

### 2. Command behavior now matches the intended MVP

- `src/commands/init.ts` only creates bridge vendor links
- `src/commands/apply.ts` only refreshes bridge vendor links
- `src/commands/doctor.ts` distinguishes native-vendor redundant bridges from real bridge health
- `src/commands/clean.ts` traverses all vendors but only removes ASPG-managed bridge artifacts

This is consistent with the PRD direction: fix the default topology first, postpone config.

### 3. Test coverage is materially better

The new tests cover the right areas:

- vendor registry behavior
- native-vendor duplicate discovery diagnostics
- clean safety for native legacy bridges
- apply regression guard for native vendors

This meaningfully reduces the chance of reintroducing the original bug.

## Required Fix Before Merge

### `clean --dry-run` currently overstates what will be removed

File:

- `src/commands/clean.ts`

Current behavior:

- In dry-run mode, the code prints `Would remove ...` for any existing vendor path
- But in non-dry-run mode, actual removal only happens if `removeLink()` determines the target is ASPG-managed

Why this matters:

- This creates a behavior mismatch between preview and real execution
- A user with a manual/native vendor directory may see a destructive-looking dry-run message even though the real command would skip it

Recommended fix:

- Make dry-run use the same management test as the real path
- If the target is ASPG-managed, print `Would remove ...`
- If the target exists but is not ASPG-managed, print `Would skip ... not ASPG-managed`

Suggested implementation direction:

- Either introduce a shared helper like `isAspgManagedLink()` in `src/platform.ts`
- Or make `removeLink(linkPath, true)` semantically trustworthy and reuse it in dry-run reporting

Expected UX outcome:

- dry-run becomes a truthful preview rather than an optimistic guess

## Recommended Improvement

### Strengthen the `apply` regression test for native vendors

File:

- `tests/apply.test.ts`

Current test gap:

- The existing stale-state test removes the codex path completely before running `apply`
- That validates “path absent does not get created”
- It does not fully validate the more realistic legacy case: a native vendor bridge artifact still exists, but `apply` must not refresh or recreate it

Why this matters:

- The original bug was about incorrect regeneration of native-vendor bridge directories
- A stronger regression test should exercise a surviving legacy bridge state, not just a missing path

Recommended test addition:

- Precreate a native vendor directory in a realistic ASPG-managed shape
- Then run `apply`
- Assert that `apply` does not refresh it, replace it, or recreate a new managed bridge for that native vendor

Examples of valid fixtures:

- an existing native vendor copy fallback with marker
- an existing native vendor symlink/junction created by ASPG

## Optional Follow-Up Improvement

### Consider testing doctor output contract more explicitly

`tests/doctor.test.ts` is already solid.

If you want to make future CLI UX regressions less likely, consider asserting a few exact output phrases more systematically, especially:

- `duplicate discovery risk`
- `not ASPG-managed`
- the classification block header

This is optional, not a blocker.

## Summary

The implementation is strong overall and correctly solves the core problem:

- native vendors are modeled explicitly
- bridge generation is constrained to bridge vendors
- doctor/clean semantics are much safer than before

The only issue I would fix before merge is:

- `clean --dry-run` preview accuracy

After that, this patch looks ready.
