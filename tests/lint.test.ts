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
