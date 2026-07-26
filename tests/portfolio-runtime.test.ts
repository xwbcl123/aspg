import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireActivationLock,
  advanceActivationPhase,
  captureActivationSnapshot,
  createActivationOperation,
  readActivationJournal,
} from '../src/activation-journal.js';
import { hashSkillSubtreeAtRevision } from '../src/portfolio-hash.js';
import {
  executePortfolioRuntimeMutation,
  inspectPortfolioRuntime,
  repairPortfolioRuntimeOperation,
  rollbackPortfolioRuntimeOperation,
  type ExecutePortfolioRuntimeRequest,
  type ResolvedRuntimeDependency,
  type ResolvedRuntimeEntry,
} from '../src/portfolio-runtime.js';
import type { SkillSubtreeDigest } from '../src/portfolio-hash.js';

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
const stateRelative = '.aspg/deployments/work-pkm/state.yaml';

function commit(message: string): string {
  execFileSync('git', ['-C', repositoryRoot, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repositoryRoot,
      '-c',
      'user.name=ASPG Test',
      '-c',
      'user.email=aspg@example.test',
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

function dependency(): ResolvedRuntimeDependency {
  return {
    source: 'private',
    source_revision: revision,
    path: dependencyPath,
    tree_hash: dependencyDigest.tree_hash,
    executable_files: dependencyDigest.executable_files,
    id: 'work-private-demo',
    privacy: 'work-private',
    target: '.aspg/dependencies/work-private-demo',
    required: true,
    repository_root: repositoryRoot,
  };
}

function entry(): ResolvedRuntimeEntry {
  return {
    source: 'canonical',
    source_revision: revision,
    path: skillPath,
    tree_hash: skillDigest.tree_hash,
    executable_files: skillDigest.executable_files,
    skill_id: 'martin/demo',
    exposure_name: 'demo',
    repository_root: repositoryRoot,
    target: '.agents/skills/demo',
    dependencies: [dependency()],
  };
}

function request(
  backend: 'managed-link' | 'managed-materialized',
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
      target: '.aspg/generated/private-skill-packs.json',
      bytes: `${JSON.stringify({
        schema_version: 1,
        packs: [{
          pack_id: 'work-private/work-private-demo',
          root: '.aspg/dependencies/work-private-demo',
        }],
      }, null, 2)}\n`,
    }],
    mutation: 'apply',
    operation_id: `${backend}-apply`,
    now: () => '2026-07-26T21:00:00.000Z',
    ...overrides,
  };
}

function state(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, stateRelative), 'utf8'));
}

