# ASPG Portfolio Contract v1

The Portfolio is the sole cross-project revision authority. The existing
Foundation `aspg profile plan` command remains a project-local, read-only
compatibility surface; it does not join or override Portfolio data. Portfolio
v1 deliberately has no `apply` command.

## Files and ownership

| Document | Portability | Authority |
|---|---|---|
| Portfolio Manifest | committed, no absolute paths | desired Skills, Profiles, deployments and budgets |
| Portfolio Lock | committed, no absolute paths | one source/path/revision/subtree hash per canonical Skill |
| Project Binding | committed inside `<project>/.aspg/portfolio.yaml` | deployment and Portfolio repository revision used by that project |
| Device Registry | device-local and ignored by Git | absolute state, source and project roots plus install backends |

Project roots and source roots are resolved with `realpath`. Two project IDs
may not resolve to the same directory. Every deployment binding must name the
matching deployment, and all bindings on one device must select the same
Portfolio repository and revision.

## Example: Portfolio Manifest

```yaml
version: 1
portfolio: martin-skills
command_maturity:
  portfolio_plan: mvp
  portfolio_apply: future
concurrency:
  activation_lock: device-local
sources:
  private:
    kind: git
    repository: git@github.com:xwbcl123/Martin-brew-skills-private.git
    privacy: private
skills:
  martin/audio-transcriber:
    source: private
    path: skills/audio-transcriber
    ownership: managed-link
    exposure_name: audio-transcriber
    description_chars: 280
    capabilities: [audio-transcription]
    data_dependencies:
      - id: cstc-eu-rspo-employer-pack
        source: private
        path: packs/work-private/artifact-template-cstc-eu-rspo-default-deck
        privacy: work-private
        deployments: [work-pkm]
        required: true
profiles:
  life-default:
    include: [martin/audio-transcriber]
    exclude: []
    budgets:
      max_skills: 40
      max_description_chars: 12000
deployments:
  life-os:
    project_ref: life-os-cloudstorage
    profiles: [life-default]
    include: []
    exclude: []
  work-pkm:
    project_ref: work-pkm-local
    profiles: [life-default]
    include: []
    exclude: []
projects:
  life-os-cloudstorage:
    expected_vault: life-os
  work-pkm-local:
    expected_vault: work-pkm
```

## Example: Portfolio Lock

```yaml
version: 1
sources:
  private:
    revision: 0123456789abcdef0123456789abcdef01234567
skills:
  martin/audio-transcriber:
    source: private
    path: skills/audio-transcriber
    source_revision: 0123456789abcdef0123456789abcdef01234567
    tree_hash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    executable_files:
      - scripts/transcribe_audio_gemini.py
    overlay_hash: null
    data_dependencies:
      cstc-eu-rspo-employer-pack:
        source_revision: 0123456789abcdef0123456789abcdef01234567
        path: packs/work-private/artifact-template-cstc-eu-rspo-default-deck
        tree_hash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
        executable_files: []
deployments:
  life-os:
    resolved_skills: [martin/audio-transcriber]
  work-pkm:
    resolved_skills: [martin/audio-transcriber]
exceptions:
  - skill: martin/audio-transcriber
    deployment: life-os
    pinned_revision: 0123456789abcdef0123456789abcdef01234567
    reason: staged rollout observation
    owner: martin
    expires_at: 2099-08-02
```

The repository revision is context. The drift gate is the locked Skill
subtree. The SHA-256 stream includes each entry's portable relative path, file
type, file bytes or symlink-target bytes, and regular-file executable bit.
`executable_files` is independently compared with the observed subtree.

Lock authoring hashes every root and non-root Skill in exact mode with
`{ revision, sourcePath }`. Its path universe is:

```text
git ls-tree -r -z --full-tree <revision> -- <sourcePath>
```

