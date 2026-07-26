import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSkillSubtreeAtRevision, type SkillSubtreeDigest } from '../src/portfolio-hash.js';
import {
  executePortfolioRuntimeMutation,
  type ExecutePortfolioRuntimeRequest,
  type ResolvedRuntimeDependency,
  type ResolvedRuntimeEntry,
} from '../src/portfolio-runtime.js';

type Backend = 'managed-link' | 'managed-materialized';

let fixtureRoot: string;
let projectRoot: string;
let runtimeRoot: string;
let stateRoot: string;
let repositoryRoot: string;
let revision: string;
let skillDigest: SkillSubtreeDigest;
let dependencyDigest: SkillSubtreeDigest;

const skillPath = 'skills/demo';
const dependencyPath = 'packs/work-private/demo';
const extraDependencyPath = 'packs/work-private/extra';
const skillTargetRelative = '.agents/skills/demo';
const dependencyTargetRelative = '.aspg/dependencies/work-private-demo';
const extraDependencyTargetRelative = '.aspg/dependencies/extra-pack';
const generatedTargetRelative = '.aspg/generated/private-skill-packs.json';
const stateRelative = '.aspg/deployments/work-pkm/state.yaml';

function commit(message: string): string {
  execFileSync('git', ['-C', repositoryRoot, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repositoryRoot,
      '-c',
      'user.name=ASPG Boundary Test',
      '-c',
      'user.email=aspg-boundary@example.test',
      'commit',
      '-qm',
      message,
    ],
  );
  return execFileSync(
    'git',
    ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
}

function refreshDigests(): void {
  skillDigest = hashSkillSubtreeAtRevision(repositoryRoot, {
    revision,
    sourcePath: skillPath,
  });
  dependencyDigest = hashSkillSubtreeAtRevision(repositoryRoot, {
    revision,
    sourcePath: dependencyPath,
  });
}

function dependency(
  target = dependencyTargetRelative,
): ResolvedRuntimeDependency {
  return {
    source: 'private',
    source_revision: revision,
    path: dependencyPath,
    tree_hash: dependencyDigest.tree_hash,
    executable_files: dependencyDigest.executable_files,
    id: 'work-private-demo',
    privacy: 'work-private',
    target,
    required: true,
    repository_root: repositoryRoot,
  };
}

function entry(
  dependencyTarget = dependencyTargetRelative,
): ResolvedRuntimeEntry {
  return {
    source: 'private',
    source_revision: revision,
    path: skillPath,
    tree_hash: skillDigest.tree_hash,
    executable_files: skillDigest.executable_files,
    skill_id: 'martin/demo',
    exposure_name: 'demo',
    repository_root: repositoryRoot,
    target: skillTargetRelative,
    dependencies: [dependency(dependencyTarget)],
  };
}

function generatedBytes(includeExtra = false): string {
  const packs = [
    ...(includeExtra ? [{
      pack_id: 'work-private/extra-pack',
      root: extraDependencyTargetRelative,
    }] : []),
    {
      pack_id: 'work-private/work-private-demo',
      root: dependencyTargetRelative,
    },
  ];
  return `${JSON.stringify({
    schema_version: 1,
    packs,
  }, null, 2)}\n`;
}

function request(
  backend: Backend,
  overrides: Partial<ExecutePortfolioRuntimeRequest> = {},
): ExecutePortfolioRuntimeRequest {
  return {
    fixture_root: fixtureRoot,
    project_root: projectRoot,
    runtime_root: runtimeRoot,
    state_root: stateRoot,
    storage_provider: backend === 'managed-link'
      ? 'local-filesystem'
      : 'google-drive-file-provider',
    deployment_backend: backend,
    google_drive: backend === 'managed-materialized'
      ? { status: 'online', hydrated: true, writable: true }
      : undefined,
    portfolio: 'main',
    deployment: 'work-pkm',
    project_ref: 'work-pkm',
    device_id: 'test-device',
    lock_revision: revision,
    current_generation: 0,
    next_generation: 1,
    entries: [entry()],
    generated_files: [{
      target: generatedTargetRelative,
      bytes: generatedBytes(),
    }],
    mutation: 'apply',
    operation_id: `${backend}-boundary-apply`,
    now: () => '2026-07-26T21:30:00.000Z',
    ...overrides,
  };
}

function absolute(relative: string): string {
  return path.join(projectRoot, ...relative.split('/'));
}

function portableState(): any {
  return JSON.parse(fs.readFileSync(absolute(stateRelative), 'utf8'));
}

function injectedIoFailure(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: 'EIO' });
}

