import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireActivationLock,
  createActivationOperation,
  releaseActivationLock,
} from '../src/activation-journal.js';
import {
  hashSkillSubtreeAtRevision,
  type SkillSubtreeDigest,
} from '../src/portfolio-hash.js';
import {
  executePortfolioRuntimeMutation,
  inspectPortfolioRuntime,
  type ExecutePortfolioRuntimeRequest,
  type ResolvedRuntimeDependency,
  type ResolvedRuntimeEntry,
} from '../src/portfolio-runtime.js';

let fixtureRoot: string;
let projectRoot: string;
let runtimeRoot: string;
let stateRoot: string;
let repositoryRoot: string;
let revision: string;
let skillDigest: SkillSubtreeDigest;
let dependencyDigest: SkillSubtreeDigest;

const skillPath = 'skills/audit';
const dependencyPath = 'packs/work-private/audit-pack';
const stateRelative = '.aspg/deployments/work/state.yaml';
const generatedRelative = '.aspg/generated/private-skill-packs.json';

function commitFixture(): string {
  execFileSync('git', ['-C', repositoryRoot, 'add', '.']);
  execFileSync('git', [
    '-C',
    repositoryRoot,
    '-c',
    'user.name=ASPG Audit Test',
    '-c',
    'user.email=aspg-audit@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return execFileSync(
    'git',
    ['-C', repositoryRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
}

function dependency(): ResolvedRuntimeDependency {
  return {
    source: 'private',
    source_revision: revision,
    path: dependencyPath,
    tree_hash: dependencyDigest.tree_hash,
    executable_files: dependencyDigest.executable_files,
    id: 'audit-pack',
    privacy: 'work-private',
    target: '.aspg/dependencies/audit-pack',
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
    skill_id: 'martin/audit',
    exposure_name: 'audit',
    repository_root: repositoryRoot,
    target: '.agents/skills/audit',
    dependencies: [dependency()],
  };
}

function generatedBytes(): string {
  return `${JSON.stringify({
    schema_version: 1,
    packs: [{
      pack_id: 'work-private/audit-pack',
      root: '.aspg/dependencies/audit-pack',
    }],
  }, null, 2)}\n`;
}

function request(
  overrides: Partial<ExecutePortfolioRuntimeRequest> = {},
): ExecutePortfolioRuntimeRequest {
  return {
    fixture_root: fixtureRoot,
    project_root: projectRoot,
    runtime_root: runtimeRoot,
    state_root: stateRoot,
    storage_provider: 'local-filesystem',
    deployment_backend: 'managed-link',
    portfolio: 'audit',
    deployment: 'work',
    project_ref: 'work-project',
    device_id: 'test-device',
    lock_revision: revision,
    current_generation: 0,
    next_generation: 1,
    entries: [entry()],
    generated_files: [{
      target: generatedRelative,
      bytes: generatedBytes(),
    }],
    mutation: 'apply',
    operation_id: 'audit-apply',
    now: () => '2026-07-26T22:00:00.000Z',
    ...overrides,
  };
}

function inventory(root: string): string[] {
  const result: string[] = [];
  const visit = (current: string, relative: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        result.push(`link:${child}:${fs.readlinkSync(absolute)}`);
      } else if (stat.isDirectory()) {
        result.push(`dir:${child}`);
        visit(absolute, child);
      } else {
        result.push(`file:${child}:${fs.readFileSync(absolute).toString('base64')}`);
      }
    }
  };
  visit(root, '');
  return result;
}

function portableState(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, stateRelative), 'utf8'),
  ) as Record<string, unknown>;
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-runtime-audit-'));
  projectRoot = path.join(fixtureRoot, 'project');
  runtimeRoot = path.join(projectRoot, '.agents', 'skills');
  stateRoot = path.join(fixtureRoot, 'device-state');
  repositoryRoot = path.join(fixtureRoot, 'source', 'canonical');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.aspg'), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, skillPath), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, dependencyPath), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, skillPath, 'SKILL.md'), 'audit skill\n');
  fs.writeFileSync(
    path.join(repositoryRoot, dependencyPath, 'README.md'),
    'private audit pack\n',
  );
  execFileSync('git', ['init', '-q', repositoryRoot]);
  revision = commitFixture();
  skillDigest = hashSkillSubtreeAtRevision(repositoryRoot, {
    revision,
    sourcePath: skillPath,
  });
  dependencyDigest = hashSkillSubtreeAtRevision(repositoryRoot, {
    revision,
    sourcePath: dependencyPath,
  });
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Portfolio runtime audit regressions', () => {
  it('rejects refresh removal of an existing managed target with zero writes', () => {
    executePortfolioRuntimeMutation(request());
    const before = inventory(fixtureRoot);

    expect(() => executePortfolioRuntimeMutation(request({
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'audit-remove-dependency',
      entries: [{ ...entry(), dependencies: [] }],
      generated_files: [],
    }))).toThrow(/ASPG_RUNTIME_REMOVAL_REQUIRED/);

    expect(inventory(fixtureRoot)).toEqual(before);
    expect(fs.lstatSync(
      path.join(projectRoot, '.aspg', 'dependencies', 'audit-pack'),
    ).isSymbolicLink()).toBe(true);
    expect(portableState()).toMatchObject({ generation: 1 });
  });

  it('reports generated private config drift and fails refresh closed with zero writes', () => {
    executePortfolioRuntimeMutation(request());
    const generatedPath = path.join(projectRoot, generatedRelative);
    fs.writeFileSync(generatedPath, `${generatedBytes()}local drift\n`);
    const before = inventory(fixtureRoot);
    const refresh = request({
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'audit-generated-drift',
    });

    const inspection = inspectPortfolioRuntime(refresh);
    expect(inspection).toMatchObject({
      health: 'local-drift',
      blocking: true,
    });
    expect(inspection.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'private-skill-packs',
        kind: 'generated',
        health: 'local-drift',
        blocking: true,
      }),
    ]));
    expect(inventory(fixtureRoot)).toEqual(before);

    expect(() => executePortfolioRuntimeMutation(refresh))
      .toThrow(/ASPG_RUNTIME_GENERATED_CONFIG_DRIFT/);
    expect(inventory(fixtureRoot)).toEqual(before);
    expect(portableState()).toMatchObject({ generation: 1 });
    expect(fs.readFileSync(generatedPath, 'utf8')).toContain('local drift');
  });

  it('reports a released lock with an unsettled generation claim as transition-incomplete', () => {
    executePortfolioRuntimeMutation(request());
    const interrupted = createActivationOperation({
      fixtureRoot,
      stateRoot,
      targetRoot: projectRoot,
      portableStatePath: path.join(projectRoot, stateRelative),
      portfolio: 'audit',
      deployment: 'work',
      projectRef: 'work-project',
      deviceId: 'test-device',
      mutation: 'refresh',
      expectedGeneration: 1,
      operationId: 'audit-interrupted-claim',
      now: () => '2026-07-26T22:01:00.000Z',
    });
    acquireActivationLock(interrupted);
    releaseActivationLock(interrupted);
    const before = inventory(fixtureRoot);

    expect(inspectPortfolioRuntime(request({
      current_generation: 1,
      next_generation: 2,
      mutation: 'refresh',
      operation_id: 'audit-transition-inspection',
    }))).toMatchObject({
      health: 'transition-incomplete',
      blocking: true,
      state_generation: 1,
    });
    expect(inventory(fixtureRoot)).toEqual(before);
  });
});
