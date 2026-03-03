# ASPG (Agent Skills Protocol Guardian)

[English](#english) | [中文](#中文)

---

## English

**Agent Skills Protocol Guardian (ASPG)** is a lightweight CLI tool designed to solve the fragmentation of "Skills" or "System Prompts" across multiple AI coding assistants (like Gemini, Claude, Codex/Copilot). 

When working with multiple AI tools, each typically requires its own folder for skills (e.g., `.gemini/`, `.claude/`). ASPG establishes a **Single Source of Truth (SSOT)** in the `.agents/skills/` directory and intelligently bridges these skills to the specific vendor directories.

### Core Features

- **Unified Metadata Standard**: Enforces a strict schema (Frontmatter) for skills using `SKILL.md` (metadata like name, description, requirements).
- **Cross-Platform Vendor Bridges**: Automatically syncs skills from the SSOT to vendor-specific directories (supports symlinks, junctions, or physical copies with graceful degradation for Windows Developer Mode limitations).
- **Bidirectional Flow**: Easily import existing skills from a specific vendor's ecosystem back into the unified SSOT, stripping vendor-specific configurations.

### Installation

Require Node.js >= 18.

You can run ASPG directly via `npx` or install it globally:

```bash
npm install -g aspg
# or
npx aspg <command>
```

### CLI Commands

- `aspg init` - Initialize project infrastructure (`.agents/skills/` + vendor bridges)
- `aspg apply` - Rescan SSOT and refresh all vendor bridges (idempotent, use `--dry-run` to preview)
- `aspg import <skill-name> --from <vendor>` - Import a skill from a vendor ecosystem (claude|codex|gemini) to SSOT
- `aspg lint` - Validate all `SKILL.md` frontmatter contracts
- `aspg compat [skill-name]` - Check environment & dependency requirements
- `aspg doctor` - Topology & link health check
- `aspg clean` - Remove all ASPG-generated bridges (preserves the `.agents/skills/` SSOT)

---

## 中文

**Agent Skills Protocol Guardian (ASPG)** 是一个轻量级的命令行工具，旨在解决多个 AI 编程助手（如 Gemini、Claude、Codex/Copilot）之间“技能（Skills）”或“系统指令（System Prompts）”的碎片化管理问题。

当你在项目中使用多个 AI 工具时，通常每个工具都需要在特定的私有目录（如 `.gemini/`、`.claude/`）中存放技能脚本。ASPG 通过在 `.agents/skills/` 目录下建立**单一事实来源（Single Source of Truth, SSOT）**，并智能地将这些技能桥接到各个 AI 厂商的专属目录中。

### 核心特性

- **统一的元数据标准**：通过 `SKILL.md` 强制要求严格的 Frontmatter 契约（包含技能名称、描述、环境要求等）。
- **跨平台生态桥接**：自动将 SSOT 中的技能同步到特定厂商的目录中（支持软链接、Junction 或物理复制，并针对 Windows 开发者模式限制做了优雅降级容错）。
- **双向流转**：可以轻松地将某个特定厂商生态内的现有技能导入回统一的 SSOT 中，并自动剔除厂商专属的配置字段。

### 安装

需要 Node.js >= 18。

你可以通过 `npx` 直接运行 ASPG，或者将其全局安装：

```bash
npm install -g aspg
# 或
npx aspg <command>
```

### 命令行指令

- `aspg init` - 初始化项目基础设施（创建 `.agents/skills/` 和各个厂商的桥接目录）
- `aspg apply` - 重新扫描 SSOT 并刷新所有厂商的桥接环境（幂等操作，可使用 `--dry-run` 预览）
- `aspg import <skill-name> --from <vendor>` - 从指定厂商生态 (claude|codex|gemini) 中将技能导入到 SSOT
- `aspg lint` - 校验所有 `SKILL.md` 文件的 Frontmatter 契约格式
- `aspg compat [skill-name]` - 检查环境和依赖要求兼容性
- `aspg doctor` - 检查桥接拓扑结构和软链接的健康状态
- `aspg clean` - 清理所有由 ASPG 生成的桥接产物（保留 `.agents/skills/` 核心目录）
