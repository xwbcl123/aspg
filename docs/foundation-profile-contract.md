# Foundation Profile Contract

`aspg profile plan` composes a stable Core, one named Profile, a device-local
backend policy, and runtime-native capability replacements. It performs zero
writes.

## Files

Portable project files:

- `.aspg/manifest.yaml` — sources, Skills, Profiles, budgets, concurrency policy
- `.aspg/lock.yaml` — exact source revisions/tree hashes and prior managed state

Machine-local file:

- device registry — device IDs, source checkout roots, and install backends

The device registry path is supplied with `--device-registry`, the
`ASPG_DEVICE_REGISTRY` environment variable, or the platform user-config
default. Do not commit machine-specific roots into the project manifest.

## Runtime ownership

| Mode | Meaning |
|---|---|
| `project-local` | Project remains the canonical owner |
| `managed-link` | ASPG may later manage a link/copy bridge |
| `managed-materialized` | ASPG may later place a locked physical copy |
| `catalog-only` | Discoverable metadata; not exposed in the shared runtime |
| `runtime-native` | Replaced by a provider/plugin-native capability |

The planner reports intended actions only. `profile apply` remains `future`.

## Concurrency contract

```yaml
concurrency:
  mode: stable-core-catalog-on-demand
  hot_switch_shared_runtime: false
  activation_lock: .aspg/profile-activation.lock
```

Planning never creates the lock. A future apply command must acquire it before
changing shared runtime exposure and must require a fresh-session boundary.

## Minimal project manifest

```yaml
version: 1
project: example-project
command_maturity:
  profile_plan: mvp
  profile_apply: future
concurrency:
  mode: stable-core-catalog-on-demand
  hot_switch_shared_runtime: false
  activation_lock: .aspg/profile-activation.lock
core: [local-core]
sources:
  project:
    kind: project-local
    path: .
  shared:
    kind: git
    repository: https://example.invalid/shared-skills.git
    revision: v1.2.3
    privacy: third-party
skills:
  local-core:
    source: project
    path: .agents/skills/local-core
    ownership: project-local
    description_chars: 90
    capabilities: [core]
  research:
    source: shared
    path: skills/research
    ownership: managed-link
    description_chars: 140
    capabilities: [research]
profiles:
  research:
    include: [research]
    exclude: []
    budgets:
      max_skills: 6
      max_description_chars: 900
runtimes:
  codex:
    replacements: {}
```

## Lock

```yaml
version: 1
sources:
  shared:
    revision: v1.2.3
    tree_hash: sha256:REVIEWED_TREE_HASH
managed: {}
```

The planner fails closed when a Git source is missing, unlocked, or hash-drifted.

## Device registry

```yaml
version: 1
devices:
  work-mac:
    platform: darwin
    source_roots:
      shared: /opt/aspg/sources/shared
    backends:
      managed-link: symlink
      managed-materialized: materialize
  linux-server:
    platform: linux
    source_roots:
      shared: /srv/aspg/sources/shared
    backends:
      managed-link: copy
      managed-materialized: materialize
```

## Command

```bash
aspg profile plan research \
  --project . \
  --device work-mac \
  --runtime codex \
  --device-registry "${ASPG_DEVICE_REGISTRY}" \
  --json
```

The JSON output is byte-stable for the same filesystem state and includes:

- selected/exposed budgets;
- create/change/remove/catalog/runtime-native entries;
- source and previous tree hashes for rollback review;
- backend selection;
- concurrency policy;
- sorted errors/warnings;
- `writes_performed: 0`.

## Description lint

`aspg lint` now rejects a plain YAML description such as:

```yaml
description: Publish only after #publish authorization
```

YAML silently treats `#publish authorization` as a comment. Quote the scalar or
use a block scalar:

```yaml
description: >-
  Publish only after #publish authorization.
```

The lint report shows parsed/source description lengths and enforces the
configurable `--max-description-chars` budget.

For portable `scripts/` directories, interpreter-invoked files do not require
an executable bit. A shebang file that loses its executable bit is reported as
a warning rather than a contract failure, because cloud-sync and Windows may
not preserve Unix mode bits.

## Explicit exclusions

- no production Profile activation;
- no Plugin install/uninstall or per-Profile Plugin exposure;
- no public export;
- no runtime deletion/deactivation;
- no automatic source update or revision advancement.
