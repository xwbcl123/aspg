# ADR 0001 — Profile Foundation Is Read-Only and Mixed-Mode

Status: accepted for Foundation MVP

## Context

Projects need portable Skill intent across macOS and Linux without assuming that
every Vault has the same Git, cloud-sync, or symlink behavior. Multiple active
agent sessions may also share one project runtime, so hot-switching
`.agents/skills` is unsafe.

## Decision

- Keep a stable project Core.
- Resolve task-specific catalog Skills on demand.
- Represent project intent in a portable manifest and lock.
- Keep device roots and install backends in a machine-local device registry.
- Support `project-local`, `managed-link`, `managed-materialized`,
  `catalog-only`, and `runtime-native` ownership modes.
- Make `aspg profile plan` deterministic and read-only.
- Do not implement `profile apply` in this MVP.
- Do not acquire or modify the activation lock during planning.
- Keep Plugin installation/exposure outside ASPG Profile planning.

## Consequences

- Life/Drive and Work/Git projects may use different backends under one logical
  Profile.
- A plan can be reviewed and tested before any runtime mutation.
- Production activation remains blocked until a later, separately reviewed
  command implements locking, rollback, and managed-state persistence.

