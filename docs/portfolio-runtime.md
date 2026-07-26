# ASPG Portfolio Runtime

Status: Wave 6 implementation workspace; fixture-only; not released.

This document describes the runtime projection contract implemented after the
Portfolio Manifest and Lock were frozen. It is deliberately narrower than a
production runbook:

- Device Registry v2 is now an active read path, while v1 remains compatible.
- Runtime mutation primitives exist only for isolated fixtures below
  `$TMPDIR`.
- The unreleased worktree CLI now exposes fixture-only `portfolio apply`,
  `refresh`, `doctor`, `bootstrap-device-state`, `repair` and `rollback`
  commands. Every mutating command requires an explicit `$TMPDIR` fixture
  root; none is authorized for a real project.
- The globally installed `aspg` v0.3.0 predates this Wave 6 work. It must not
  be treated as evidence that the runtime implementation is installed.
- Wave 7 migration of Life-OS, Work-PKM, or any other real project remains
  separately gated and is not authorized.

## 1. Authority and boundaries

The Portfolio is the cross-project revision authority:

| Artifact | Role | Portability |
|---|---|---|
| Portfolio Manifest | Desired Skills, Profiles, deployments and dependency scope | Git-controlled, no absolute paths |
| Portfolio Lock | Exact source revision, path, tree hash and executable manifest | Git-controlled, no absolute paths |
| Project binding | Binds one project to a Portfolio revision and deployment | Project-controlled |
| Portable deployment state | Generation, ownership and deployed content identity | Project-controlled and syncable |
| Device Registry | Absolute source, state and runtime roots; provider/backend policy | Device-local, never committed |
| Activation journal, lock and snapshot | In-flight operation and byte-level recovery evidence | Device-local, never synchronized |

The current module boundary is:

| Module | Responsibility | Explicit non-responsibility |
|---|---|---|
| `portfolio-control.ts` | Read Manifest/Lock/Registry, validate, resolve runtime roots and plan | Runtime mutation |
| `deployment-state.ts` | Deterministic portable state and managed-link inspection | Lock parsing, materialization, rollback, CLI |
| `provider-preflight.ts` | Bounded provider readiness classification | Provider restart, path-name inference, recursive target scan |
| `provider-materialize.ts` | Fixture-only pinned-tree staging, verification and atomic batch activation | Portfolio orchestration, project discovery |
| `activation-journal.ts` | Device-local lock, generation, phase journal, snapshot and rollback | Portable ownership state |

All mutating modules require an explicit fixture root that resolves to a proper
child of the operating-system temporary directory. They reject a real project,
an implicit current working directory, a filesystem root, a path escape and a
symlink-parent escape.

## 2. Device Registry v2 is an active reader

Version 2 replaces device-wide project/backend assumptions with
runtime-root-scoped policy:

```yaml
version: 2
devices:
  fixture-device:
    platform: darwin
    state_root: /tmp/fixture/device-state/aspg
    source_roots:
      external: /tmp/fixture/sources/third-party
      private: /tmp/fixture/sources/private-skills
    runtime_roots:
      drive-agents:
        project_ref: drive-project
        path: /tmp/fixture/projects/drive/.agents/skills
        storage_provider: google-drive-file-provider
        deployment_backend: managed-materialized
      local-agents:
        project_ref: local-project
        path: /tmp/fixture/projects/local/.agents/skills
        storage_provider: local-filesystem
        deployment_backend: managed-link
```

For every v2 runtime root:

1. `project_ref` selects the deployment project.
2. `path` is the exact exposure root. A Skill target is
   `<runtime_root.path>/<exposure_name>`; ASPG must not append another
   `.agents/skills`.
3. `storage_provider` describes the configured provider. It is not inferred
   from a path substring.
4. `deployment_backend` is selected for that runtime root, not for the whole
   device or project.

Consequently, one device can plan:

- Google Drive/File Provider → `managed-materialized` → `materialize`;
- local Darwin/Linux filesystem → `managed-link` → `symlink`.

