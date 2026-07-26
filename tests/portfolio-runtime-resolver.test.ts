import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolvePortfolioRuntime,
  type PortfolioRuntimeResolverRequest,
} from '../src/portfolio-runtime-resolver.js';

const revision = '1'.repeat(40);
const hash = `sha256:${'2'.repeat(64)}`;
const D9_SKILL = 'martin/artifact-template-cstc-eu-rspo-default-deck';
const D9_DEPENDENCY = 'cstc-eu-rspo-employer-pack';

let fixtureRoot: string;
let outsideRoot: string;
let stateRoot: string;
let sourceRoot: string;
let lifeProjectRoot: string;
let workProjectRoot: string;
let lifeRuntimeRoot: string;
let workRuntimeRoot: string;
let manifest: any;
let lock: any;
let registry: any;

function binding(deployment: 'life-os' | 'work-pkm') {
  return {
    version: 1,
    portfolio: {
      repository: 'git@example.test:portfolio/control.git',
      revision: '3'.repeat(40),
      deployment,
    },
  };
}

function request(
  deployment: 'life-os' | 'work-pkm',
  overrides: Partial<PortfolioRuntimeResolverRequest> = {},
): PortfolioRuntimeResolverRequest {
  return {
    fixture_root: fixtureRoot,
    manifest,
    lock,
    device_registry: registry,
    binding: binding(deployment),
    device_id: 'test-device',
    deployment,
    ...overrides,
  };
}

