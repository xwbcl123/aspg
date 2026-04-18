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
  vi.restoreAllMocks();
});

async function runDoctor(): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => stdout.push(args.join(' '));
  console.error = (...args: unknown[]) => stderr.push(args.join(' '));
  console.warn = (...args: unknown[]) => stderr.push(args.join(' '));
  process.exitCode = undefined as unknown as number;

  // Re-import to get fresh module
  const { doctorCommand } = await import('../src/commands/doctor.js');
  await doctorCommand();

  console.log = origLog;
  console.error = origError;
  console.warn = origWarn;
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
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

  it('should report SSOT marker pollution distinctly from copy out-of-sync', async () => {
    const ssotPath = path.join(tmpDir, '.agents', 'skills');
    const claudePath = path.join(tmpDir, '.claude', 'skills');
    fs.writeFileSync(path.join(ssotPath, 'skill.txt'), 'fresh');
    fs.writeFileSync(path.join(ssotPath, COPY_MARKER), 'pollution');
    fs.mkdirSync(claudePath, { recursive: true });
    fs.writeFileSync(path.join(claudePath, COPY_MARKER), ssotPath, 'utf-8');

    const { stderr } = await runDoctor();
    expect(stderr).toContain('SSOT polluted by copy-fallback marker');
    expect(stderr).toContain('copy fallback check blocked by SSOT marker pollution');
    expect(stderr).not.toContain('copy fallback, OUT OF SYNC');
  });
});
