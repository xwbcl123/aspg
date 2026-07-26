import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import {
  buildPortfolioDeploymentView,
  buildPortfolioPlan,
  buildPortfolioStatus,
  validatePortfolio,
  type PortfolioControlOptions,
} from '../src/portfolio-control.js';
import {
  hashSkillSubtree,
  hashSkillSubtreeAtRevision,
} from '../src/portfolio-hash.js';
import {
  portfolioDeploymentViewCommand,
  portfolioPlanCommand,
  portfolioStatusCommand,
  portfolioValidateCommand,
} from '../src/commands/portfolio.js';

const fixtureRoot = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures',
  'portfolio-valid',
);

let tmpDir: string;
let manifestPath: string;
let lockPath: string;
let registryPath: string;
let sourceRoot: string;
let skillRoot: string;
let projectRoot: string;
let workProjectRoot: string;
let stateRoot: string;
let sourceRevision: string;

const dependencyId = 'cstc-eu-rspo-employer-pack';
const dependencyPath =
  'packs/work-private/artifact-template-cstc-eu-rspo-default-deck';

function readObject(filePath: string): any {
  return parse(fs.readFileSync(filePath, 'utf-8'));
}

function updateObject(filePath: string, update: (value: any) => void): void {
  const value = readObject(filePath);
  update(value);
  fs.writeFileSync(filePath, stringify(value));
}

function options(asOf = '2026-07-26'): PortfolioControlOptions {
  return {
    manifestPath,
    lockPath,
    deviceRegistryPath: registryPath,
    deviceId: 'test-device',
    asOf,
  };
}

