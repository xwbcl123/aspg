import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  buildPortfolioPlan,
  validatePortfolio,
  type PortfolioControlOptions,
} from '../src/portfolio-control.js';
import { hashSkillSubtree } from '../src/portfolio-hash.js';

let fixtureRoot: string;
let manifestPath: string;
let lockPath: string;
let registryPath: string;
let sourceRoot: string;
let skillRoot: string;
let lifeProjectRoot: string;
let workProjectRoot: string;
let lifeRuntimeRoot: string;
let workRuntimeRoot: string;
let stateRoot: string;
let sourceRevision: string;

function writeYaml(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, stringify(value));
}

function writeBinding(projectRoot: string, deployment: string): void {
  const bindingRoot = path.join(projectRoot, '.aspg');
  fs.mkdirSync(bindingRoot, { recursive: true });
  writeYaml(path.join(bindingRoot, 'portfolio.yaml'), {
    version: 1,
    portfolio: {
      repository: 'git@example.test:portfolio/control.git',
      revision: 'f'.repeat(40),
      deployment,
    },
  });
}

function controlOptions(): PortfolioControlOptions {
  return {
    manifestPath,
    lockPath,
    deviceRegistryPath: registryPath,
    deviceId: 'test-device',
    asOf: '2026-07-26',
  };
}

function writeV2Registry(): void {
  writeYaml(registryPath, {
    version: 2,
    devices: {
      'test-device': {
        platform: 'darwin',
        state_root: stateRoot,
        source_roots: {
          private: sourceRoot,
        },
        runtime_roots: {
          'life-agents': {
            project_ref: 'life-project',
            path: lifeRuntimeRoot,
            storage_provider: 'google-drive-file-provider',
            deployment_backend: 'managed-materialized',
          },
          'work-agents': {
            project_ref: 'work-project',
            path: workRuntimeRoot,
            storage_provider: 'local-filesystem',
            deployment_backend: 'managed-link',
          },
        },
      },
    },
  });
}

