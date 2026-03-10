---
title: "ASPG Native Skill Discovery De-dup PRD"
date: "2026-03-08"
type: "prd"
tags:
  - aspg
  - skills
  - codex
  - opencode
  - interoperability
status: "draft"
source:
  - "Local analysis of installed aspg package"
  - "OpenAI Codex OSS"
  - "OpenCode docs"
---

# ASPG Native Skill Discovery De-dup PRD

## 1. Summary

ASPG currently treats Codex and OpenCode as bridge-based vendors and automatically creates:

- `.codex/skills`
- `.opencode/skills`

from the SSOT at:

- `.agents/skills`

This creates duplicated skill discovery in environments where the downstream tool already natively discovers `.agents/skills`.

Confirmed findings:

- Codex CLI renders a session-level `## Skills` section from runtime skill discovery and includes repo-level `.agents/skills` plus project-layer skills.
- OpenCode officially documents that it discovers skills from `.opencode/skills`, `.claude/skills`, and `.agents/skills`.
- ASPG currently hardcodes both `opencode` and `codex` as bridge targets.

Result:

- Codex users can see duplicate skills from `.agents/skills` and `.codex/skills`
- OpenCode users may also see duplicate skills from `.agents/skills` and `.opencode/skills`
- ASPG is bridging where bridging is no longer needed

## 2. Problem Statement

ASPG assumes every vendor needs a vendor-local skill directory bridge. That assumption is now partially outdated.

For tools that already natively discover `.agents/skills`, creating vendor-local mirrors causes:

- duplicated entries in skill pickers or slash-command UIs
- inflated prompt context due to repeated metadata
- confusion about which path is canonical
- unnecessary link/copy maintenance

In practice, `.agents/skills` is already the SSOT, so creating `.codex/skills` and `.opencode/skills` adds cost without adding capability.

## 3. Evidence

### 3.1 ASPG local implementation

Installed `aspg` source hardcodes:

- SSOT: `.agents/skills`
- Vendor bridges: `.claude/skills`, `.opencode/skills`, `.codex/skills`

Relevant local source:

- [init.ts](C:/Users/xwbcl/AppData/Roaming/npm/node_modules/aspg/src/commands/init.ts): lines 9-13
- [apply.ts](C:/Users/xwbcl/AppData/Roaming/npm/node_modules/aspg/src/commands/apply.ts): lines 8-12

### 3.2 Codex OSS behavior

Codex open-source code shows:

- session prompt assembly includes a contextual `# AGENTS.md instructions for ...` block
- runtime skill rendering includes `## Skills`, `### Available skills`, `### How to use skills`
- repo `.agents/skills` is part of skill discovery

References:

- https://github.com/openai/codex/blob/main/codex-rs/core/src/contextual_user_message.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/skills/render.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/skills/loader.rs

### 3.3 OpenCode documented behavior

OpenCode docs explicitly state that skills are discovered from:

- `.opencode/skills`
- `.claude/skills`
- `.agents/skills`

Reference:

- https://opencode.ai/docs/skills/

## 4. Root Cause

The duplication is not caused by SSOT itself.

The root cause is that ASPG treats all vendors as bridge-only vendors, while at least some vendors are now native `.agents/skills` consumers.

Current model:

- SSOT -> bridge everything

Needed model:

- SSOT -> bridge only where necessary
- native consumers read SSOT directly

## 5. Product Goal

Allow ASPG to distinguish between:

- `native vendors`: already discover `.agents/skills` directly
- `bridge vendors`: still require a vendor-local bridge

Primary goal:

Reduce duplicate skill discovery without breaking ASPG's SSOT-centered design.

## 6. Non-Goals

- replacing `.agents/skills` as SSOT
- changing SKILL.md schema
- changing import/lint semantics
- changing external vendor discovery logic inside Codex or OpenCode

## 7. Proposed Solution

Introduce configurable vendor topology.

### 7.1 Core concept

ASPG should no longer hardcode all vendors into `VENDOR_LINKS`.

Instead, it should support two sets:

- `native_vendors`
- `bridge_vendors`

Recommended default classification based on current evidence:

- native: `codex`, `opencode`
- bridge: `claude`

Gemini can remain manual until its behavior is standardized.

### 7.2 User-facing config

Support project-level config such as:

```json
{
  "nativeVendors": ["codex", "opencode"],
  "bridgeVendors": ["claude"]
}
```

Possible file names:

- `.aspg.json`
- `aspg.config.json`

Alternative env override:

```bash
ASPG_NATIVE_VENDORS=codex,opencode
ASPG_BRIDGE_VENDORS=claude
```

### 7.3 Command behavior changes

`aspg init`

- always create `.agents/skills`
- only create vendor-local bridges for `bridgeVendors`

`aspg apply`

- refresh only bridge targets
- do not recreate bridges for native vendors

`aspg doctor`

- show vendor classification
- detect unnecessary bridge directories for native vendors
- warn when a native vendor also has a bridge that may cause duplicates

`aspg clean`

- remove only generated bridge directories
- preserve `.agents/skills`
- respect config classification

## 8. Migration Strategy

For existing repos:

1. Keep `.agents/skills` unchanged
2. Mark `codex` and `opencode` as native vendors
3. Remove stale `.codex/skills` and `.opencode/skills` bridges if they were generated by ASPG
4. Preserve `.claude/skills` bridge if still needed

Backward compatibility:

- if no config file exists, ASPG may keep current behavior initially
- optionally emit a warning when bridging a vendor known to natively scan `.agents/skills`

## 9. UX Recommendations

`aspg doctor` should say something like:

```text
native vendors:
- codex
- opencode

bridge vendors:
- claude

warning:
- .codex/skills exists, but codex already discovers .agents/skills directly
- .opencode/skills exists, but opencode already discovers .agents/skills directly
```

This would make the topology obvious and explain the duplicate-discovery risk.

## 10. Acceptance Criteria

- ASPG can classify vendors as native vs bridge
- `aspg init` does not create `.codex/skills` when `codex` is native
- `aspg init` does not create `.opencode/skills` when `opencode` is native
- `aspg apply` does not recreate those directories
- `aspg doctor` warns about redundant native-vendor bridges
- `.agents/skills` remains the only SSOT
- existing `lint` and `import` behavior remains intact

## 11. Minimal MVP

If full config support is too large for v1, the MVP could be:

1. hardcode `codex` and `opencode` as native vendors
2. stop generating `.codex/skills` and `.opencode/skills`
3. keep `.claude/skills` as the only automatic bridge

This would already solve the duplicate-discovery problem for the two known native consumers.

## 12. Suggested Issue Framing

Suggested issue title:

`ASPG should support native vendors that already discover .agents/skills directly`

Suggested core message:

- ASPG's SSOT model is correct
- the problem is bridge over-generation
- Codex and OpenCode already read `.agents/skills`
- generating `.codex/skills` and `.opencode/skills` creates duplicate discovery
- ASPG should support vendor classification or stop bridging native consumers

## 13. Open Questions

- Should OpenCode be native by default, or only when a minimum version is detected?
- Should Codex be native by default, or be controlled by config for safety?
- Should native-vendor stale bridges be auto-removed or only warned?
- Is config preferable to env vars, or should both exist?

## 14. Recommendation

Recommended final direction:

- keep `.agents/skills` as SSOT
- treat `codex` and `opencode` as native consumers
- bridge only for tools that actually need private vendor directories
- add explicit vendor topology config to ASPG

This preserves ASPG's architecture while aligning it with the current discovery behavior of downstream tools.