`sourcePath` is the portable path recorded by the Manifest and Lock; `.` means
the repository root. ASPG proves that the supplied Skill directory resolves to
that exact path in the source worktree, that `HEAD` equals the recorded
40-character revision, and that the complete source worktree is clean. A dirty
source is refused with the stable diagnostic prefix
`dirty-source-refused:` followed by deterministically sorted offending paths.
Lock authoring never hashes dirty bytes and never silently narrows the check to
only the selected subtree.

The pinned tracked set defines names and types. ASPG hashes worktree bytes,
symlink targets and executable mode using paths relative to the Skill subtree.
Missing entries, type drift and executable-mode drift fail closed. For a
repository-root Skill only top-level repository control state (`.git/`,
`.aspg/`, `.aspg-copy-fallback` and managed-link sidecars) is excluded. The
same names inside a non-root Skill are nested content: tracked entries are
hashed and untracked entries fail closed.

Ignored build output is excluded only when the matching `.gitignore` is tracked
at the pinned revision and its worktree bytes, file type and executable mode
exactly equal the pinned blob. This applies to repository or ancestor
`.gitignore` files that govern a non-root Skill. A dirty `.gitignore` therefore
produces `dirty-source-refused` before a new rule can hide content. Other
untracked content also fails closed. If the Git root, checked-out revision,
tracked path set, ignore blob or ignore provenance cannot be verified, no
digest is returned. This keeps equivalent clean clones stable across
gitignored `.venv/`, `__pycache__/` and `dist/` output without a broad
filename ignore list or a lock-authoring bypass.

The legacy API remains available for read-only runtime comparison:
`hashSkillSubtree(path)` hashes the visible non-root filesystem tree, while
`{ rootSkill: true, revision }` preserves the earlier repository-root behavior.
Neither legacy form is sufficient for authoring a new Lock. Callers must pass
both `revision` and `sourcePath` to enable the blocking exact-source contract.

Required same-Skill data dependencies are declared below the canonical Skill,
so they do not create another Skill/Profile identity and do not consume Skill
budgets. `work-private` dependencies must use the Skill's private source and
name only explicit deployments whose project has `expected_vault: work-pkm`.
Their Lock entries reuse the Skill's `source_revision` and pin path, tree hash,
and executable manifest. Missing or orphan Lock entries, invalid scope, or
revision/path/hash/executable-mode divergence fail closed.

Lock authoring uses the clean exact-checkout API above. Read-only validation
instead recomputes a dependency digest directly from the pinned Git object
graph. This distinction is required for self-hosted Portfolio Locks: the Lock
commit may be newer than the canonical-content commit it records, while the
pinned tracked set remains independently verifiable. W2B validates only this
contract; dependency projection and runtime configuration remain deferred to
W6.

The Manifest and Lock must contain the same canonical Skill set. Each Skill has
exactly one Lock entry; deployment records contain only canonical IDs and may
not select divergent Skill sets. An active migration exception is shown as a
warning. Missing fields, unknown references and an exception whose
`expires_at` is on or before `--as-of` fail closed.

`--as-of` is an operator-supplied reproducibility input, not an anti-tamper
clock. Backdating it can make an exception that is expired today appear active
in a historical report. Every result echoes the effective date; compliance and
rollout gates must supply a trusted current date and must not treat a backdated
run as current health evidence.

## Example: Project Binding

```yaml
version: 1
portfolio:
  repository: git@github.com:xwbcl123/Martin-brew-skills-private.git
  revision: 0123456789abcdef0123456789abcdef01234567
  deployment: life-os
```

## Example: Device Registry

```yaml
version: 1
devices:
  mac-mini:
    platform: darwin
    state_root: /srv/aspg/device-state
    source_roots:
      private: /srv/aspg/Martin-brew-skills-private
    project_roots:
      life-os-cloudstorage: /srv/vaults/Life-OS
    backends:
      managed-link: symlink
      managed-materialized: materialize
```

This v1 form remains the active reader used by Portfolio commands and their
fixtures until the serialized Wave 6 integration. Device Registry v2 is an
additive schema; authoring it does not switch the current reader.

## Example: Device Registry v2

