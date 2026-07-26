import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLink, isValidLink } from '../src/platform.js';

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
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function runApply(
  dryRun = false,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.warn = (...args: unknown[]) => stderr.push(args.join(' '));
  process.exitCode = undefined as unknown as number;

  try {
    const { applyCommand } = await import('../src/commands/apply.js');
    await applyCommand({ dryRun });
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      exitCode: process.exitCode,
    };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
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

  it('should refuse an orphan marker left by an interrupted bridge removal', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    await createLink(ssotPath, claudePath);
    fs.rmSync(claudePath, { recursive: true, force: true });

    const { stderr, exitCode } = await runApply();
    expect(stderr).toContain('ASPG_LINK_ORPHAN_MARKER');
    expect(exitCode).toBe(2);
    expect(fs.existsSync(claudePath)).toBe(false);
  });

  it('atomically refreshes a broken ASPG-managed bridge', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const staleTarget = path.join(tmpDir, 'removed-skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(staleTarget);
    await createLink(staleTarget, claudePath);
    fs.rmdirSync(staleTarget);

    const { stdout, stderr, exitCode } = await runApply();
    expect(stderr).toBe('');
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('Created .claude/skills');
    expect(isValidLink(claudePath, ssotPath)).toBe(true);
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

  it('should remove SSOT marker pollution before refreshing bridges', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    fs.writeFileSync(path.join(ssotPath, '.aspg-copy-fallback'), 'pollution');

    const { stdout } = await runApply();
    expect(stdout).toContain('SSOT marker pollution');
    expect(fs.existsSync(path.join(ssotPath, '.aspg-copy-fallback'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(true);
  });

  it('should quarantine a copy-fallback bridge on darwin/linux', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(claudePath, { recursive: true });
    fs.writeFileSync(path.join(ssotPath, 'skill.txt'), 'fresh');
    fs.writeFileSync(path.join(claudePath, '.aspg-copy-fallback'), ssotPath, 'utf-8');

    const { stderr, exitCode } = await runApply();
    expect(stderr).toContain('ASPG_LINK_COPY_UNSUPPORTED');
    expect(exitCode).toBe(2);
    expect(fs.existsSync(path.join(claudePath, 'skill.txt'))).toBe(false);
  });

  it('refuses an unmanaged real bridge directory without merging into it', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.writeFileSync(path.join(ssotPath, 'canonical.txt'), 'canonical');
    fs.mkdirSync(claudePath, { recursive: true });
    fs.writeFileSync(path.join(claudePath, 'local.txt'), 'preserve');

    const { stderr, exitCode } = await runApply();
    expect(stderr).toContain('ASPG_LINK_DESTINATION_REAL_DIRECTORY');
    expect(exitCode).toBe(2);
    expect(fs.readFileSync(path.join(claudePath, 'local.txt'), 'utf-8')).toBe('preserve');
    expect(fs.existsSync(path.join(claudePath, 'canonical.txt'))).toBe(false);
  });

  it('refuses a file at the bridge destination', async () => {
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.writeFileSync(claudePath, 'preserve');

    const { stderr, exitCode } = await runApply();
    expect(stderr).toContain('ASPG_LINK_DESTINATION_FILE');
    expect(exitCode).toBe(2);
    expect(fs.readFileSync(claudePath, 'utf-8')).toBe('preserve');
  });

  it('refuses a foreign bridge link and preserves its target', async () => {
    const foreignTarget = path.join(tmpDir, 'foreign-skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(foreignTarget);
    fs.writeFileSync(path.join(foreignTarget, 'foreign.txt'), 'preserve');
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.symlinkSync(foreignTarget, claudePath, 'dir');

    const { stderr, exitCode } = await runApply();
    expect(stderr).toContain('ASPG_LINK_DESTINATION_FOREIGN_LINK');
    expect(exitCode).toBe(2);
    expect(fs.readlinkSync(claudePath)).toBe(foreignTarget);
    expect(fs.readFileSync(path.join(foreignTarget, 'foreign.txt'), 'utf-8')).toBe('preserve');
  });

  it('preflights all bridges before removing SSOT marker pollution', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    const marker = path.join(ssotPath, '.aspg-copy-fallback');
    fs.writeFileSync(marker, 'pollution');
    fs.mkdirSync(claudePath, { recursive: true });
    fs.writeFileSync(path.join(claudePath, 'local.txt'), 'preserve');

    const { stderr, exitCode } = await runApply();
    expect(stderr).toContain('ASPG_LINK_DESTINATION_REAL_DIRECTORY');
    expect(exitCode).toBe(2);
    expect(fs.readFileSync(marker, 'utf-8')).toBe('pollution');
    expect(fs.readFileSync(path.join(claudePath, 'local.txt'), 'utf-8')).toBe('preserve');
  });

  it('counts and bridges a symlinked Skill directory in the SSOT', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const canonicalSkill = path.join(tmpDir, 'canonical-skill');
    fs.mkdirSync(canonicalSkill);
    fs.writeFileSync(path.join(canonicalSkill, 'SKILL.md'), '# linked skill');
    fs.symlinkSync(canonicalSkill, path.join(ssotPath, 'linked-skill'), 'dir');

    const { stdout, stderr, exitCode } = await runApply();
    expect(stderr).toBe('');
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain('Found 1 skill(s) in SSOT: linked-skill');
    expect(
      fs.readFileSync(path.join(tmpDir, '.claude', 'skills', 'linked-skill', 'SKILL.md'), 'utf-8'),
    ).toBe('# linked skill');
  });
});