Registry v1 remains readable. Its `project_roots` and device-wide `backends`
retain legacy planning behavior. A v1-to-v2 migration cannot safely guess
provider policy, so the deterministic migrator leaves `runtime_roots` empty
until an operator explicitly supplies them.

All configured v2 `state_root`, `source_roots` and `runtime_roots` must be
normalized absolute paths and must not overlap. The control plane additionally
resolves project/source identity through `realpath`; the activation lock always
resolves below the separate device `state_root`.

## 3. Backend selection is explicit

Backend selection is policy, not error recovery:

```text
locked canonical subtree
        |
        +-- local runtime root  -> managed-link / symlink
        |
        +-- Drive runtime root  -> managed-materialized / physical copy
```

There is no silent symlink-to-copy fallback. A Google Drive runtime configured
as `managed-link` is a policy conflict, not permission to copy. Conversely, a
materialized target is never treated as a managed link merely because the
canonical Skill declares link ownership.

The planner and target health evaluator must use the same effective,
runtime-root-scoped backend. A plan that says `materialize` but later evaluates
the resulting real directory as a link collision is invalid integration
behavior and must fail its regression gate.

## 4. Managed links have no per-link sidecar

Managed-link ownership belongs to the portable deployment state. ASPG does not
create `*.aspg-managed-link.json` beside runtime Skills.

A link is considered owned only when:

- the portable state records the exposure and locked content identity;
- the filesystem target is a symbolic link;
- the resolved link target exactly equals the caller-resolved canonical source;
- the resolved subtree hash and executable manifest equal the expected digest.

Inspection is read-only. It never repairs, replaces or deletes the target.
Foreign links, broken links, plain files, real directories, missing sources and
hash/mode drift fail closed. A required dependency in any such state blocks the
owning Skill from being considered healthy.

Portable state writes are canonical and deterministic. Creation begins at
generation 1; an update must name the current expected generation and advance
exactly by one. The writer uses a unique sibling temporary file, `fsync` and
atomic rename, and refuses invalid or unmanaged state targets.

The integration layer owns the normative project placement:

```text
<project>/.aspg/deployments/<deployment>/state.yaml
```

The current low-level writer serializes canonical JSON-compatible bytes and
accepts only a caller-provided path below the fixture project's `.aspg/`.
Choosing the final YAML adapter and committed placement belongs to the
integration layer; it must not weaken generation or path containment.

## 5. Google Drive managed materialization

`managed-materialized` means a managed physical directory copy, not a hard
link. Google Drive may synchronize its bytes to another device, but it does not
automatically follow a newer canonical Git revision.

### Provider preflight

Preflight runs before a recursive source/target scan or staging write:

| Result | Meaning | Mutation |
|---|---|---|
| `ready` | Runtime root is present, hydrated and writable | May continue |
| `offline` | Runtime/provider unavailable | Stop |
| `uncertain` | Hydration or bounded provider observation is inconclusive | Stop |
| `conflict` | Policy, type, writability or provider conflict | Stop |

Google Drive observations are supplied by the caller. The preflight module
does not infer Drive from a pathname, restart the provider, wait without a
bound, or treat cached state as current health.

Materialization then:

1. verifies every item against the exact pinned Git revision;
2. finishes the whole read-only preflight before creating a stage;
3. stages complete sibling directories from Git objects;
4. verifies path, file type, bytes and executable mode;
5. rechecks that every target is unchanged;
6. activates the batch by rename;
7. verifies all activated targets;
8. restores operation-owned backups if partial activation fails.

Existing directories without deployment-state ownership, symlinks and plain
files are never adopted or overwritten. Local content or executable-mode drift
is preserved and blocks refresh.

## 6. Portable state and device journal are separate

Portable state answers “what this project deployment owns”:

- Portfolio/deployment/project identity;
- Lock revision and monotonically increasing generation;
- canonical Skill and exposure identity;
- backend and health;
- source revision, portable source path, tree hash and executable manifest;
- projected required dependencies.