beforeEach(() => {
  fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-runtime-boundary-')),
  );
  projectRoot = path.join(fixtureRoot, 'project');
  runtimeRoot = path.join(projectRoot, '.agents', 'skills');
  stateRoot = path.join(fixtureRoot, 'device-state');
  repositoryRoot = path.join(fixtureRoot, 'source', 'canonical');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.aspg'), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, skillPath, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, dependencyPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, skillPath, 'SKILL.md'), 'demo v1\n');
  fs.writeFileSync(
    path.join(repositoryRoot, skillPath, 'scripts', 'run.sh'),
    '#!/bin/sh\necho demo v1\n',
  );
  fs.chmodSync(path.join(repositoryRoot, skillPath, 'scripts', 'run.sh'), 0o755);
  fs.writeFileSync(path.join(repositoryRoot, dependencyPath, 'README.md'), 'pack v1\n');
  fs.writeFileSync(
    path.join(repositoryRoot, dependencyPath, 'scripts', 'render.sh'),
    '#!/bin/sh\necho pack v1\n',
  );
  fs.chmodSync(
    path.join(repositoryRoot, dependencyPath, 'scripts', 'render.sh'),
    0o755,
  );
  execFileSync('git', ['init', '-q', repositoryRoot]);
  revision = commit('boundary v1');
  refreshDigests();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Wave 6 Portfolio transaction boundaries', () => {
  it.each<Backend>(['managed-link', 'managed-materialized'])(
    'keeps the Skill in runtime and its dependency/config/state in project scope for %s',
    (backend) => {
      const result = executePortfolioRuntimeMutation(request(backend));
      const skillTarget = absolute(skillTargetRelative);
      const dependencyTarget = absolute(dependencyTargetRelative);

      expect(result.phase).toBe('committed');
      expect(result.targets).toEqual([
        expect.objectContaining({
          id: 'martin/demo',
          kind: 'skill',
          target: skillTargetRelative,
        }),
        expect.objectContaining({
          id: 'work-private-demo',
          kind: 'dependency',
          target: dependencyTargetRelative,
        }),
      ]);
      expect(path.relative(runtimeRoot, skillTarget)).not.toMatch(/^\.\./);
      expect(path.relative(runtimeRoot, dependencyTarget)).toMatch(/^\.\./);
      expect(path.relative(projectRoot, dependencyTarget)).not.toMatch(/^\.\./);
      expect(fs.existsSync(skillTarget)).toBe(true);
      expect(fs.existsSync(dependencyTarget)).toBe(true);
      expect(fs.existsSync(absolute(generatedTargetRelative))).toBe(true);
      expect(portableState()).toMatchObject({
        generation: 1,
        entries: [{
          target: skillTargetRelative,
          backend,
          dependencies: [{
            target: dependencyTargetRelative,
            required: true,
          }],
        }],
      });
      if (backend === 'managed-link') {
        expect(fs.lstatSync(skillTarget).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(dependencyTarget).isSymbolicLink()).toBe(true);
      } else {
        expect(fs.lstatSync(skillTarget).isDirectory()).toBe(true);
        expect(fs.lstatSync(dependencyTarget).isDirectory()).toBe(true);
      }
    },
  );

  it.each([
    ['managed-link', 'rename'],
    ['managed-materialized', 'rename'],
    ['managed-link', 'write'],
    ['managed-materialized', 'write'],
  ] as const)(
    'rolls back targets, generated config and state on %s after generated-file %s failure',
    (backend, failureKind) => {
      const generatedTarget = absolute(generatedTargetRelative);
      if (failureKind === 'rename') {
        const original = fs.renameSync.bind(fs);
        vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
          if (path.resolve(String(target)) === generatedTarget) {
            throw injectedIoFailure('injected generated rename failure');
          }
          return original(source, target);
        });
      } else {
        const original = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, 'writeFileSync').mockImplementation((
          file: fs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          options?: fs.WriteFileOptions,
        ) => {
          if (
            typeof file === 'number'
            && typeof data === 'string'
            && data.includes('"schema_version": 1')
          ) {
            throw injectedIoFailure('injected generated write failure');
          }
          return original(file, data, options);
        });
      }

      expect(() => executePortfolioRuntimeMutation(request(backend, {
        operation_id: `${backend}-generated-${failureKind}-failure`,
      }))).toThrow(/injected generated/);
      expect(fs.existsSync(absolute(skillTargetRelative))).toBe(false);
      expect(fs.existsSync(absolute(dependencyTargetRelative))).toBe(false);
      expect(fs.existsSync(generatedTarget)).toBe(false);
      expect(fs.existsSync(absolute(stateRelative))).toBe(false);
    },
  );

  it('restores original generated config, targets and state after a later refresh failure', () => {
    executePortfolioRuntimeMutation(request('managed-materialized'));
    const configPath = absolute(generatedTargetRelative);
    const statePath = absolute(stateRelative);
    const originalConfig = fs.readFileSync(configPath);
    const originalState = fs.readFileSync(statePath);
    const originalSkill = fs.readFileSync(path.join(absolute(skillTargetRelative), 'SKILL.md'));
    const originalDependency = fs.readFileSync(
      path.join(absolute(dependencyTargetRelative), 'README.md'),
    );

    fs.writeFileSync(path.join(repositoryRoot, skillPath, 'SKILL.md'), 'demo v2\n');
    fs.writeFileSync(path.join(repositoryRoot, dependencyPath, 'README.md'), 'pack v2\n');
    fs.mkdirSync(path.join(repositoryRoot, extraDependencyPath), { recursive: true });
    fs.writeFileSync(
      path.join(repositoryRoot, extraDependencyPath, 'README.md'),
      'extra pack v2\n',
    );
    revision = commit('boundary v2');
    refreshDigests();
    const extraDigest = hashSkillSubtreeAtRevision(repositoryRoot, {
      revision,
      sourcePath: extraDependencyPath,
    });
    const refreshEntry = entry();
    refreshEntry.dependencies.push({
      source: 'private',
      source_revision: revision,
      path: extraDependencyPath,
      tree_hash: extraDigest.tree_hash,
      executable_files: extraDigest.executable_files,
      id: 'extra-pack',
      privacy: 'work-private',
      target: extraDependencyTargetRelative,
      required: true,
      repository_root: repositoryRoot,
    });

    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (path.resolve(String(target)) === statePath) {
        throw injectedIoFailure('injected state activation failure');
      }
      return originalRename(source, target);
    });

    expect(() => executePortfolioRuntimeMutation(request('managed-materialized', {
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'refresh-after-config-failure',
      entries: [refreshEntry],
      generated_files: [{
        target: generatedTargetRelative,
        bytes: generatedBytes(true),
      }],
    }))).toThrow(/injected state activation failure/);
    expect(fs.readFileSync(configPath)).toEqual(originalConfig);
    expect(fs.readFileSync(statePath)).toEqual(originalState);
    expect(fs.readFileSync(path.join(absolute(skillTargetRelative), 'SKILL.md')))
      .toEqual(originalSkill);
    expect(fs.readFileSync(path.join(absolute(dependencyTargetRelative), 'README.md')))
      .toEqual(originalDependency);
    expect(fs.existsSync(absolute(extraDependencyTargetRelative))).toBe(false);
  });

  it('rejects dependency and generated targets outside their dedicated namespaces', () => {
    expect(() => executePortfolioRuntimeMutation(request('managed-link', {
      entries: [entry('.aspg/dependencies-escape/private-pack')],
      operation_id: 'dependency-target-escape',
    }))).toThrow(/ASPG_RUNTIME_TARGET_INVALID/);
    expect(() => executePortfolioRuntimeMutation(request('managed-link', {
      generated_files: [{
        target: '.aspg/generated-escape/private-skill-packs.json',
        bytes: generatedBytes(),
      }],
      operation_id: 'generated-target-escape',
    }))).toThrow(/ASPG_RUNTIME_GENERATED_PATH_INVALID/);
    expect(fs.existsSync(absolute(skillTargetRelative))).toBe(false);
    expect(fs.existsSync(absolute(dependencyTargetRelative))).toBe(false);
    expect(fs.existsSync(absolute(stateRelative))).toBe(false);
  });

  it('blocks required dependency executable-mode drift without advancing state or config', () => {
    executePortfolioRuntimeMutation(request('managed-materialized'));
    const configBefore = fs.readFileSync(absolute(generatedTargetRelative));
    const stateBefore = fs.readFileSync(absolute(stateRelative));
    const dependencyExecutable = path.join(
      absolute(dependencyTargetRelative),
      'scripts',
      'render.sh',
    );
    fs.chmodSync(dependencyExecutable, 0o644);

    expect(() => executePortfolioRuntimeMutation(request('managed-materialized', {
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'dependency-mode-drift',
      generated_files: [{
        target: generatedTargetRelative,
        bytes: generatedBytes(),
      }],
    }))).toThrow(/DEPENDENCY_MODE_DRIFT|DEPENDENCY_VERIFY_FAILED/);
    expect(fs.statSync(dependencyExecutable).mode & 0o111).toBe(0);
    expect(fs.readFileSync(absolute(generatedTargetRelative))).toEqual(configBefore);
    expect(fs.readFileSync(absolute(stateRelative))).toEqual(stateBefore);
  });
});
