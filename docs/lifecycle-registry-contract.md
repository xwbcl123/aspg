# Lifecycle Registry Contract v1

ASPG Lifecycle is a read-only, federated view over lifecycle records owned by
source or project repositories. It does not replace source provenance,
deployment manifests, device configuration or Life-OS knowledge.

## Boundary

| Fact | Owner |
|---|---|
| Repository URL, revision, license and trust | Source registry |
| Learning, scoped adoption, lineage and freshness | Owner-adjacent lifecycle profile |
| Experiments, comparisons, notes, patterns and decisions | Life-OS Knowledge Plane |
| Desired exposure and exact resolved tree | ASPG Profile manifest/lock |
| Device paths and backends | Device registry |
| Installed, exposed and loaded state | Derived at runtime; never stored here |

All lifecycle commands in v1 perform zero writes.

## Layout and discovery

Pass one or more owner repository roots:

```bash
aspg lifecycle validate \
  --registry /path/to/third-party /path/to/private-canonical \
  --lifeos-root /device/path/to/41.15_skill-lifecycle-knowledge-lib \
  --json
```

Each root must contain:

```text
registry/
  sources.yaml
  lifecycle/
    <namespace>/
      <skill>/
        profile.yaml
```

`lifecycle/` directly below the owner root is also accepted. Profile discovery
is recursive and deterministic. The source catalog can represent `sources` as
an ID-keyed map or as an array whose entries contain `id` or `source_id`.

Each profile's `source_ref` is checked against the catalog in the same owner
root. Source IDs are not implicitly borrowed from another root.

Combined validation also rejects canonical IDs whose basename ends in
`-life-os`, `-work-pkm`, `-mac-mini`, `-macbook-pro` or `-linux`. A basename
shared across namespaces is rejected unless a direct lineage relation
(`configure`, `wrap`, `fork`, `localized-derivative` or `absorb`) connects the
Profiles. Portfolio validation remains responsible for proving any
deployment-specific mutual-exclusion policy; such policy is never stored in a
Lifecycle Profile.

## Profile v1

```yaml
schema_version: 1
skill_id: mattpocock/grill-with-docs
display_name: Grill With Docs
source_ref: mattpocock-skills
source_path: skills/grill-with-docs
owner_class: third-party

learning:
  current_level: L3
  target_level: L4
  evidence:
    - kind: adaptation
      ref: lifeos://41.15/experiments/20260725_grill-localization_v1
      reviewed_at: 2026-07-25
      summary: Optional short redacted summary.

adoption:
  scopes:
    - project: work-pkm
      stage: production
      devices: [macbook-pro, linux-server]
      workflows: [requirements-clarification]
      evidence:
        - kind: production-case
          ref: lifeos://41.15/skills/20260725_martin-grill-me_v1
          reviewed_at: 2026-07-25
    - project: life-os
      stage: sandbox
      devices: [mac-mini]
      workflows: [requirements-clarification]
      evidence: []

disposition:
  relations:
    - type: localized-derivative
      target: mattpocock/grill-with-docs
      base_revision: ed37663cc5fbef691ddfecd080dff42f7e7e350d

freshness:
  status: needs-revalidation
  reviewed_at: 2026-07-25
  triggers: [model-major-upgrade, upstream-change]

next_review_at: 2026-08-25
```

Valid lifecycle values:

- learning: `L0` through `L5`;
- adoption: `none`, `sandbox`, `pilot`, `production`, `embedded`,
  `suspended`, `retired`;
- relation: `use-as-is`, `configure`, `wrap`, `fork`,
  `localized-derivative`, `absorb`, `compose`, `reference`, `reject`,
  `archive`;
- freshness: `current`, `needs-revalidation`, `stale`, `superseded`,
  `archived`.

Both `stage` and adoption evidence belong to a scope. A Skill can be production
in Work-PKM and sandbox in Life-OS; an absent project has no scope. ASPG derives
`aggregate_adoption` for catalog summaries but never stores it in a profile.
Lifecycle records never contain `installed`, `exposed`, `loaded`, absolute
device paths or runtime activation state.

`source_path` is a portable, forward-slash, repository-relative declaration.
It is required for `private-canonical`, `sanitized-public` and Git-backed
`third-party` Profiles. Together, `(source_ref, source_path)` is the canonical
content identity and must be unique across every registry supplied in one
validation run. Project, device, revision and install location do not contribute
to Lifecycle identity.

Validation is deliberately staged during canonical import. The declaration is
an error-level requirement now, but a missing canonical tree is not checked for
`private-canonical` or `sanitized-public` sources until the content-import
phase. Initialized `git-submodule` sources continue to receive immediate,
read-only path-existence and containment checks. This lets all private Profiles
declare their future canonical paths before all trees have been imported,
without weakening the identity contract or writing deployment state into
Lifecycle.

