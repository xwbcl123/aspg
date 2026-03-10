import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLink } from '../src/platform.js';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-apply-'));
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

async function runApply(dryRun = false): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.warn = (...args: unknown[]) => stderr.push(args.join(' '));
  process.exitCode = undefined as unknown as number;

  const { applyCommand } = await import('../src/commands/apply.js');
  await applyCommand({ dryRun });

  console.log = origLog;
  console.error = origError;
  console.warn = origWarn;
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('apply — native vendor regression guard', () => {
  it('should not create bridge for native vendor', async () => {
    await runApply();

    // codex and opencode bridges should NOT be created
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.opencode', 'skills'))).toBe(false);
  });

  it('should not recreate bridge for native vendor even with stale state', async () => {
    // Create a stale bridge for codex, then remove the link target
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    await createLink(ssotPath, codexPath);
    // Now remove it to simulate stale state
    fs.rmSync(codexPath, { recursive: true, force: true });

    await runApply();

    // apply should NOT recreate the codex bridge
    expect(fs.existsSync(codexPath)).toBe(false);
  });

  it('should create bridge for bridge vendor (claude)', async () => {
    await runApply();

    const claudePath = path.join(tmpDir, '.claude', 'skills');
    expect(fs.existsSync(claudePath)).toBe(true);
  });

  it('should refresh stale bridge for bridge vendor', async () => {
    // Create claude bridge, then remove it
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    await createLink(ssotPath, claudePath);
    fs.rmSync(claudePath, { recursive: true, force: true });

    const { stdout } = await runApply();
    expect(stdout).toContain('claude');
    expect(fs.existsSync(claudePath)).toBe(true);
  });

  it('should not touch surviving legacy bridge for native vendor', async () => {
    // Simulate a legacy ASPG-managed bridge that still exists for a native vendor
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    await createLink(ssotPath, codexPath);

    const linkExistedBefore = fs.existsSync(codexPath);
    expect(linkExistedBefore).toBe(true);

    const { stdout } = await runApply();

    // apply must not refresh, replace, or recreate the native vendor bridge
    // stdout may mention 'Created' for bridge vendors (claude), but NOT for codex
    expect(stdout).not.toMatch(/codex/);
  });

  it('should not touch surviving legacy copy-fallback for native vendor', async () => {
    // Create a copy-fallback bridge for opencode (native vendor)
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const opencodePath = path.join(tmpDir, '.opencode', 'skills');
    fs.mkdirSync(opencodePath, { recursive: true });
    fs.writeFileSync(path.join(opencodePath, '.aspg-copy-fallback'), ssotPath, 'utf-8');

    await runApply();

    // apply must not refresh or recreate
    expect(fs.existsSync(opencodePath)).toBe(true);
    // The marker should remain untouched
    expect(fs.existsSync(path.join(opencodePath, '.aspg-copy-fallback'))).toBe(true);
  });
});