```yaml
version: 2
devices:
  mac-mini:
    platform: darwin
    state_root: /srv/aspg/device-state
    source_roots:
      external: /srv/aspg/sources/third-party
      private: /srv/aspg/sources/Martin-brew-skills-private
    runtime_roots:
      life-os-agents:
        project_ref: life-os-cloudstorage
        path: /srv/vaults/Life-OS/.agents/skills
        storage_provider: google-drive-file-provider
        deployment_backend: managed-materialized
      work-pkm-agents:
        project_ref: work-pkm-local
        path: /srv/workspace/Work-PKM-Vault/.agents/skills
        storage_provider: local-filesystem
        deployment_backend: managed-link
```

v2 scopes `storage_provider` and `deployment_backend` to each runtime root, so
one project may expose roots on different storage providers. Supported
providers are `local-filesystem` and `google-drive-file-provider`; a Google
Drive root must explicitly select `managed-materialized`, never
`managed-link`. Every state, source and runtime root is an absolute normalized
path, may not be the filesystem root, and may not equal, contain or be contained
by another configured root on the same device.

The pure v1→v2 migrator validates v1, preserves platform, `state_root` and
`source_roots`, and returns a validated v2 document without filesystem writes.
Because v1 has only project-level roots and device-wide backend capabilities,
it cannot determine runtime-root provider/backend policy safely. The migrator
therefore emits `runtime_roots: {}` instead of guessing from path names.
Operators must explicitly populate and validate the runtime roots before v2 is
activated. The migrator does not move projects, mutate runtimes or write a real
Device Registry.

Absolute paths are rejected everywhere except the Device Registry. In active
v1 registries, Darwin and Linux `managed-link` requires `symlink`; `copy` is
never a managed-link fallback.

`concurrency.activation_lock: device-local` is a scope token, never a
project-relative path. The concrete lock is resolved below the selected
device's absolute `state_root` as
`locks/<portfolio>-<deployment>.lock`. `state_root` must not overlap any source
or project root, which prevents a Life-OS lock from being placed inside its
Google Drive tree. The operator must choose a local-filesystem path outside any
synced File Provider; existing path ancestors are resolved with `realpath`, and
a symlink back into a project/source root is rejected.

Windows copy bridges are a deferred compatibility limitation in v1. A copied
bridge has no idempotent refresh ownership record, so it must be removed
manually before refresh. ASPG must not overwrite or merge it in place.

## Deterministic resolution

For a deployment, ASPG unions its named Profile includes and direct includes,
then subtracts Profile and deployment excludes. Profile budgets are validated
individually; the deployment must also fit the sum of its selected Profile
budgets. Unknown Skill/Profile/source/project/deployment references fail.

Within a deployment, two selected canonical Skills may not share an
`exposure_name`. Canonical IDs ending in the delimited project/device suffixes
`-life-os`, `-work-pkm`, `-mac-mini`, `-macbook-pro`, `-linux` or
`-linux-server` are rejected. Substrings without the `-` delimiter, such as
`gnulinux`, are not suffix matches. Lifecycle and Portfolio use the same
predicate.

The read-only commands are:

```text
aspg portfolio validate --device <id> [paths] [--as-of YYYY-MM-DD] [--json]
aspg portfolio plan --deployment <id> --device <id> [paths] [--json]
aspg portfolio status --all --device <id> [paths] [--json]
aspg portfolio deployment-view --all --device <id> [paths] [--json]
```

`[paths]` may contain `--manifest`, `--lock` and `--device-registry`.
Every JSON result is deterministically sorted and declares
`writes_performed: 0`. The generated deployment view is never written back to
Lifecycle Profiles.

## Schema evolution

Readers reject every unsupported future version. Schema changes require a pure,
explicit and tested `from_version -> to_version` migrator. A migration must
produce byte-stable data for the same input, preserve a backup at its future
write boundary, validate before and after migration, and must never mutate a
runtime projection. The migration boundary now exposes the tested identity
migrations plus Device Registry `1 -> 2`; it rejects `1 -> 2` for every other
document kind and does not pretend to understand version 3.