It contains no absolute source path, device ID, process lock, snapshot location
or rollback payload.

The device-local activation journal answers “what this device is doing”:

```text
planned
  -> locked
  -> snapshotted
  -> staged
  -> activated
  -> verified
  -> committed

or -> rolled-back / failed
```

The journal records the operation, device, target root, generation, phase,
snapshot and rollback payload paths. Its lock and payload live below
`state_root`, outside both the project and source roots. Portable generation is
an optimistic compare-and-swap boundary; File Provider synchronization is not
a distributed lock.

A new device never adopts a synchronized portable generation implicitly.
`portfolio bootstrap-device-state` is the explicit reconciliation gate: it
requires an existing portable state, verifies project/deployment identity,
refuses active locks, non-terminal journals, downgrade, forward conflict and
missing audit evidence, then writes only the device-local generation claim.
Its `--dry-run` path performs zero writes. After bootstrap, the next refresh
must still pass the normal compare-and-swap, provider and target checks.

An interrupted operation is classified conservatively:

- no mutation evidence → no action or safe resume;
- snapshot plus possible target mutation → rollback;
- missing/tampered journal, owner, snapshot or payload → fail closed.

## 7. Runtime health vocabulary

The shared runtime contract freezes exactly 13 states:

| Health | Meaning |
|---|---|
| `in-sync` | Target identity, content and executable mode match |
| `refresh-available` | Owned deployed bytes are unchanged; Lock has newer content |
| `local-drift` | Observed content differs from deployed identity |
| `missing` | An owned target is absent |
| `unmanaged-copy` | A real directory exists without matching ownership |
| `source-unavailable` | Pinned canonical source cannot be resolved |
| `provider-offline` | Configured provider/runtime is unavailable |
| `provider-uncertain` | Bounded provider readiness cannot be established |
| `provider-conflict` | Provider or generation conflict requires reconciliation |
| `mode-drift` | Executable manifest differs |
| `transition-incomplete` | Journaled mutation did not reach a terminal state |
| `derived-content` | Content matches an explicit runtime-derived denylist |
| `unmanaged-content` | Untracked content is neither locked nor explicitly derived |

Individual primitives return only the subset they can prove. The integration
layer maps provider, ownership, dependency and journal evidence into this
shared vocabulary. It must never collapse an unknown or blocking condition
into `in-sync`.

## 8. Operation semantics

### Apply

`apply` creates a missing selected target only after validation, provider
preflight, activation lock and snapshot gates pass. It batches the Skill,
required dependency packs and generated configuration as one operation. An
unmanaged target, missing required source or dependency failure blocks the
batch with no portable-state commit.

### Refresh

`refresh` advances an owned target to a newer Lock only when the observed
target still equals its recorded deployed identity. It stages the entire new
tree, rechecks generation/content immediately before activation, swaps instead
of merging file by file, verifies the complete batch and only then commits the
next portable generation.

Local drift, executable-mode drift, unmanaged content, provider uncertainty or
a concurrent generation change blocks refresh without discarding bytes.

### Repair

`repair` is restricted to a missing ASPG-owned target or a recoverable
interrupted transition. It reconstructs from the locked source after provider
and journal checks. It is not permission to overwrite a foreign link,
unmanaged directory/file or locally modified target.

### Rollback

`rollback` restores a previously captured non-empty snapshot and records a
terminal journal phase. Rollback payloads remain device-local. Rollback is
idempotent after success and fails closed when its payload path, manifest,
generation or ownership evidence is inconsistent.

At the current Wave 6 workspace boundary, these semantics are implemented as
composable primitives and wired into the **unreleased worktree build** as
fixture-only commands. `apply`, `refresh` and `doctor` require explicit
Manifest, Lock, Device Registry v2, device, deployment and `--fixture-root`
inputs. A non-dry-run apply/refresh additionally requires `--operation-id`;
Google Drive mutation additionally requires explicit provider status,
hydration and writability observations. `repair` and `rollback` require an
explicit device, Registry v2, fixture root and operation ID.
`bootstrap-device-state` requires the same explicit Manifest, Lock, Registry
v2, device, deployment and fixture root as apply/refresh, but remains a
separate operator action so apply/refresh cannot silently initialize device
state.

