import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLink } from '../src/platform.js';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-clean-'));
  origCwd = process.cwd();
  process.chdir(tmpDir);
  // Create SSOT
  fs.mkdirSync(path.join(tmpDir, '.agents', 'skills'), { recursive: true });
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runClean(dryRun = false): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.warn = (...args: unknown[]) => stderr.push(args.join(' '));

  const { cleanCommand } = await import('../src/commands/clean.js');
  await cleanCommand({ dryRun });

  console.log = origLog;
  console.error = origError;
  console.warn = origWarn;
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('clean — native vendor legacy bridge', () => {
  it('should remove ASPG-generated bridge for native vendor', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    await createLink(ssotPath, codexPath);
    expect(fs.existsSync(codexPath)).toBe(true);

    const { stdout } = await runClean();
    expect(stdout).toContain('Removed');
    expect(stdout).toContain('codex');
    expect(fs.existsSync(codexPath)).toBe(false);
  });

  it('should not remove non-ASPG directory for native vendor', async () => {
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    fs.mkdirSync(codexPath, { recursive: true });
    fs.writeFileSync(path.join(codexPath, 'user-file.txt'), 'keep');

    const { stdout } = await runClean();
    expect(stdout).toContain('not ASPG-managed');
    expect(fs.existsSync(codexPath)).toBe(true);
  });

  it('should remove ASPG-generated bridge for bridge vendor', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    await createLink(ssotPath, claudePath);

    const { stdout } = await runClean();
    expect(stdout).toContain('Removed');
    expect(stdout).toContain('claude');
    expect(fs.existsSync(claudePath)).toBe(false);
  });

  it('should preserve SSOT directory', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    await runClean();
    expect(fs.existsSync(ssotPath)).toBe(true);
  });
});

describe('clean --dry-run — preview accuracy', () => {
  it('should show "Would remove" for ASPG-managed bridge', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    await createLink(ssotPath, claudePath);

    const { stdout } = await runClean(true);
    expect(stdout).toContain('Would remove');
    expect(stdout).toContain('claude');
    // Should NOT actually remove
    expect(fs.existsSync(claudePath)).toBe(true);
  });

  it('should show "Would skip" for non-ASPG directory', async () => {
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    fs.mkdirSync(codexPath, { recursive: true });
    fs.writeFileSync(path.join(codexPath, 'user-file.txt'), 'keep');

    const { stdout } = await runClean(true);
    expect(stdout).toContain('Would skip');
    expect(stdout).toContain('not ASPG-managed');
    expect(stdout).toContain('codex');
  });
});