function commitSource(message: string): string {
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
      message,
    ],
  );
  return execFileSync(
    'git',
    ['-C', sourceRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
}

function configureWorkPrivateDependency(): {
  revision: string;
  digest: ReturnType<typeof hashSkillSubtreeAtRevision>;
} {
  const packRoot = path.join(sourceRoot, ...dependencyPath.split('/'));
  fs.mkdirSync(path.join(packRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(packRoot, 'README.md'), 'employer-only pack\n');
  const packExecutable = path.join(packRoot, 'scripts', 'render.sh');
  fs.writeFileSync(packExecutable, '#!/bin/sh\n');
  fs.chmodSync(packExecutable, 0o755);
  const revision = commitSource('canonical content with employer pack');
  const digest = hashSkillSubtreeAtRevision(
    sourceRoot,
    { revision, sourcePath: dependencyPath },
  );

  fs.mkdirSync(path.join(workProjectRoot, '.aspg'), { recursive: true });
  fs.writeFileSync(
    path.join(workProjectRoot, '.aspg', 'portfolio.yaml'),
    [
      'version: 1',
      'portfolio:',
      '  repository: git@example.test:portfolio/control.git',
      '  revision: fedcba9876543210fedcba9876543210fedcba98',
      '  deployment: work-pkm',
      '',
    ].join('\n'),
  );
  updateObject(manifestPath, (manifest) => {
    manifest.skills['martin/audio-transcriber'].data_dependencies = [{
      id: dependencyId,
      source: 'private',
      path: dependencyPath,
      privacy: 'work-private',
      deployments: ['work-pkm'],
      required: true,
    }];
    manifest.projects['work-pkm-project'] = { expected_vault: 'work-pkm' };
    manifest.deployments['work-pkm'] = {
      project_ref: 'work-pkm-project',
      profiles: ['default'],
      include: [],
      exclude: [],
    };
  });
  updateObject(lockPath, (lock) => {
    lock.sources.private.revision = revision;
    lock.skills['martin/audio-transcriber'].source_revision = revision;
    lock.skills['martin/audio-transcriber'].data_dependencies = {
      [dependencyId]: {
        source_revision: revision,
        path: dependencyPath,
        tree_hash: digest.tree_hash,
        executable_files: digest.executable_files,
      },
    };
    lock.deployments['work-pkm'] = {
      resolved_skills: ['martin/audio-transcriber'],
    };
  });
  updateObject(registryPath, (registry) => {
    registry.devices['test-device'].project_roots['work-pkm-project'] =
      workProjectRoot;
  });

  fs.writeFileSync(
    path.join(sourceRoot, 'portfolio-lock-commit-marker.yaml'),
    `source_revision: ${revision}\n`,
  );
  commitSource('self-hosted Lock commit');
  return { revision, digest };
}

beforeEach(() => {
  process.exitCode = undefined as unknown as number;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-portfolio-control-'));
  fs.cpSync(fixtureRoot, tmpDir, { recursive: true });
  manifestPath = path.join(tmpDir, 'portfolio.yaml');
  lockPath = path.join(tmpDir, 'portfolio-lock.yaml');
  registryPath = path.join(tmpDir, 'device-registry.yaml');
  sourceRoot = path.join(tmpDir, 'source', 'private');
  skillRoot = path.join(sourceRoot, 'skills', 'audio-transcriber');
  projectRoot = path.join(tmpDir, 'project', 'Life-OS');
  workProjectRoot = path.join(tmpDir, 'project', 'Work-PKM');
  stateRoot = path.join(tmpDir, 'device-state');
  fs.chmodSync(path.join(skillRoot, 'scripts', 'transcribe.sh'), 0o755);
  execFileSync('git', ['init', '-q', sourceRoot]);
  sourceRevision = commitSource('base source');

  const digest = hashSkillSubtree(skillRoot);
  fs.writeFileSync(
    lockPath,
    fs.readFileSync(lockPath, 'utf-8').replace('__TREE_HASH__', digest.tree_hash),
  );
  updateObject(lockPath, (lock) => {
    lock.sources.private.revision = sourceRevision;
    lock.skills['martin/audio-transcriber'].source_revision = sourceRevision;
  });
  fs.writeFileSync(
    registryPath,
    fs.readFileSync(registryPath, 'utf-8')
      .replace('__SOURCE_ROOT__', sourceRoot)
      .replace('__PROJECT_ROOT__', projectRoot)
      .replace('__STATE_ROOT__', stateRoot),
  );
});

afterEach(() => {
  process.exitCode = undefined as unknown as number;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Portfolio control plane', () => {
  it('validates a complete Portfolio and performs zero writes', () => {
    const before = hashSkillSubtree(tmpDir);
    const result = validatePortfolio(options());
    const after = hashSkillSubtree(tmpDir);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.projects[0].realpath).toBe(fs.realpathSync(projectRoot));
    expect(result.deployments[0].selected_skills).toEqual(['martin/audio-transcriber']);
    expect(result.writes_performed).toBe(0);
    expect(after).toEqual(before);
  });

  it('returns a deterministic read-only plan, status and flattened deployment view', () => {
    const first = buildPortfolioPlan({ ...options(), deployment: 'life-os' });
    const second = buildPortfolioPlan({ ...options(), deployment: 'life-os' });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.errors).toEqual([]);
    expect(first.entries[0]).toMatchObject({
      skill_id: 'martin/audio-transcriber',
      action: 'create',
      backend: 'symlink',
      health: 'not-deployed',
    });
    expect(first.lock_acquired).toBe(false);
    expect(first.activation_lock).toBe(
      path.join(
        fs.realpathSync(tmpDir),
        'device-state',
        'locks',
        'test-portfolio-life-os.lock',
      ),
    );
    expect(
      first.activation_lock?.startsWith(`${fs.realpathSync(projectRoot)}${path.sep}`),
    ).toBe(false);
    expect(first.writes_performed).toBe(0);

    const status = buildPortfolioStatus(options());
    expect(status.valid).toBe(true);
    expect(JSON.stringify(status)).toBe(JSON.stringify(buildPortfolioStatus(options())));
    expect(status.deployments[0]).toMatchObject({
      deployment: 'life-os',
      pending: 1,
      blocked: 0,
    });

    const view = buildPortfolioDeploymentView(options());
    expect(JSON.stringify(view)).toBe(
      JSON.stringify(buildPortfolioDeploymentView(options())),
    );
    expect(view.rows).toEqual([
      expect.objectContaining({
        deployment: 'life-os',
        canonical_skill_id: 'martin/audio-transcriber',
        exposure_name: 'audio-transcriber',
        health: 'not-deployed',
      }),
    ]);
    expect(view.writes_performed).toBe(0);
  });

  it('normalizes project identity through realpath', () => {
    const alias = path.join(tmpDir, 'life-os-alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
    updateObject(registryPath, (registry) => {
      registry.devices['test-device'].project_roots['life-os-project'] = alias;
    });
    const result = validatePortfolio(options());
    expect(result.valid).toBe(true);
    expect(result.projects[0].configured_root).toBe(alias);
    expect(result.projects[0].realpath).toBe(fs.realpathSync(projectRoot));
  });

  it('refuses a device state root that resolves into a project through a symlink', () => {
    const insideProject = path.join(projectRoot, '.device-state');
    const alias = path.join(tmpDir, 'device-state-alias');
    fs.mkdirSync(insideProject);
    fs.symlinkSync(insideProject, alias, 'dir');
    updateObject(registryPath, (registry) => {
      registry.devices['test-device'].state_root = alias;
    });

    const validation = validatePortfolio(options());
    expect(validation.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('device-state-root-overlap');
    expect(
      buildPortfolioPlan({ ...options(), deployment: 'life-os' }).activation_lock,
    ).toBeNull();
  });

  it('rejects two project identities resolving to one real directory', () => {
    updateObject(manifestPath, (manifest) => {
      manifest.projects['life-os-alias'] = { expected_vault: 'life-os' };
      manifest.deployments['life-os-alias'] = {
        project_ref: 'life-os-alias',
        profiles: ['default'],
        include: [],
        exclude: [],
      };
    });
    updateObject(lockPath, (lock) => {
      lock.deployments['life-os-alias'] = {
        resolved_skills: ['martin/audio-transcriber'],
      };
    });
    updateObject(registryPath, (registry) => {
      registry.devices['test-device'].project_roots['life-os-alias'] = projectRoot;
    });
    expect(validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('project-realpath-collision');
  });

  it('rejects unresolved references and divergent deployment resolution', () => {
    updateObject(manifestPath, (manifest) => {
      manifest.skills['martin/audio-transcriber'].source = 'missing-source';
    });
    updateObject(lockPath, (lock) => {
      lock.deployments['life-os'].resolved_skills = [];
    });
    const codes = validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('skill-source-unresolved');
    expect(codes).toContain('deployment-resolution-divergent');
  });

  it('rejects subtree drift including executable mode', () => {
    fs.chmodSync(path.join(skillRoot, 'scripts', 'transcribe.sh'), 0o644);
    const codes = validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('skill-subtree-drift');
    expect(codes).toContain('skill-executable-manifest-drift');
  });

  it('validates a required Work-only private pack from the prior canonical commit', () => {
    const { revision, digest } = configureWorkPrivateDependency();
    const head = execFileSync(
      'git',
      ['-C', sourceRoot, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim();
    expect(head).not.toBe(revision);
    expect(hashSkillSubtreeAtRevision(
      sourceRoot,
      { revision, sourcePath: dependencyPath },
    )).toEqual(digest);

    const validation = validatePortfolio(options());
    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).toEqual([]);
    expect(readObject(manifestPath).skills).toHaveProperty(
      'martin/audio-transcriber',
    );
    expect(Object.keys(readObject(manifestPath).skills)).toHaveLength(1);

    const plan = buildPortfolioPlan({ ...options(), deployment: 'work-pkm' });
    expect(plan.errors).toEqual([]);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      skill_id: 'martin/audio-transcriber',
      health: 'not-deployed',
    });
  });

  it('fails closed on missing, orphan and non-Work dependency scope', () => {
    configureWorkPrivateDependency();
    const manifestBaseline = fs.readFileSync(manifestPath, 'utf8');
    const lockBaseline = fs.readFileSync(lockPath, 'utf8');

    updateObject(lockPath, (lock) => {
      delete lock.skills['martin/audio-transcriber'].data_dependencies[dependencyId];
    });
    expect(validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('data-dependency-lock-missing');

    fs.writeFileSync(lockPath, lockBaseline);
    updateObject(lockPath, (lock) => {
      lock.skills['martin/audio-transcriber'].data_dependencies.orphan = {
        ...lock.skills['martin/audio-transcriber'].data_dependencies[dependencyId],
      };
    });
    expect(validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('data-dependency-lock-orphan');

    fs.writeFileSync(lockPath, lockBaseline);
    fs.writeFileSync(manifestPath, manifestBaseline);
    updateObject(manifestPath, (manifest) => {
      manifest.skills['martin/audio-transcriber']
        .data_dependencies[0].deployments = ['life-os'];
    });
    const validation = validatePortfolio(options());
    expect(validation.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'data-dependency-scope-divergent',
        deployment: 'life-os',
      }),
    ]));
    expect(
      buildPortfolioPlan({ ...options(), deployment: 'life-os' }).entries[0],
    ).toMatchObject({
      action: 'blocked',
      health: 'data-dependency-unhealthy',
    });
  });

  it('fails closed on dependency revision, path, hash, mode and missing subtree drift', () => {
    configureWorkPrivateDependency();
    const manifestBaseline = fs.readFileSync(manifestPath, 'utf8');
    const lockBaseline = fs.readFileSync(lockPath, 'utf8');
    const codes = (): string[] => validatePortfolio(options())
      .diagnostics.map((diagnostic) => diagnostic.code);

    updateObject(lockPath, (lock) => {
      lock.skills['martin/audio-transcriber']
        .data_dependencies[dependencyId].source_revision =
        '0123456789abcdef0123456789abcdef01234567';
    });
    expect(codes()).toContain('data-dependency-revision-divergent');

    fs.writeFileSync(lockPath, lockBaseline);
    updateObject(lockPath, (lock) => {
      lock.skills['martin/audio-transcriber']
        .data_dependencies[dependencyId].path =
        'packs/work-private/wrong-pack';
    });
    expect(codes()).toContain('data-dependency-path-divergent');

    fs.writeFileSync(lockPath, lockBaseline);
    updateObject(lockPath, (lock) => {
      lock.skills['martin/audio-transcriber']
        .data_dependencies[dependencyId].tree_hash =
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    });
    expect(codes()).toContain('data-dependency-hash-drift');

    fs.writeFileSync(lockPath, lockBaseline);
    updateObject(lockPath, (lock) => {
      lock.skills['martin/audio-transcriber']
        .data_dependencies[dependencyId].executable_files = [];
    });
    expect(codes()).toContain('data-dependency-executable-manifest-drift');

    fs.writeFileSync(lockPath, lockBaseline);
    fs.writeFileSync(manifestPath, manifestBaseline);
    updateObject(manifestPath, (manifest) => {
      manifest.skills['martin/audio-transcriber']
        .data_dependencies[0].path =
        'packs/work-private/missing-pack';
    });
    updateObject(lockPath, (lock) => {
      lock.skills['martin/audio-transcriber']
        .data_dependencies[dependencyId].path =
        'packs/work-private/missing-pack';
    });
    const missing = validatePortfolio(options());
    expect(missing.valid).toBe(false);
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('data-dependency-subtree-missing');
    const plan = buildPortfolioPlan({ ...options(), deployment: 'work-pkm' });
    expect(plan.errors.map((diagnostic) => diagnostic.code))
      .toContain('data-dependency-subtree-missing');
    expect(plan.entries[0]).toMatchObject({
      action: 'blocked',
      health: 'data-dependency-unhealthy',
    });
    expect(buildPortfolioStatus(options()).valid).toBe(false);
  });

  it('rejects Profile and deployment budget overflow', () => {
    updateObject(manifestPath, (manifest) => {
      manifest.profiles.default.budgets.max_description_chars = 100;
    });
    const codes = validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain('profile-description-budget-overflow');
    expect(codes).toContain('deployment-description-budget-overflow');
  });

  it('rejects project/device suffixes in canonical IDs', () => {
    const replacement = 'martin/audio-transcriber-life-os';
    updateObject(manifestPath, (manifest) => {
      manifest.skills[replacement] = manifest.skills['martin/audio-transcriber'];
      delete manifest.skills['martin/audio-transcriber'];
      manifest.profiles.default.include = [replacement];
    });
    updateObject(lockPath, (lock) => {
      lock.skills[replacement] = lock.skills['martin/audio-transcriber'];
      delete lock.skills['martin/audio-transcriber'];
      lock.deployments['life-os'].resolved_skills = [replacement];
    });
    expect(validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('canonical-suffix-forbidden');
  });

  it('uses delimiter-aware suffix classification shared with Lifecycle', () => {
    const replacement = 'martin/gnulinux';
    updateObject(manifestPath, (manifest) => {
      manifest.skills[replacement] = manifest.skills['martin/audio-transcriber'];
      delete manifest.skills['martin/audio-transcriber'];
      manifest.profiles.default.include = [replacement];
    });
    updateObject(lockPath, (lock) => {
      lock.skills[replacement] = lock.skills['martin/audio-transcriber'];
      delete lock.skills['martin/audio-transcriber'];
      lock.deployments['life-os'].resolved_skills = [replacement];
    });
    expect(validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code))
      .not.toContain('canonical-suffix-forbidden');
  });

  it('rejects exposure basename collisions inside one deployment', () => {
    updateObject(manifestPath, (manifest) => {
      manifest.skills['martin/other'] = {
        ...manifest.skills['martin/audio-transcriber'],
        capabilities: ['other'],
      };
      manifest.profiles.default.include.push('martin/other');
    });
    updateObject(lockPath, (lock) => {
      lock.skills['martin/other'] = { ...lock.skills['martin/audio-transcriber'] };
      lock.deployments['life-os'].resolved_skills = [
        'martin/audio-transcriber',
        'martin/other',
      ];
    });
    expect(validatePortfolio(options()).diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('deployment-exposure-collision');
  });

  it('fails closed on expired exceptions and surfaces active exceptions', () => {
    const exception = {
      skill: 'martin/audio-transcriber',
      deployment: 'life-os',
      pinned_revision: '0123456789abcdef0123456789abcdef01234567',
      reason: 'staged rollout',
      owner: 'martin',
      expires_at: '2026-07-26',
    };
    updateObject(lockPath, (lock) => {
      lock.exceptions = [exception];
    });
    expect(validatePortfolio(options('2026-07-26')).diagnostics)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'migration-exception-expired',
        }),
      ]));

    updateObject(lockPath, (lock) => {
      lock.exceptions[0].expires_at = '2026-07-27';
    });
    const active = validatePortfolio(options('2026-07-26'));
    expect(active.valid).toBe(true);
    expect(active.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'migration-exception-active',
      }),
    ]);
    expect(
      buildPortfolioPlan({ ...options('2026-07-26'), deployment: 'life-os' })
        .entries[0].migration_exception,
    ).toMatchObject({ expires_at: '2026-07-27', owner: 'martin' });
  });

  it('rejects unmanaged deployment target collisions', () => {
    const target = path.join(projectRoot, '.agents', 'skills', 'audio-transcriber');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'local.txt'), 'unmanaged\n');
    const result = buildPortfolioPlan({ ...options(), deployment: 'life-os' });
    expect(result.entries[0]).toMatchObject({
      action: 'blocked',
      health: 'exposure-collision',
    });
    expect(result.errors.map((diagnostic) => diagnostic.code))
      .toContain('deployment-target-collision');
    const status = buildPortfolioStatus(options());
    expect(status.valid).toBe(false);
    expect(status.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('deployment-target-collision');
    expect(buildPortfolioDeploymentView(options()).diagnostics.map(
      (diagnostic) => diagnostic.code,
    )).toContain('deployment-target-collision');
  });

  it('exposes all four read-only commands with deterministic JSON', async () => {
    const before = hashSkillSubtree(tmpDir);
    const output: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => output.push(args.join(' '));
    console.error = (...args: unknown[]) => output.push(args.join(' '));
    const commandOptions = {
      manifest: manifestPath,
      lock: lockPath,
      deviceRegistry: registryPath,
      device: 'test-device',
      asOf: '2026-07-26',
      json: true,
    };
    try {
      await portfolioValidateCommand(commandOptions);
      await portfolioPlanCommand('life-os', commandOptions);
      await portfolioStatusCommand({ ...commandOptions, all: true });
      await portfolioDeploymentViewCommand({ ...commandOptions, all: true });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(process.exitCode).toBeUndefined();
    expect(output).toHaveLength(4);
    for (const item of output) {
      expect(JSON.parse(item)).toMatchObject({ writes_performed: 0 });
    }
    expect(hashSkillSubtree(tmpDir)).toEqual(before);
  });
});