Relation direction is exact: **the current profile Skill is `<relation>` of
`target`**. A localized derivative therefore records its upstream target on the
derivative profile. ASPG checks target existence across all supplied roots,
requires a lowercase 40-character Git revision and verifies it against the
target source's `pinned_revision`. `use-as-is` and `reference` do not carry a
target or `base_revision`.

## Evidence and privacy

Evidence references are either:

- relative to the owner repository root; or
- an opaque Life-OS reference:
  `lifeos://41.15/{skills|experiments|comparisons|patterns|decisions}/<note-stem>`.

`--lifeos-root` points to the device-local **41.15 entity root**, not the
Life-OS Vault root. `<note-stem>` is one lowercase filename stem containing
only letters, digits, `.`, `_` or `-`; nested path segments, queries and
fragments are rejected.

Resolution states are explicit:

- no `--lifeos-root`: `not-requested`, `evidence-unresolved` warning, gate
  `unverified`, structural exit remains `0`;
- requested root unavailable: `unresolved`, warning, gate `unverified`,
  structural exit remains `0`;
- requested root available but note missing: `missing`,
  `evidence-reference-missing` error and gate fails;
- note exists inside the mapped namespace directory: `resolved` and eligible
  to satisfy a gate.

Repository-relative references must remain inside the owner root, exist and
remain inside it after `realpath`; symlinks escaping the root fail validation.

Validation fails for:

- absolute POSIX, Windows or home-relative paths;
- `..` traversal;
- backslash-based non-portable paths;
- unapproved URI schemes;
- malformed `lifeos://` references;
- missing relative evidence;
- absolute user-home paths in any profile string;
- email, user-home or secret-like material in the optional redacted summary.

Summaries are capped at 600 characters. Raw prompts, complete conversations,
credentials, recipient details and confidential deliverables do not belong in
a lifecycle profile. The lightweight summary checks are guardrails, not a
general secret scanner: public/private export still requires a dedicated
scanner for AWS, GitLab, Slack, JWT, PEM and other credential formats.

## Evidence Gates

Evidence kinds are portable strings. The evaluator recognizes focused aliases,
including `architecture-review`, `production-case`, `source-review` and
`reproduction`.

| Gate | Required evidence |
|---|---|
| L1 | reproduction |
| L2 | structure, limitations and failure-mode analysis |
| L3 | adaptation plus validation |
| L4 | real case, human review, fallback and named Workflow |
| L5 | derived asset, pattern, framework or tutorial |
| Pilot | source/trust screen plus baseline/reproduction case |
| Production | production case, human review and fallback |
| Embedded | Production evidence, Workflow dependency and revalidation policy |

Evidence must resolve before it can satisfy a gate. Missing evidence, unresolved
evidence and structural errors are reported separately. The read-only MVP never
promotes, demotes or archives a record.

## Source integrity

For `source_type: git-submodule`, ASPG automatically checks:

- portable source path and initialized checkout;
- lowercase 40-character `pinned_revision`;
- checkout `HEAD` equals the pin;
- parent Git index contains a `160000` gitlink equal to the pin;
- `skill_paths[skill_id]` exists inside the pinned source.

Failures are structured diagnostics and make validation fail. Other source
types report source-integrity as `not-applicable`.

## Canonical schema

`LifecycleProfileSchema` in ASPG is the only executable canonical contract.
No source repository maintains a private copy. A deterministic machine-readable
JSON Schema projection is generated directly from the Zod tree:

```bash
npm run build
npm run schema:lifecycle
```

Cross-field runtime refinements remain marked
`x-aspg-runtime-refinements: true` and are enforced by Zod. Parity and
determinism are covered by the native test suite.

## Commands and failure semantics

```text
aspg lifecycle validate --registry <path...> [--lifeos-root <41.15-root>] [--json]
aspg lifecycle list --registry <path...> [--lifeos-root <41.15-root>] [--json]
aspg lifecycle show <skill-id> --registry <path...> [--lifeos-root <41.15-root>] [--json]
aspg lifecycle status --registry <path...> [--lifeos-root <41.15-root>] [--as-of YYYY-MM-DD] [--json]
aspg lifecycle next --registry <path...> [--lifeos-root <41.15-root>] [--as-of YYYY-MM-DD] [--json]
```

- exit `0`: registry is structurally valid;
- exit `1`: invalid registry/reference/privacy/duplicate ID, or requested Skill
  is not found; Commander also retains its existing exit `1` behavior for
  invalid CLI syntax.

JSON keys and arrays have stable construction and sorting. Repeating a command
against unchanged roots with an explicit `--as-of` produces byte-identical
output. If omitted, the effective UTC date is surfaced as `as_of`. Impossible
calendar dates fail. Every JSON response declares `writes_performed: 0`.

## Deliberately excluded from v1

- lifecycle writers such as `init`, `promote` or `archive`;
- experiment/model execution and score computation;
- deployment or exposure mutation;
- SQLite or generated catalogs;
- GitHub Issue/Project/PR automation;
- raw production telemetry.
