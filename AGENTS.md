# AI Agent Guidelines for ASPG Projects

This project uses **ASPG (Agent Skills Protocol Guardian)** to manage multi-AI skills and system instructions. If you are an AI coding assistant (like Gemini, Claude, or Copilot) working in this repository, you **MUST** follow these rules when creating or modifying AI skills.

## The Single Source of Truth (SSOT)

- **NEVER** create or modify skills directly in vendor-specific directories like `.gemini/skills/`, `.claude/prompts/`, or similar.
- **ALWAYS** create, update, or delete skills inside the **`.agents/skills/`** directory.
- ASPG acts as a bridge. Any changes made in the SSOT will be automatically synchronized to other vendor directories when the user runs `aspg apply`.

## SKILL.md Frontmatter Contract

Every skill in the `.agents/skills/<skill-name>/` directory **MUST** contain a `SKILL.md` file with a valid YAML frontmatter block. ASPG strictly validates this schema.

### Schema Requirements

The frontmatter must conform to the following schema:

```yaml
---
# REQUIRED
name: "Skill Name"
description: "A short description of what the skill does"

# OPTIONAL
version: "1.0.0"
author: "Author Name"
license: "MIT"
tags: 
  - tag1
  - tag2

# Optional ASPG Namespace
aspg:
  requirements:
    tools: ["npx", "git"]
    env: ["OPENAI_API_KEY"]
---
# Skill instructions go here...
```

To view the exact schema implementation details, look at `src/schema.ts` in the ASPG repository.

## Workflow for Agents

When a user asks you to create or modify a skill:

1. **Locate or Create the Skill**: Work entirely within `.agents/skills/<skill-name>/`.
2. **Update SKILL.md**: Ensure the `SKILL.md` file exists and has correct, valid YAML frontmatter as shown above.
3. **Validate**: If requested, run `npx aspg lint` (or equivalent package script) to ensure the newly created or modified `SKILL.md` satisfies the schema validation.
4. **Apply Changes**: After making modifications, remind the user to run `aspg apply` (or run it automatically via CLI if you have permission) to sync the changes down to all vendor bridges.