function journal(operationId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(
    path.join(stateRoot, 'operations', operationId, 'journal.json'),
    'utf8',
  ));
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-portfolio-runtime-'));
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
    '#!/bin/sh\necho demo\n',
  );
  fs.chmodSync(path.join(repositoryRoot, skillPath, 'scripts', 'run.sh'), 0o755);
  fs.writeFileSync(path.join(repositoryRoot, dependencyPath, 'README.md'), 'pack v1\n');
  fs.writeFileSync(
    path.join(repositoryRoot, dependencyPath, 'scripts', 'render.sh'),
    '#!/bin/sh\necho pack\n',
  );
  fs.chmodSync(
    path.join(repositoryRoot, dependencyPath, 'scripts', 'render.sh'),
    0o755,
  );
  execFileSync('git', ['init', '-q', repositoryRoot]);
  revision = commit('base');
  refreshDigests();
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('fixture-only Portfolio runtime executor', () => {
  it('applies managed links, persists portable state, and refreshes idempotently', () => {
    const first = executePortfolioRuntimeMutation(request('managed-link'));
    expect(first).toMatchObject({
      phase: 'committed',
      generation: 1,
      backend: 'managed-link',
    });
    expect(first.targets.map((target) => target.action)).toEqual(['created', 'created']);
    const skillTarget = path.join(runtimeRoot, 'demo');
    const dependencyTarget = path.join(
      projectRoot,
      '.aspg',
      'dependencies',
      'work-private-demo',
    );
    expect(fs.lstatSync(skillTarget).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(dependencyTarget).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(skillTarget)).toBe(
      fs.realpathSync(path.join(repositoryRoot, skillPath)),
    );
    expect(fs.realpathSync(dependencyTarget)).toBe(
      fs.realpathSync(path.join(repositoryRoot, dependencyPath)),
    );
    expect(fs.readdirSync(runtimeRoot).sort()).toEqual(['demo']);
    expect(state()).toMatchObject({
      generation: 1,
      deployment: 'work-pkm',
      entries: [{
        backend: 'managed-link',
        target: '.agents/skills/demo',
        dependencies: [{ target: '.aspg/dependencies/work-private-demo' }],
      }],
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(projectRoot, '.aspg', 'generated', 'private-skill-packs.json'),
      'utf8',
    ))).toEqual({
      schema_version: 1,
      packs: [{
        pack_id: 'work-private/work-private-demo',
        root: '.aspg/dependencies/work-private-demo',
      }],
    });
    expect(journal('managed-link-apply')).toMatchObject({ phase: 'committed' });

    const second = executePortfolioRuntimeMutation(request('managed-link', {
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'managed-link-refresh',
    }));
    expect(second.targets.map((target) => target.action)).toEqual(['noop', 'noop']);
    expect(state()).toMatchObject({ generation: 2 });
    expect(inspectPortfolioRuntime(request('managed-link', {
      current_generation: 2,
      next_generation: 3,
      mutation: 'refresh',
      operation_id: 'inspection-only',
    }))).toMatchObject({
      health: 'in-sync',
      blocking: false,
      state_generation: 2,
      targets: [
        { id: 'martin/demo', health: 'in-sync' },
        { id: 'work-private-demo', health: 'in-sync' },
        { id: 'private-skill-packs', health: 'in-sync' },
      ],
    });
    expect(
      fs.readdirSync(runtimeRoot).some((name) => name.includes('aspg-managed-link')),
    ).toBe(false);
  });

  it('applies and refreshes managed materialization from pinned Git objects', () => {
    const first = executePortfolioRuntimeMutation(request('managed-materialized'));
    expect(first.targets.map((target) => target.action)).toEqual(['created', 'created']);
    expect(fs.lstatSync(path.join(runtimeRoot, 'demo')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(runtimeRoot, 'demo', 'SKILL.md'), 'utf8'))
      .toBe('demo v1\n');

    fs.writeFileSync(path.join(repositoryRoot, skillPath, 'SKILL.md'), 'demo v2\n');
    fs.writeFileSync(path.join(repositoryRoot, dependencyPath, 'README.md'), 'pack v2\n');
    revision = commit('v2');
    refreshDigests();
    const refreshed = executePortfolioRuntimeMutation(request('managed-materialized', {
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'managed-copy-refresh',
    }));
    expect(refreshed.targets.map((target) => target.action))
      .toEqual(['refreshed', 'refreshed']);
    expect(fs.readFileSync(path.join(runtimeRoot, 'demo', 'SKILL.md'), 'utf8'))
      .toBe('demo v2\n');
    expect(fs.readFileSync(path.join(
      projectRoot,
      '.aspg',
      'dependencies',
      'work-private-demo',
      'README.md',
    ), 'utf8'))
      .toBe('pack v2\n');
    expect(state()).toMatchObject({
      generation: 2,
      entries: [{ backend: 'managed-materialized' }],
    });
    expect(inspectPortfolioRuntime(request('managed-materialized', {
      current_generation: 2,
      next_generation: 3,
      mutation: 'refresh',
      operation_id: 'copy-inspection',
    }))).toMatchObject({ health: 'in-sync', blocking: false });
  });

  it('blocks a missing required dependency, rolls back, and does not commit state', () => {
    executePortfolioRuntimeMutation(request('managed-materialized'));
    const stateBefore = fs.readFileSync(path.join(projectRoot, stateRelative));
    const skillBefore = fs.readFileSync(path.join(runtimeRoot, 'demo', 'SKILL.md'));
    fs.rmSync(path.join(
      projectRoot,
      '.aspg',
      'dependencies',
      'work-private-demo',
    ), { recursive: true });

    expect(() => executePortfolioRuntimeMutation(request('managed-materialized', {
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'dependency-block',
    }))).toThrow(/ASPG_MATERIALIZE_DEPENDENCY_MISSING/);
    expect(journal('dependency-block')).toMatchObject({
      phase: 'rolled-back',
      generation: 2,
    });
    expect(fs.readFileSync(path.join(projectRoot, stateRelative))).toEqual(stateBefore);
    expect(fs.readFileSync(path.join(runtimeRoot, 'demo', 'SKILL.md'))).toEqual(skillBefore);
    expect(fs.existsSync(path.join(
      projectRoot,
      '.aspg',
      'dependencies',
      'work-private-demo',
    ))).toBe(false);
  });

  it('repairs and explicitly rolls back interrupted journal snapshots', () => {
    const statePath = path.join(projectRoot, stateRelative);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const target = path.join(runtimeRoot, 'demo');
    fs.symlinkSync(path.join(repositoryRoot, skillPath), target);

    const interrupted = createActivationOperation({
      fixtureRoot,
      stateRoot,
      targetRoot: projectRoot,
      portableStatePath: statePath,
      portfolio: 'main',
      deployment: 'work-pkm',
      projectRef: 'work-pkm',
      deviceId: 'test-device',
      mutation: 'repair',
      expectedGeneration: 0,
      operationId: 'interrupted-repair',
    });
    acquireActivationLock(interrupted);
    captureActivationSnapshot(interrupted, ['.agents/skills/demo']);
    advanceActivationPhase(interrupted, 'staged');
    fs.unlinkSync(target);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'partial.txt'), 'partial');
    advanceActivationPhase(interrupted, 'activated');

    expect(repairPortfolioRuntimeOperation({
      fixture_root: fixtureRoot,
      state_root: stateRoot,
      operation_id: 'interrupted-repair',
    })).toMatchObject({ phase: 'rolled-back' });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(
      fs.realpathSync(path.join(repositoryRoot, skillPath)),
    );

    const explicit = createActivationOperation({
      fixtureRoot,
      stateRoot,
      targetRoot: projectRoot,
      portableStatePath: statePath,
      portfolio: 'main',
      deployment: 'another',
      projectRef: 'work-pkm',
      deviceId: 'test-device',
      mutation: 'rollback',
      expectedGeneration: 0,
      operationId: 'explicit-rollback',
    });
    acquireActivationLock(explicit);
    captureActivationSnapshot(explicit, ['.agents/skills/demo']);
    advanceActivationPhase(explicit, 'staged');
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(repositoryRoot, dependencyPath), target);
    expect(rollbackPortfolioRuntimeOperation({
      fixture_root: fixtureRoot,
      state_root: stateRoot,
      operation_id: 'explicit-rollback',
    })).toMatchObject({ phase: 'rolled-back' });
    expect(fs.realpathSync(target)).toBe(
      fs.realpathSync(path.join(repositoryRoot, skillPath)),
    );
  });

  it('refuses real projects and reports provider conflicts without target writes', () => {
    const realTarget = path.join(process.cwd(), '.agents', 'skills', 'never-runtime-test');
    expect(() => executePortfolioRuntimeMutation({
      ...request('managed-link'),
      fixture_root: process.cwd(),
      project_root: process.cwd(),
      runtime_root: path.join(process.cwd(), '.agents', 'skills'),
      state_root: path.join(process.cwd(), '.aspg-device-state'),
      entries: [{
        ...entry(),
        target: '.agents/skills/never-runtime-test',
        dependencies: [],
      }],
      operation_id: 'real-project-refused',
    })).toThrow(/ASPG_RUNTIME_REAL_PROJECT_REFUSED/);
    expect(fs.existsSync(realTarget)).toBe(false);

    const conflicted = request('managed-materialized', {
      google_drive: {
        status: 'conflict',
        hydrated: true,
        writable: false,
        reason: 'sync conflict',
      },
      operation_id: 'provider-conflict',
    });
    expect(inspectPortfolioRuntime(conflicted)).toMatchObject({
      health: 'provider-conflict',
      blocking: true,
    });
    expect(() => executePortfolioRuntimeMutation(conflicted))
      .toThrow(/ASPG_RUNTIME_PROVIDER_NOT_READY/);
    expect(fs.readdirSync(runtimeRoot)).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, stateRelative))).toBe(false);
  });
});
