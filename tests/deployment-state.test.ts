import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeploymentStateError,
  inspectManagedLinkDependency,
  inspectManagedLinkTarget,
  serializePortableDeploymentState,
  writePortableDeploymentState,
} from '../src/deployment-state.js';
import { hashSkillSubtree } from '../src/portfolio-hash.js';
import type {
  DeploymentEntryState,
  PortableDeploymentState,
  ProjectedDataDependency,
} from '../src/portfolio-runtime-types.js';

const revision = 'a'.repeat(40);
const alternateRevision = 'b'.repeat(40);

let fixtureRoot: string;
let projectRoot: string;
let sourceRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-w6-link-'));
  projectRoot = path.join(fixtureRoot, 'project');
  sourceRoot = path.join(fixtureRoot, 'source');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(sourceRoot);
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function createSkill(
  relative = 'packs/work-private/example',
  executable = false,
): string {
  const root = path.join(sourceRoot, ...relative.split('/'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), '# fixture Skill\n');
  fs.writeFileSync(path.join(root, 'scripts', 'run.sh'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(root, 'scripts', 'run.sh'), executable ? 0o755 : 0o644);
  return root;
}

function dependency(
  sourcePath: string,
  target: string,
  required = true,
): ProjectedDataDependency {
  const digest = hashSkillSubtree(path.join(sourceRoot, ...sourcePath.split('/')));
  return {
    source: 'private',
    source_revision: revision,
    path: sourcePath,
    tree_hash: digest.tree_hash,
    executable_files: digest.executable_files,
    id: 'work-private/example',
    privacy: 'work-private',
    target,
    required,
  };
}

function entry(
  skillId: string,
  target: string,
  dependencies: ProjectedDataDependency[] = [],
): DeploymentEntryState {
  return {
    source: 'private',
    source_revision: revision,
    path: `skills/${skillId.split('/').at(-1)}`,
    tree_hash: `sha256:${skillId === 'martin/zeta' ? '1' : '2'}`.padEnd(71, skillId === 'martin/zeta' ? '1' : '2'),
    executable_files: ['scripts/z.sh', 'scripts/a.sh'],
    skill_id: skillId,
    exposure_name: skillId.split('/').at(-1) ?? skillId,
    target,
    backend: 'managed-link',
    health: 'in-sync',
    dependencies,
  };
}

function state(
  generation = 1,
  updatedAt = '2026-07-26T10:00:00.000Z',
): PortableDeploymentState {
  const dependencies: ProjectedDataDependency[] = [
    {
      source: 'private',
      source_revision: alternateRevision,
      path: 'packs/work-private/zeta',
      tree_hash: `sha256:${'3'.repeat(64)}`,
      executable_files: ['scripts/z.sh', 'scripts/a.sh'],
      id: 'work-private/zeta',
      privacy: 'work-private',
      target: '.agents/data/zeta',
      required: true,
    },
    {
      source: 'private',
      source_revision: alternateRevision,
      path: 'packs/work-private/alpha',
      tree_hash: `sha256:${'4'.repeat(64)}`,
      executable_files: [],
      id: 'work-private/alpha',
      privacy: 'work-private',
      target: '.agents/data/alpha',
      required: false,
    },
  ];
  return {
    version: 1,
    portfolio: 'martin',
    deployment: 'fixture',
    project_ref: 'fixture-project',
    lock_revision: revision,
    generation,
    entries: [
      entry('martin/zeta', '.agents/skills/zeta', dependencies),
      entry('martin/alpha', '.agents/skills/alpha'),
    ],
    updated_at: updatedAt,
  };
}

function createManagedLink(sourcePath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.symlinkSync(sourcePath, targetPath, 'dir');
}

function inspectDependency(
  projected: ProjectedDataDependency,
) {
  fs.mkdirSync(
    path.dirname(path.join(projectRoot, ...projected.target.split('/'))),
    { recursive: true },
  );
  return inspectManagedLinkDependency({
    fixtureRoot,
    projectRoot,
    sourceRoot,
    dependency: projected,
  });
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DeploymentStateError);
    expect((error as DeploymentStateError).code).toBe(code);
  }
}