function writeV1Registry(): void {
  writeYaml(registryPath, {
    version: 1,
    devices: {
      'test-device': {
        platform: 'darwin',
        state_root: stateRoot,
        source_roots: {
          private: sourceRoot,
        },
        project_roots: {
          'life-project': lifeProjectRoot,
          'work-project': workProjectRoot,
        },
        backends: {
          'managed-link': 'symlink',
          'managed-materialized': 'materialize',
        },
      },
    },
  });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-device-v2-control-'));
  manifestPath = path.join(fixtureRoot, 'portfolio.yaml');
  lockPath = path.join(fixtureRoot, 'portfolio-lock.yaml');
  registryPath = path.join(fixtureRoot, 'device-registry.yaml');
  sourceRoot = path.join(fixtureRoot, 'sources', 'private');
  skillRoot = path.join(sourceRoot, 'skills', 'example');
  lifeProjectRoot = path.join(fixtureRoot, 'projects', 'Life-OS');
  workProjectRoot = path.join(fixtureRoot, 'projects', 'Work-PKM');
  lifeRuntimeRoot = path.join(lifeProjectRoot, '.agents', 'skills');
  workRuntimeRoot = path.join(workProjectRoot, '.agents', 'skills');
  stateRoot = path.join(fixtureRoot, 'device-state', 'aspg');

  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture Skill\n');
  const executable = path.join(skillRoot, 'scripts', 'run.sh');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(executable, 0o755);
  fs.mkdirSync(lifeRuntimeRoot, { recursive: true });
  fs.mkdirSync(workRuntimeRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  writeBinding(lifeProjectRoot, 'life');
  writeBinding(workProjectRoot, 'work');

  execFileSync('git', ['init', '-q', sourceRoot]);
  execFileSync('git', ['-C', sourceRoot, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      sourceRoot,
      '-c',
      'user.name=ASPG Test',
      '-c',
      'user.email=aspg@example.test',
      'commit',
      '-qm',
      'fixture source',
    ],
  );
  sourceRevision = execFileSync(
    'git',
    ['-C', sourceRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  const digest = hashSkillSubtree(skillRoot);

  writeYaml(manifestPath, {
    version: 1,
    portfolio: 'test-portfolio',
    command_maturity: {
      portfolio_plan: 'mvp',
      portfolio_apply: 'future',
    },
    concurrency: {
      activation_lock: 'device-local',
    },
    sources: {
      private: {
        kind: 'git',
        repository: 'git@example.test:private/skills.git',
        privacy: 'private',
      },
    },
    skills: {
      'martin/example': {
        source: 'private',
        path: 'skills/example',
        ownership: 'managed-link',
        exposure_name: 'example',
        description_chars: 120,
        capabilities: ['example'],
        data_dependencies: [],
      },
    },
    profiles: {
      default: {
        include: ['martin/example'],
        exclude: [],
        budgets: {
          max_skills: 4,
          max_description_chars: 1000,
        },
      },
    },
    deployments: {
      life: {
        project_ref: 'life-project',
        profiles: ['default'],
        include: [],
        exclude: [],
      },
      work: {
        project_ref: 'work-project',
        profiles: ['default'],
        include: [],
        exclude: [],
      },
    },
    projects: {
      'life-project': {
        expected_vault: 'life-os',
      },
      'work-project': {
        expected_vault: 'work-pkm',
      },
    },
  });

  writeYaml(lockPath, {
    version: 1,
    sources: {
      private: {
        revision: sourceRevision,
      },
    },
    skills: {
      'martin/example': {
        source: 'private',
        path: 'skills/example',
        source_revision: sourceRevision,
        tree_hash: digest.tree_hash,
        executable_files: digest.executable_files,
        overlay_hash: null,
        data_dependencies: {},
      },
    },
    deployments: {
      life: {
        resolved_skills: ['martin/example'],
      },
      work: {
        resolved_skills: ['martin/example'],
      },
    },
    exceptions: [],
  });
  writeV2Registry();
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Portfolio device registry v2 active reader', () => {
  it('validates v2 and resolves each project from its scoped runtime root', () => {
    const validation = validatePortfolio(controlOptions());

    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toEqual([]);
    expect(validation.writes_performed).toBe(0);
    expect(validation.projects).toEqual([
      expect.objectContaining({
        project_ref: 'life-project',
        configured_root: lifeProjectRoot,
        realpath: fs.realpathSync(lifeProjectRoot),
        runtime_root: lifeRuntimeRoot,
        storage_provider: 'google-drive-file-provider',
        deployment_backend: 'managed-materialized',
      }),
      expect.objectContaining({
        project_ref: 'work-project',
        configured_root: workProjectRoot,
        realpath: fs.realpathSync(workProjectRoot),
        runtime_root: workRuntimeRoot,
        storage_provider: 'local-filesystem',
        deployment_backend: 'managed-link',
      }),
    ]);
  });

  it('plans Google Drive as materialize and local filesystem as symlink', () => {
    const life = buildPortfolioPlan({
      ...controlOptions(),
      deployment: 'life',
    });
    const work = buildPortfolioPlan({
      ...controlOptions(),
      deployment: 'work',
    });

    expect(life.errors).toEqual([]);
    expect(life.entries).toEqual([
      expect.objectContaining({
        skill_id: 'martin/example',
        action: 'create',
        backend: 'materialize',
        target: path.join(lifeRuntimeRoot, 'example'),
        health: 'not-deployed',
      }),
    ]);
    expect(work.errors).toEqual([]);
    expect(work.entries).toEqual([
      expect.objectContaining({
        skill_id: 'martin/example',
        action: 'create',
        backend: 'symlink',
        target: path.join(workRuntimeRoot, 'example'),
        health: 'not-deployed',
      }),
    ]);
    expect(life.entries[0]?.target).toBe(path.join(lifeRuntimeRoot, 'example'));
    expect(work.entries[0]?.target).toBe(path.join(workRuntimeRoot, 'example'));
    expect(fs.existsSync(path.join(lifeRuntimeRoot, 'example'))).toBe(false);
    expect(fs.existsSync(path.join(workRuntimeRoot, 'example'))).toBe(false);
  });

  it('uses the effective runtime backend when inspecting deployed health', () => {
    fs.cpSync(skillRoot, path.join(lifeRuntimeRoot, 'example'), {
      recursive: true,
      preserveTimestamps: true,
    });
    fs.symlinkSync(skillRoot, path.join(workRuntimeRoot, 'example'), 'dir');

    const life = buildPortfolioPlan({ ...controlOptions(), deployment: 'life' });
    const work = buildPortfolioPlan({ ...controlOptions(), deployment: 'work' });

    expect(life.entries[0]).toMatchObject({
      backend: 'materialize',
      action: 'noop',
      health: 'healthy',
    });
    expect(work.entries[0]).toMatchObject({
      backend: 'symlink',
      action: 'noop',
      health: 'healthy',
    });
  });

  it('keeps device state outside source, project and runtime roots', () => {
    const plans = ['life', 'work'].map((deployment) =>
      buildPortfolioPlan({ ...controlOptions(), deployment }));
    const resolvedStateRoot = fs.realpathSync(stateRoot);

    for (const plan of plans) {
      expect(plan.activation_lock).toBe(
        path.join(resolvedStateRoot, 'locks', `test-portfolio-${plan.deployment}.lock`),
      );
      expect(plan.activation_lock?.startsWith(`${lifeProjectRoot}${path.sep}`)).toBe(false);
      expect(plan.activation_lock?.startsWith(`${workProjectRoot}${path.sep}`)).toBe(false);
      expect(plan.activation_lock?.startsWith(`${sourceRoot}${path.sep}`)).toBe(false);
      expect(plan.activation_lock?.startsWith(`${lifeRuntimeRoot}${path.sep}`)).toBe(false);
      expect(plan.activation_lock?.startsWith(`${workRuntimeRoot}${path.sep}`)).toBe(false);
      expect(plan.lock_acquired).toBe(false);
      expect(plan.writes_performed).toBe(0);
    }
  });

  it('preserves the v1 reader and legacy project-root target behavior', () => {
    writeV1Registry();

    const validation = validatePortfolio(controlOptions());
    const life = buildPortfolioPlan({
      ...controlOptions(),
      deployment: 'life',
    });
    const work = buildPortfolioPlan({
      ...controlOptions(),
      deployment: 'work',
    });

    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toEqual([]);
    expect(life.entries[0]).toMatchObject({
      backend: 'symlink',
      target: path.join(
        fs.realpathSync(lifeProjectRoot),
        '.agents',
        'skills',
        'example',
      ),
    });
    expect(work.entries[0]).toMatchObject({
      backend: 'symlink',
      target: path.join(
        fs.realpathSync(workProjectRoot),
        '.agents',
        'skills',
        'example',
      ),
    });
  });
});
