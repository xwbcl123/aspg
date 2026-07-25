import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-lint-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  fs.mkdirSync(path.join(tmpDir, '.agents', 'skills'), { recursive: true });
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runLint(): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.warn = (...args: unknown[]) => stderr.push(args.join(' '));
  process.exitCode = undefined as unknown as number;

  const { lintCommand } = await import('../src/commands/lint.js');
  await lintCommand();

  console.log = origLog;
  console.error = origError;
  console.warn = origWarn;
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('lint — plugin bundle awareness', () => {
  it('should accept supported plugin bundle structure', async () => {
    const bundleRoot = path.join(tmpDir, '.agents', 'skills', 'skill-creator');
    fs.mkdirSync(path.join(bundleRoot, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'skill-creator'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, '.claude-plugin', 'plugin.json'), '{"name":"skill-creator"}');
    fs.writeFileSync(path.join(bundleRoot, 'skills', 'skill-creator', 'SKILL.md'), `---
name: skill-creator
description: test plugin skill
---

# Skill Creator
`);

    const { stdout, stderr } = await runLint();
    expect(stdout).toContain('plugin bundle detected');
    expect(stdout).toContain('[plugin:skill-creator] ✓ Frontmatter valid');
    expect(stderr).toBe('');
  });

  it('should flag nested packaging when plugin manifest is absent', async () => {
    const bundleRoot = path.join(tmpDir, '.agents', 'skills', 'broken-bundle');
    fs.mkdirSync(path.join(bundleRoot, 'skills', 'broken-bundle'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'skills', 'broken-bundle', 'SKILL.md'), `---
name: broken-bundle
description: broken
---

# Broken Bundle
`);

    const { stderr } = await runLint();
    expect(stderr).toContain('nested packaging detected');
  });

  it('should skip workspace directories under SSOT', async () => {
    const workspaceDir = path.join(tmpDir, '.agents', 'skills', 'demo-workspace');
    fs.mkdirSync(path.join(workspaceDir, 'iteration-1'), { recursive: true });

    const { stdout, stderr } = await runLint();
    expect(stdout).toContain('skipped workspace directory');
    expect(stderr).toBe('');
  });
});

describe('lint — description safety and budgets', () => {
  function writeSkill(descriptionLine: string): void {
    const skillRoot = path.join(tmpDir, '.agents', 'skills', 'description-fixture');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---
name: description-fixture
${descriptionLine}
---

# Fixture
`);
  }

  it('fails on an unquoted trigger marker that YAML would truncate', async () => {
    writeSkill('description: Route requests through #publish only');
    const { stdout, stderr } = await runLint();
    expect(stderr).toContain('unquoted marker #publish');
    expect(stdout).toContain('Lint failed');
  });

  it('accepts a quoted trigger marker and reports lengths', async () => {
    writeSkill('description: "Route requests through #publish only"');
    const { stdout, stderr } = await runLint();
    expect(stderr).toBe('');
    expect(stdout).toContain('description chars: parsed=');
  });

  it('accepts a block-scalar description', async () => {
    writeSkill(`description: >-
  Route #publish requests through an explicit authorization gate.`);
    const { stdout, stderr } = await runLint();
    expect(stderr).toBe('');
    expect(stdout).toMatch(/source=\d+/);
  });

  it('enforces the configured description budget', async () => {
    writeSkill('description: "1234567890"');
    const { lintCommand } = await import('../src/commands/lint.js');
    const stderr: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => stderr.push(args.join(' '));
    process.exitCode = undefined as unknown as number;
    await lintCommand({ maxDescriptionChars: 5 });
    console.error = original;
    expect(stderr.join('\n')).toContain('description exceeds budget');
  });
});

describe('lint — portable script mode handling', () => {
  function writeScriptFixture(content: string): string {
    const skillRoot = path.join(tmpDir, '.agents', 'skills', 'script-fixture');
    const scriptsRoot = path.join(skillRoot, 'scripts');
    fs.mkdirSync(path.join(scriptsRoot, '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---
name: script-fixture
description: "Portable script fixture"
---
`);
    const scriptPath = path.join(scriptsRoot, 'helper.py');
    fs.writeFileSync(scriptPath, content, { mode: 0o644 });
    return scriptPath;
  }

  it('accepts interpreter-invoked files and ignores script subdirectories', async () => {
    writeScriptFixture('print("hello")\n');
    const { stdout, stderr } = await runLint();
    expect(stdout).toContain('interpreter-invoked');
    expect(stdout).toContain('All skills passed');
    expect(stderr).toBe('');
  });

  it('warns instead of failing when a shebang file loses its executable bit', async () => {
    writeScriptFixture('#!/usr/bin/env python3\nprint("hello")\n');
    const { stdout, stderr } = await runLint();
    expect(stderr).toContain('has a shebang but is not executable');
    expect(stdout).toContain('All skills passed');
  });
});
