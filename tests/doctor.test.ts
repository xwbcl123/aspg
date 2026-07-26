import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLink, COPY_MARKER } from '../src/platform.js';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-doctor-'));
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

async function runDoctor(): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}> {
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
    const { doctorCommand } = await import('../src/commands/doctor.js');
    await doctorCommand();
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

describe('doctor — native vendor redundancy detection', () => {
  it('should warn about ASPG-generated bridge for native vendor', async () => {
    // Create an ASPG-managed bridge for codex (native vendor)
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    await createLink(ssotPath, codexPath);

    const { stderr } = await runDoctor();
    expect(stderr).toContain('duplicate discovery risk');
    expect(stderr).toContain('codex');
  });

  it('should not misreport non-ASPG directory for native vendor', async () => {
    // Create a plain directory (not ASPG-managed) for codex
    const codexPath = path.join(tmpDir, '.codex', 'skills');
    fs.mkdirSync(codexPath, { recursive: true });

    const { stdout, stderr } = await runDoctor();
    const combined = stdout + '\n' + stderr;
    expect(combined).toContain('not ASPG-managed');
    expect(combined).not.toContain('duplicate discovery risk');
  });

  it('should not warn when native vendor has no bridge', async () => {
    const { stderr } = await runDoctor();
    // No duplicate discovery warnings should appear
    expect(stderr).not.toContain('duplicate');
    expect(stderr).not.toContain('discovery risk');
  });

  it('should show vendor classification table', async () => {
    const { stdout } = await runDoctor();
    expect(stdout).toContain('Vendor Classification:');
    expect(stdout).toContain('claude');
    expect(stdout).toContain('bridge');
    expect(stdout).toContain('native');
  });
});

describe('doctor — bridge vendor health check', () => {
  it('should report valid bridge link', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    await createLink(ssotPath, claudePath);

    const { stdout } = await runDoctor();
    expect(stdout).toContain('claude');
    expect(stdout).toContain('valid');
  });

  it('should report missing bridge link', async () => {
    const { stdout } = await runDoctor();
    expect(stdout).toContain('not created');
    expect(stdout).toContain('claude');
  });

  it('should quarantine a non-Windows copy and report SSOT pollution separately', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.writeFileSync(path.join(ssotPath, 'skill.txt'), 'fresh');
    fs.writeFileSync(path.join(ssotPath, COPY_MARKER), 'pollution');
    fs.mkdirSync(claudePath, { recursive: true });
    fs.writeFileSync(path.join(claudePath, COPY_MARKER), ssotPath, 'utf-8');

    const { stderr } = await runDoctor();
    expect(stderr).toContain('SSOT polluted by copy-fallback marker');
    expect(stderr).toContain('copy fallback is unsupported on');
    expect(stderr).not.toContain('copy fallback, OUT OF SYNC');
  });

  it('reports a foreign bridge link without changing it', async () => {
    const foreignTarget = path.join(tmpDir, 'foreign-skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(foreignTarget);
    fs.mkdirSync(path.dirname(claudePath), { recursive: true });
    fs.symlinkSync(foreignTarget, claudePath, 'dir');

    const { stderr, exitCode } = await runDoctor();
    expect(stderr).toContain('foreign or unrecorded link; refusing mutation');
    expect(exitCode).toBe(1);
    expect(fs.readlinkSync(claudePath)).toBe(foreignTarget);
  });

  it('reports a broken ASPG-managed bridge without mutating it', async () => {
    const missingTarget = path.join(tmpDir, 'removed-skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(missingTarget);
    await createLink(missingTarget, claudePath);
    fs.rmdirSync(missingTarget);

    const { stderr, exitCode } = await runDoctor();
    expect(stderr).toContain('.claude/skills — broken link');
    expect(exitCode).toBe(1);
    expect(fs.lstatSync(claudePath).isSymbolicLink()).toBe(true);
  });

  it('counts a symlinked Skill directory in the SSOT', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const canonicalSkill = path.join(tmpDir, 'canonical-skill');
    fs.mkdirSync(canonicalSkill);
    fs.writeFileSync(path.join(canonicalSkill, 'SKILL.md'), '# linked');
    fs.symlinkSync(canonicalSkill, path.join(ssotPath, 'linked-skill'), 'dir');

    const { stdout } = await runDoctor();
    expect(stdout).toContain('.agents/skills/ exists (1 skill(s))');
  });
});
