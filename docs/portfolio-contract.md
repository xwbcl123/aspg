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
| Device Registry | device-local and ignored by Git | absolute source and project roots plus install backends |

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
  activation_lock: .aspg/portfolio-activation.lock
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
projects:
  life-os-cloudstorage:
    expected_vault: life-os
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
deployments:
  life-os:
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

The Manifest and Lock must contain the same canonical Skill set. Each Skill has
exactly one Lock entry; deployment records contain only canonical IDs and may
not select divergent Skill sets. An active migration exception is shown as a
warning. Missing fields, unknown references and an exception whose
`expires_at` is on or before `--as-of` fail closed.

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
    source_roots:
      private: /srv/aspg/Martin-brew-skills-private
    project_roots:
      life-os-cloudstorage: /srv/vaults/Life-OS
    backends:
      managed-link: symlink
      managed-materialized: materialize
```

Absolute paths are rejected everywhere except the Device Registry. On Darwin
and Linux, `managed-link` requires `symlink`; `copy` is never a managed-link
fallback.

## Deterministic resolution

For a deployment, ASPG unions its named Profile includes and direct includes,
then subtracts Profile and deployment excludes. Profile budgets are validated
individually; the deployment must also fit the sum of its selected Profile
budgets. Unknown Skill/Profile/source/project/deployment references fail.

Within a deployment, two selected canonical Skills may not share an
`exposure_name`. Canonical IDs ending in `-life-os`, `-work-pkm`, `-mac-mini`,
`-macbook-pro` or `-linux-server` are rejected.

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

v1 readers reject every unsupported version. Schema changes require a pure,
explicit and tested `from_version -> to_version` migrator. A migration must
produce byte-stable data for the same input, preserve a backup at its future
write boundary, validate before and after migration, and must never mutate a
runtime projection. v1 currently exposes only the tested `1 -> 1` identity
migration; it does not pretend to understand a future version.