function treeInventory(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        result.push(`l:${relative}:${fs.readlinkSync(absolute)}`);
      } else if (stat.isDirectory()) {
        result.push(`d:${relative}`);
        visit(absolute, relative);
      } else {
        result.push(`f:${relative}:${fs.readFileSync(absolute, 'hex')}`);
      }
    }
  };
  visit(root, '');
  return result;
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-runtime-resolver-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-runtime-outside-'));
  stateRoot = path.join(fixtureRoot, 'device-state');
  sourceRoot = path.join(fixtureRoot, 'sources', 'private');
  lifeProjectRoot = path.join(fixtureRoot, 'projects', 'Life-OS');
  workProjectRoot = path.join(fixtureRoot, 'projects', 'Work-PKM');
  lifeRuntimeRoot = path.join(lifeProjectRoot, '.agents', 'skills');
  workRuntimeRoot = path.join(workProjectRoot, '.agents', 'skills');
  for (const directory of [
    stateRoot,
    sourceRoot,
    lifeRuntimeRoot,
    workRuntimeRoot,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  manifest = {
    version: 1,
    portfolio: 'martin-skills',
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
      'martin/audio-transcriber': {
        source: 'private',
        path: 'skills/audio-transcriber',
        ownership: 'managed-link',
        exposure_name: 'audio-transcriber',
        description_chars: 194,
        capabilities: [],
        data_dependencies: [],
      },
      [D9_SKILL]: {
        source: 'private',
        path: 'skills/artifact-template-cstc-eu-rspo-default-deck',
        ownership: 'managed-link',
        exposure_name: 'artifact-template-cstc-eu-rspo-default-deck',
        description_chars: 205,
        capabilities: [],
        data_dependencies: [{
          id: D9_DEPENDENCY,
          source: 'private',
          path: 'packs/work-private/artifact-template-cstc-eu-rspo-default-deck',
          privacy: 'work-private',
          deployments: ['work-pkm'],
          required: true,
        }],
      },
    },
    profiles: {
      'life-default': {
        include: ['martin/audio-transcriber'],
        exclude: [],
        budgets: {
          max_skills: 4,
          max_description_chars: 1000,
        },
      },
      'work-default': {
        include: [D9_SKILL, 'martin/audio-transcriber'],
        exclude: [],
        budgets: {
          max_skills: 4,
          max_description_chars: 1000,
        },
      },
    },
    deployments: {
      'life-os': {
        project_ref: 'life-project',
        profiles: ['life-default'],
        include: [],
        exclude: [],
      },
      'work-pkm': {
        project_ref: 'work-project',
        profiles: ['work-default'],
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
  };

  lock = {
    version: 1,
    sources: {
      private: {
        revision,
      },
    },
    skills: {
      'martin/audio-transcriber': {
        source: 'private',
        path: 'skills/audio-transcriber',
        source_revision: revision,
        tree_hash: hash,
        executable_files: ['scripts/transcribe.py'],
        overlay_hash: null,
        data_dependencies: {},
      },
      [D9_SKILL]: {
        source: 'private',
        path: 'skills/artifact-template-cstc-eu-rspo-default-deck',
        source_revision: revision,
        tree_hash: hash,
        executable_files: [],
        overlay_hash: null,
        data_dependencies: {
          [D9_DEPENDENCY]: {
            source_revision: revision,
            path: 'packs/work-private/artifact-template-cstc-eu-rspo-default-deck',
            tree_hash: hash,
            executable_files: [],
          },
        },
      },
    },
    deployments: {
      'life-os': {
        resolved_skills: ['martin/audio-transcriber'],
      },
      'work-pkm': {
        resolved_skills: [D9_SKILL, 'martin/audio-transcriber'],
      },
    },
    exceptions: [],
  };

  registry = {
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
  };
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

describe('Wave 6 Portfolio runtime resolver', () => {
  it('resolves Life provider/backend without leaking the Work-only D9 pack', () => {
    const result = resolvePortfolioRuntime(request('life-os'));

    expect(result).toMatchObject({
      writes_performed: 0,
      portfolio: 'martin-skills',
      deployment: 'life-os',
      project_ref: 'life-project',
      project_root: fs.realpathSync(lifeProjectRoot),
      runtime_root: fs.realpathSync(lifeRuntimeRoot),
      state_root: fs.realpathSync(stateRoot),
      provider: 'google-drive-file-provider',
      backend: 'managed-materialized',
    });
    expect(result.skills.map((skill) => skill.skill_id))
      .toEqual(['martin/audio-transcriber']);
    expect(result.skills[0]).toMatchObject({
      repository_root: fs.realpathSync(sourceRoot),
      source_repository: 'git@example.test:private/skills.git',
      target: path.join(fs.realpathSync(lifeRuntimeRoot), 'audio-transcriber'),
      locked: {
        source: 'private',
        source_revision: revision,
        path: 'skills/audio-transcriber',
        tree_hash: hash,
        executable_files: ['scripts/transcribe.py'],
      },
      dependencies: [],
    });
    expect(result.generated_private_skill_packs).toEqual({
      path: '.aspg/generated/private-skill-packs.json',
      model: {
        schema_version: 1,
        packs: [],
      },
    });
  });

  it('resolves Work D9 with one project-relative dependency and generated pack binding', () => {
    const result = resolvePortfolioRuntime(request('work-pkm'));
    const d9 = result.skills.find((skill) => skill.skill_id === D9_SKILL);

    expect(result).toMatchObject({
      project_root: fs.realpathSync(workProjectRoot),
      runtime_root: fs.realpathSync(workRuntimeRoot),
      provider: 'local-filesystem',
      backend: 'managed-link',
    });
    expect(d9).toBeDefined();
    expect(d9?.dependencies).toEqual([{
      id: D9_DEPENDENCY,
      privacy: 'work-private',
      target: `.aspg/dependencies/${D9_DEPENDENCY}`,
      required: true,
      source: 'private',
      source_revision: revision,
      path: 'packs/work-private/artifact-template-cstc-eu-rspo-default-deck',
      tree_hash: hash,
      executable_files: [],
      repository_root: fs.realpathSync(sourceRoot),
      source_repository: 'git@example.test:private/skills.git',
    }]);
    expect(result.generated_private_skill_packs).toEqual({
      path: '.aspg/generated/private-skill-packs.json',
      model: {
        schema_version: 1,
        packs: [{
          pack_id: 'work-private/cstc-eu-rspo-default-deck',
          root: `.aspg/dependencies/${D9_DEPENDENCY}`,
        }],
      },
    });
    expect(JSON.stringify(result.generated_private_skill_packs))
      .not.toContain(fixtureRoot);
  });

  it('fails closed when the Work D9 dependency Lock is missing or divergent', () => {
    delete lock.skills[D9_SKILL].data_dependencies[D9_DEPENDENCY];
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_DEPENDENCY_LOCK_MISMATCH' }),
    );

    lock.skills[D9_SKILL].data_dependencies[D9_DEPENDENCY] = {
      source_revision: revision,
      path: 'packs/work-private/artifact-template-cstc-eu-rspo-default-deck',
      tree_hash: hash,
      executable_files: [],
    };
    lock.skills[D9_SKILL].data_dependencies[D9_DEPENDENCY].source_revision =
      '4'.repeat(40);
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_DEPENDENCY_LOCK_MISMATCH' }),
    );

    lock.skills[D9_SKILL].data_dependencies[D9_DEPENDENCY].source_revision = revision;
    lock.skills[D9_SKILL].data_dependencies[D9_DEPENDENCY].path = '../escape';
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_INPUT_INVALID' }),
    );
  });

  it('fails closed if D9 is exposed to Life or its dependency names a non-Work scope', () => {
    manifest.profiles['life-default'].include.push(D9_SKILL);
    lock.deployments['life-os'].resolved_skills = [
      D9_SKILL,
      'martin/audio-transcriber',
    ];
    expect(() => resolvePortfolioRuntime(request('life-os'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_D9_SCOPE_INVALID' }),
    );

    manifest.profiles['life-default'].include = ['martin/audio-transcriber'];
    lock.deployments['life-os'].resolved_skills = ['martin/audio-transcriber'];
    manifest.skills[D9_SKILL].data_dependencies[0].deployments = ['life-os'];
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_DEPENDENCY_SCOPE_INVALID' }),
    );
  });

  it('rejects binding mismatches and any source/runtime/state root outside the fixture', () => {
    expect(() => resolvePortfolioRuntime({
      ...request('work-pkm'),
      binding: binding('life-os'),
    })).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_BINDING_MISMATCH' }),
    );

    registry.devices['test-device'].source_roots.private = outsideRoot;
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_PATH_ESCAPE' }),
    );
    registry.devices['test-device'].source_roots.private = sourceRoot;

    registry.devices['test-device'].runtime_roots['work-agents'].path = outsideRoot;
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_PATH_ESCAPE' }),
    );
    registry.devices['test-device'].runtime_roots['work-agents'].path = workRuntimeRoot;

    registry.devices['test-device'].state_root = outsideRoot;
    expect(() => resolvePortfolioRuntime(request('work-pkm'))).toThrowError(
      expect.objectContaining({ code: 'ASPG_RUNTIME_PATH_ESCAPE' }),
    );
  });

  it('is deterministic and performs zero filesystem writes', () => {
    const before = treeInventory(fixtureRoot);
    const first = resolvePortfolioRuntime(request('work-pkm'));
    const second = resolvePortfolioRuntime(request('work-pkm'));
    const after = treeInventory(fixtureRoot);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.writes_performed).toBe(0);
    expect(after).toEqual(before);
  });
});