describe('portable deployment state', () => {
  it('serializes deterministically and atomically without per-link sidecars', () => {
    const secondProject = path.join(fixtureRoot, 'project-two');
    fs.mkdirSync(secondProject);
    const first = writePortableDeploymentState({
      projectRoot,
      stateRelativePath: '.aspg/deployment-state.json',
      expectedGeneration: null,
      state: state(),
    });
    const second = writePortableDeploymentState({
      projectRoot: secondProject,
      stateRelativePath: '.aspg/deployment-state.json',
      expectedGeneration: null,
      state: state(),
    });

    expect(first.bytes).toBe(second.bytes);
    expect(first.bytes).toBe(serializePortableDeploymentState(state()));
    expect(first.state.entries.map((candidate) => candidate.skill_id))
      .toEqual(['martin/alpha', 'martin/zeta']);
    expect(first.state.entries[1]?.dependencies.map((candidate) => candidate.id))
      .toEqual(['work-private/alpha', 'work-private/zeta']);
    expect(first.state.entries[1]?.executable_files)
      .toEqual(['scripts/a.sh', 'scripts/z.sh']);
    expect(fs.readdirSync(path.join(projectRoot, '.aspg')))
      .toEqual(['deployment-state.json']);
    expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
  });

  it('enforces monotonic generation and leaves bytes unchanged on conflicts', () => {
    const stateRelativePath = '.aspg/deployment-state.json';
    const first = writePortableDeploymentState({
      projectRoot,
      stateRelativePath,
      expectedGeneration: null,
      state: state(),
    });
    const before = fs.readFileSync(first.path);

    expectCode(() => writePortableDeploymentState({
      projectRoot,
      stateRelativePath,
      expectedGeneration: 0,
      state: state(2, '2026-07-26T10:01:00.000Z'),
    }), 'ASPG_STATE_GENERATION_CONFLICT');
    expectCode(() => writePortableDeploymentState({
      projectRoot,
      stateRelativePath,
      expectedGeneration: 1,
      state: state(3, '2026-07-26T10:02:00.000Z'),
    }), 'ASPG_STATE_GENERATION_CONFLICT');
    expect(fs.readFileSync(first.path)).toEqual(before);

    const advanced = writePortableDeploymentState({
      projectRoot,
      stateRelativePath,
      expectedGeneration: 1,
      state: state(2, '2026-07-26T10:03:00.000Z'),
    });
    expect(advanced.state.generation).toBe(2);
    expect(fs.readdirSync(path.dirname(advanced.path))).toEqual(['deployment-state.json']);
  });

  it('does not replace unmanaged state targets', () => {
    const stateDirectory = path.join(projectRoot, '.aspg');
    fs.mkdirSync(stateDirectory);
    const statePath = path.join(stateDirectory, 'deployment-state.json');
    fs.writeFileSync(statePath, 'foreign\n');
    const before = fs.readFileSync(statePath);

    expectCode(() => writePortableDeploymentState({
      projectRoot,
      stateRelativePath: '.aspg/deployment-state.json',
      expectedGeneration: null,
      state: state(),
    }), 'ASPG_STATE_UNMANAGED_TARGET');
    expect(fs.readFileSync(statePath)).toEqual(before);
  });

  it('rejects real projects, portable-path escapes and symlinked state parents', () => {
    const realTarget = path.join(
      process.cwd(),
      '.aspg',
      'w6-link-test-never.json',
    );
    expectCode(() => writePortableDeploymentState({
      projectRoot: process.cwd(),
      stateRelativePath: '.aspg/w6-link-test-never.json',
      expectedGeneration: null,
      state: state(),
    }), 'ASPG_REAL_PROJECT_FORBIDDEN');
    expect(fs.existsSync(realTarget)).toBe(false);

    expectCode(() => writePortableDeploymentState({
      projectRoot,
      stateRelativePath: '../deployment-state.json',
      expectedGeneration: null,
      state: state(),
    }), 'ASPG_STATE_PATH_INVALID');
    expectCode(() => writePortableDeploymentState({
      projectRoot,
      stateRelativePath: '/tmp/deployment-state.json',
      expectedGeneration: null,
      state: state(),
    }), 'ASPG_STATE_PATH_INVALID');

    const outside = path.join(fixtureRoot, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(projectRoot, '.aspg'), 'dir');
    expectCode(() => writePortableDeploymentState({
      projectRoot,
      stateRelativePath: '.aspg/deployment-state.json',
      expectedGeneration: null,
      state: state(),
    }), 'ASPG_STATE_PATH_ESCAPE');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('managed-link dependency inspection', () => {
  it('reports a correct owned link as in-sync without creating sidecars', () => {
    const source = createSkill();
    const projected = dependency('packs/work-private/example', '.agents/skills/example');
    const target = path.join(projectRoot, '.agents', 'skills', 'example');
    createManagedLink(source, target);

    expect(inspectDependency(projected)).toEqual({
      health: 'in-sync',
      blocking: false,
      target_mutated: false,
      resolved_target: fs.realpathSync(source),
      observed_tree_hash: projected.tree_hash,
      observed_executable_files: [],
    });
    expect(fs.readlinkSync(target)).toBe(source);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['example']);
  });

  it('fails closed for missing, unavailable, foreign and unmanaged targets', () => {
    const source = createSkill();
    const target = path.join(projectRoot, '.agents', 'skills', 'example');
    const projected = dependency('packs/work-private/example', '.agents/skills/example');

    expect(inspectDependency(projected)).toMatchObject({
      health: 'missing',
      blocking: true,
      target_mutated: false,
    });
    expect(fs.existsSync(target)).toBe(false);

    const unavailable: ProjectedDataDependency = {
      ...projected,
      path: 'packs/work-private/unavailable',
    };
    expect(inspectDependency(unavailable)).toMatchObject({
      health: 'source-unavailable',
      blocking: true,
      target_mutated: false,
    });

    const foreign = createSkill('packs/work-private/foreign');
    createManagedLink(foreign, target);
    const beforeForeign = fs.readlinkSync(target);
    expect(inspectDependency(projected)).toMatchObject({
      health: 'unmanaged-content',
      blocking: true,
      target_mutated: false,
    });
    expect(fs.readlinkSync(target)).toBe(beforeForeign);

    fs.unlinkSync(target);
    fs.symlinkSync(path.join(sourceRoot, 'absent'), target, 'dir');
    expect(inspectDependency(projected)).toMatchObject({
      health: 'unmanaged-content',
      blocking: true,
      target_mutated: false,
    });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

    fs.unlinkSync(target);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'foreign.txt'), 'foreign\n');
    expect(inspectDependency(projected)).toMatchObject({
      health: 'unmanaged-copy',
      blocking: true,
      target_mutated: false,
    });
    expect(fs.readFileSync(path.join(target, 'foreign.txt'), 'utf8')).toBe('foreign\n');

    fs.rmSync(target, { recursive: true });
    fs.writeFileSync(target, 'foreign file\n');
    expect(inspectDependency(projected)).toMatchObject({
      health: 'unmanaged-content',
      blocking: true,
      target_mutated: false,
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('foreign file\n');
  });

  it('blocks a required missing dependency and does not materialize it', () => {
    createSkill();
    const projected = dependency('packs/work-private/example', '.agents/data/example');
    const target = path.join(projectRoot, '.agents', 'data', 'example');

    expect(inspectDependency(projected)).toEqual({
      health: 'missing',
      blocking: true,
      target_mutated: false,
      resolved_target: null,
      observed_tree_hash: null,
      observed_executable_files: [],
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('blocks required content drift without repairing the linked source', () => {
    const source = createSkill();
    const projected = dependency('packs/work-private/example', '.agents/data/example');
    const target = path.join(projectRoot, '.agents', 'data', 'example');
    createManagedLink(source, target);
    fs.appendFileSync(path.join(source, 'SKILL.md'), 'drift\n');
    const sourceBytes = fs.readFileSync(path.join(source, 'SKILL.md'));
    const link = fs.readlinkSync(target);

    const result = inspectDependency(projected);
    expect(result.health).toBe('local-drift');
    expect(result.blocking).toBe(true);
    expect(result.target_mutated).toBe(false);
    expect(result.observed_tree_hash).not.toBe(projected.tree_hash);
    expect(fs.readlinkSync(target)).toBe(link);
    expect(fs.readFileSync(path.join(source, 'SKILL.md'))).toEqual(sourceBytes);
  });

  it('blocks required executable-mode drift with mode precedence', () => {
    const source = createSkill();
    const projected = dependency('packs/work-private/example', '.agents/data/example');
    const target = path.join(projectRoot, '.agents', 'data', 'example');
    createManagedLink(source, target);
    const executable = path.join(source, 'scripts', 'run.sh');
    fs.chmodSync(executable, 0o755);
    const link = fs.readlinkSync(target);

    const result = inspectDependency(projected);
    expect(result.health).toBe('mode-drift');
    expect(result.blocking).toBe(true);
    expect(result.target_mutated).toBe(false);
    expect(result.observed_executable_files).toEqual(['scripts/run.sh']);
    expect(fs.readlinkSync(target)).toBe(link);
    expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
  });

  it('keeps optional dependency drift visible but non-blocking', () => {
    createSkill();
    const projected = dependency(
      'packs/work-private/example',
      '.agents/data/example',
      false,
    );
    expect(inspectDependency(projected)).toMatchObject({
      health: 'missing',
      blocking: false,
      target_mutated: false,
    });
  });

  it('rejects inspection outside the explicit temporary fixture', () => {
    const source = createSkill();
    const digest = hashSkillSubtree(source);
    expectCode(() => inspectManagedLinkTarget({
      fixtureRoot,
      targetPath: path.join(process.cwd(), '.agents', 'skills', 'example'),
      expectedSourcePath: source,
      expected: digest,
      required: true,
    }), 'ASPG_LINK_INSPECTION_PATH_ESCAPE');
  });
});
