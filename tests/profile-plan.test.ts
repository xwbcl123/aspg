import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildProfilePlan, hashDirectory, type ProfilePlan } from '../src/profile-plan.js';
import { profilePlanCommand } from '../src/commands/profile.js';

const fixtureRoot = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures',
  'profile-mixed-mode',
);

let tmpDir: string;
let projectPath: string;
let manifestPath: string;
let lockPath: string;
let deviceRegistryPath: string;

beforeEach(() => {
  process.exitCode = undefined as unknown as number;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-profile-plan-'));
  fs.cpSync(fixtureRoot, tmpDir, { recursive: true });
  projectPath = path.join(tmpDir, 'project');
  manifestPath = path.join(projectPath, '.aspg', 'manifest.yaml');
  lockPath = path.join(projectPath, '.aspg', 'lock.yaml');
  deviceRegistryPath = path.join(tmpDir, 'device-registry.yaml');

  const sharedRoot = path.join(tmpDir, 'sources', 'shared');
  const derivativeRoot = path.join(tmpDir, 'sources', 'derivative');
  fs.writeFileSync(
    deviceRegistryPath,
    fs.readFileSync(deviceRegistryPath, 'utf-8')
      .replaceAll('__SHARED_ROOT__', sharedRoot)
      .replaceAll('__DERIVATIVE_ROOT__', derivativeRoot),
  );
  fs.writeFileSync(
    lockPath,
    fs.readFileSync(lockPath, 'utf-8')
      .replace('__SHARED_TREE_HASH__', hashDirectory(sharedRoot))
      .replace('__DERIVATIVE_TREE_HASH__', hashDirectory(derivativeRoot)),
  );
});

afterEach(() => {
  process.exitCode = undefined as unknown as number;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function plan(deviceId = 'macbook'): ProfilePlan {
  return buildProfilePlan({
    projectPath,
    profile: 'work-delivery',
    deviceId,
    runtime: 'codex',
    manifestPath,
    lockPath,
    deviceRegistryPath,
  });
}

function entry(result: ProfilePlan, name: string) {
  return result.entries.find((candidate) => candidate.name === name);
}

describe('profile plan — deterministic mixed mode', () => {
  it('resolves Core, managed, catalog and runtime-native entries without writes', () => {
    const before = hashDirectory(tmpDir);
    const result = plan();
    const after = hashDirectory(tmpDir);

    expect(result.errors).toEqual([]);
    expect(result.writes_performed).toBe(0);
    expect(result.concurrency.lock_acquired).toBe(false);
    expect(before).toBe(after);
    expect(entry(result, 'local-core')?.action).toBe('keep-project-local');
    expect(entry(result, 'shared-research')).toMatchObject({
      action: 'create',
      backend: 'symlink',
      ownership: 'managed-link',
    });
    expect(entry(result, 'grill-me')).toMatchObject({
      action: 'create',
      backend: 'materialize',
    });
    expect(entry(result, 'lavish-design')?.action).toBe('catalog');
    expect(entry(result, 'slides-helper')).toMatchObject({
      action: 'runtime-native',
      replacement: 'presentations-plugin',
    });
    expect(entry(result, 'native-search')).toMatchObject({
      action: 'runtime-native',
      ownership: 'runtime-native',
      replacement: 'browser-plugin',
    });
    expect(entry(result, 'old-managed')).toMatchObject({
      action: 'remove',
      previous_tree_hash: 'sha256:old-managed',
    });
  });

  it('returns byte-stable JSON for repeated runs', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()));
  });

  it('uses a device-local materialization fallback on Linux', () => {
    const result = plan('linux-server');
    expect(result.errors).toEqual([]);
    expect(entry(result, 'shared-research')?.backend).toBe('copy');
    expect(entry(result, 'grill-me')?.backend).toBe('materialize');
  });

  it('reports noop for an already-correct managed link', () => {
    const source = path.join(tmpDir, 'sources', 'shared', 'skills', 'shared-research');
    const target = path.join(projectPath, '.agents', 'skills', 'shared-research');
    fs.symlinkSync(source, target, 'dir');
    expect(entry(plan(), 'shared-research')?.action).toBe('noop');
  });

  it('fails closed when a source root is missing', () => {
    fs.writeFileSync(
      deviceRegistryPath,
      fs.readFileSync(deviceRegistryPath, 'utf-8')
        .replace(path.join(tmpDir, 'sources', 'shared'), path.join(tmpDir, 'sources', 'missing')),
    );
    expect(plan().errors.join('\n')).toContain('source path missing');
  });

  it('fails closed on source hash drift', () => {
    fs.appendFileSync(
      path.join(tmpDir, 'sources', 'shared', 'skills', 'shared-research', 'SKILL.md'),
      '\nDrift\n',
    );
    expect(plan().errors.join('\n')).toContain('source hash drift for shared');
  });

  it('fails closed on a manifest/lock revision mismatch', () => {
    fs.writeFileSync(
      lockPath,
      fs.readFileSync(lockPath, 'utf-8').replace('revision: shared-base', 'revision: other-base'),
    );
    expect(plan().errors.join('\n')).toContain('source revision mismatch for shared');
  });

  it('fails closed when a Skill source path escapes its registered root', () => {
    fs.writeFileSync(
      manifestPath,
      fs.readFileSync(manifestPath, 'utf-8')
        .replace('path: skills/shared-research', 'path: ../outside'),
    );
    expect(plan().errors.join('\n')).toContain('source path escapes shared root');
  });

  it('fails on duplicate exposed capabilities', () => {
    fs.writeFileSync(
      manifestPath,
      fs.readFileSync(manifestPath, 'utf-8')
        .replace('capabilities: [interview]', 'capabilities: [research]'),
    );
    expect(plan().errors.join('\n')).toContain('duplicate capability research');
  });

  it('fails closed when an explicit runtime-native Skill has no runtime replacement', () => {
    fs.writeFileSync(
      manifestPath,
      fs.readFileSync(manifestPath, 'utf-8')
        .replace('      search: browser-plugin\n', ''),
    );
    expect(plan().errors.join('\n')).toContain(
      'native-search: runtime-native replacement missing for runtime codex',
    );
  });

  it('fails on Profile count and description budgets', () => {
    fs.writeFileSync(
      manifestPath,
      fs.readFileSync(manifestPath, 'utf-8')
        .replace('max_skills: 4', 'max_skills: 1')
        .replace('max_description_chars: 500', 'max_description_chars: 100'),
    );
    const errors = plan().errors.join('\n');
    expect(errors).toContain('profile skill budget exceeded');
    expect(errors).toContain('profile description budget exceeded');
  });

  it('allows concurrent read-only plans without acquiring the activation lock', async () => {
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => plan()),
      Promise.resolve().then(() => plan()),
    ]);
    expect(first).toEqual(second);
    expect(fs.existsSync(path.join(projectPath, '.aspg', 'profile-activation.lock'))).toBe(false);
  });

  it('exposes the plan through deterministic CLI JSON output', async () => {
    const output: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    await profilePlanCommand('work-delivery', {
      project: projectPath,
      device: 'macbook',
      runtime: 'codex',
      deviceRegistry: deviceRegistryPath,
      json: true,
    });
    console.log = original;

    const parsed = JSON.parse(output.join('\n')) as ProfilePlan;
    expect(parsed.profile).toBe('work-delivery');
    expect(parsed.errors).toEqual([]);
    expect(parsed.writes_performed).toBe(0);
  });
});