These commands are not part of the globally installed v0.3.0 release.
`portfolio validate`, `plan`, `status` and `deployment-view` remain the
published v0.3.0 Portfolio surfaces. Neither the worktree wiring nor a
successful fixture rehearsal authorizes real runtime mutation.

## 9. Required dependency packs and generated configuration

A project-specific pack remains a dependency of one canonical Skill; it does
not become a second Skill identity or consume a Profile budget.

The Manifest declares:

```yaml
data_dependencies:
  - id: employer-pack
    source: private
    path: packs/work-private/example
    privacy: work-private
    deployments: [work]
    required: true
```

The Lock pins the dependency's source revision, path, tree hash and executable
manifest. The deployment projects it through the same effective backend as the
owning Skill unless an explicit runtime contract says otherwise.

For a required pack, target `missing`, content drift or executable-mode drift
blocks both apply and refresh for the whole Skill batch. The pack and Skill
must either commit together or roll back together.

Generated logical configuration at
`.aspg/generated/private-skill-packs.json` selects packs by stable `pack_id`
and portable deployment-relative target. It must not embed a device-local
absolute pack root, guess an alternative brand, or silently fall back when the
selected pack is unavailable. Configuration generation, pack activation and
portable-state update are one journaled transaction: a later failure restores
the previous target, configuration and state bytes together.

## 10. Fixture-only verification

Every executable example creates and names an isolated fixture root:

```bash
ASPG_FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aspg-runtime-doc.XXXXXX")"
mkdir -p \
  "$ASPG_FIXTURE_ROOT/control" \
  "$ASPG_FIXTURE_ROOT/sources/private" \
  "$ASPG_FIXTURE_ROOT/projects/drive/.agents/skills" \
  "$ASPG_FIXTURE_ROOT/projects/local/.agents/skills" \
  "$ASPG_FIXTURE_ROOT/device-state"
test -d "$ASPG_FIXTURE_ROOT"
```

The automated read-only control regression can be run below an explicit
temporary parent:

```bash
ASPG_FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/aspg-runtime-test.XXXXXX")"
TMPDIR="$ASPG_FIXTURE_ROOT" npm test -- \
  --run tests/portfolio-device-v2-control.test.ts
```

The test creates another isolated child beneath that parent, writes complete
Manifest/Lock/Registry/binding fixtures, and removes only its own child.

No example invokes `apply`, `refresh`, `bootstrap-device-state`, `repair` or
`rollback` against a real project. There is no `--all-projects` mutation mode.
A test or caller that does not provide an explicit `$TMPDIR` fixture root must
be rejected before writes.

The Runtime Gate remains closed until all of the following are true:

- targeted, full, type, build and adversarial regressions pass;
- apply/refresh/bootstrap/repair/rollback rehearsals pass entirely in fixtures;
- real Life/Work runtime baselines are re-measured read-only and unchanged;
- neither real project contains deployment `.aspg` state;
- Planner reports zero unresolved findings;
- Wave 7 receives a separate explicit approval.

## 11. Deferred and unavailable capabilities

- Windows schema/planning may name `junction`, but Windows runtime mutation and
  recovery acceptance are deferred. No current test result authorizes it.
- Multi-device Google Drive acceptance, rehydration and conflict rehearsal must
  pass before a real Drive deployment.
- The global v0.3.0 release is stale relative to this workspace and does not
  include the current Wave 6 mutating commands.
- The current implementation has not been tagged, published or globally
  installed.
- No real Life-OS or Work-PKM binding, portable state, link, materialized copy,
  generated config, refresh, repair or rollback is authorized in Wave 6.
- Wave 7 is the only phase that may propose real migration, and it requires a
  fresh plan, snapshot, dry-run evidence, rollback rehearsal and explicit
  approval.
