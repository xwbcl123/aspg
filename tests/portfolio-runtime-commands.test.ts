import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { stringify } from 'yaml';
import {
  acquireActivationLock,
  advanceActivationPhase,
  captureActivationSnapshot,
  createActivationOperation,
} from '../src/activation-journal.js';
import {
  portfolioRuntimeApplyCommand,
  portfolioRuntimeBootstrapCommand,
  portfolioRuntimeDoctorCommand,
  portfolioRuntimeRecoveryCommand,
  type PortfolioRecoveryCommandOptions,
  type PortfolioRuntimeCommandOptions,
} from '../src/commands/portfolio-runtime.js';
import { hashSkillSubtreeAtRevision } from '../src/portfolio-hash.js';

const D9_SKILL = 'martin/artifact-template-cstc-eu-rspo-default-deck';
const D9_DEPENDENCY = 'cstc-eu-rspo-employer-pack';
const D9_SKILL_PATH = 'skills/artifact-template-cstc-eu-rspo-default-deck';
const D9_DEPENDENCY_PATH =
  'packs/work-private/artifact-template-cstc-eu-rspo-default-deck';
const GENERIC_SKILL = 'martin/audio-transcriber';
const GENERIC_SKILL_PATH = 'skills/audio-transcriber';

let fixtureRoot: string;
let manifestPath: string;
let lockPath: string;
let registryPath: string;
let sourceRoot: string;
let lifeProjectRoot: string;
let workProjectRoot: string;
let lifeRuntimeRoot: string;
let workRuntimeRoot: string;
let stateRoot: string;
let revision: string;
let builtCli: string;

interface CapturedCommand {
  logs: string[];
  errors: string[];
  exitCode: number | undefined;
}

function writeYaml(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, stringify(value));
}

function commitSource(): string {
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
  return execFileSync(
    'git',
    ['-C', sourceRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
}

function binding(projectRoot: string, deployment: 'life' | 'work'): void {
  const root = path.join(projectRoot, '.aspg');
  fs.mkdirSync(root, { recursive: true });
  writeYaml(path.join(root, 'portfolio.yaml'), {
    version: 1,
    portfolio: {
      repository: 'git@example.test:portfolio/control.git',
      revision: 'f'.repeat(40),
      deployment,
    },
  });
}

function options(
  deployment: 'life' | 'work',
  overrides: Partial<PortfolioRuntimeCommandOptions> = {},
): PortfolioRuntimeCommandOptions {
  return {
    manifest: manifestPath,
    lock: lockPath,
    deviceRegistry: registryPath,
    device: 'test-device',
    deployment,
    fixtureRoot,
    json: true,
    ...overrides,
  };
}

function recoveryOptions(operationId: string): PortfolioRecoveryCommandOptions {
  return {
    deviceRegistry: registryPath,
    device: 'test-device',
    fixtureRoot,
    operationId,
    json: true,
  };
}

async function captureCommand(action: () => Promise<void>): Promise<CapturedCommand> {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(' '));
  });
  process.exitCode = undefined as unknown as number;
  try {
    await action();
    return {
      logs,
      errors,
      exitCode: process.exitCode,
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
    process.exitCode = undefined as unknown as number;
  }
}

function parsedOutput(captured: CapturedCommand): any {
  expect(captured.logs).toHaveLength(1);
  return JSON.parse(captured.logs[0]);
}

function inventory(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string, prefix = ''): void => {
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
  visit(root);
  return result;
}

function portableState(projectRoot: string, deployment: string): any {
  return JSON.parse(fs.readFileSync(
    path.join(projectRoot, '.aspg', 'deployments', deployment, 'state.yaml'),
    'utf8',
  ));
}

function runBuiltRuntimeCli(
  command: 'apply' | 'refresh' | 'doctor',
  deployment: 'life' | 'work',
  extra: string[] = [],
) {
  return spawnSync(
    process.execPath,
    [
      builtCli,
      'portfolio',
      command,
      '--deployment',
      deployment,
      '--device',
      'test-device',
      '--manifest',
      manifestPath,
      '--lock',
      lockPath,
      '--device-registry',
      registryPath,
      '--fixture-root',
      fixtureRoot,
      '--json',
      ...extra,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  builtCli = path.join(process.cwd(), 'dist', 'index.js');
  expect(fs.statSync(builtCli).isFile()).toBe(true);
});

beforeEach(() => {
  process.exitCode = undefined as unknown as number;
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-runtime-command-'));
  manifestPath = path.join(fixtureRoot, 'portfolio.yaml');
  lockPath = path.join(fixtureRoot, 'portfolio-lock.yaml');
  registryPath = path.join(fixtureRoot, 'device-registry.yaml');
  sourceRoot = path.join(fixtureRoot, 'sources', 'private');
  lifeProjectRoot = path.join(fixtureRoot, 'projects', 'Life-OS');
  workProjectRoot = path.join(fixtureRoot, 'projects', 'Work-PKM');
  lifeRuntimeRoot = path.join(lifeProjectRoot, '.agents', 'skills');
  workRuntimeRoot = path.join(workProjectRoot, '.agents', 'skills');
  stateRoot = path.join(fixtureRoot, 'device-state');

  fs.mkdirSync(path.join(sourceRoot, GENERIC_SKILL_PATH, 'scripts'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(sourceRoot, D9_SKILL_PATH), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, D9_DEPENDENCY_PATH, 'scripts'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(sourceRoot, GENERIC_SKILL_PATH, 'SKILL.md'),
    '# audio transcriber\n',
  );
  const genericExecutable = path.join(
    sourceRoot,
    GENERIC_SKILL_PATH,
    'scripts',
    'transcribe.sh',
  );
  fs.writeFileSync(genericExecutable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(genericExecutable, 0o755);
  fs.writeFileSync(
    path.join(sourceRoot, D9_SKILL_PATH, 'SKILL.md'),
    '# private deck engine\n',
  );
  fs.writeFileSync(
    path.join(sourceRoot, D9_DEPENDENCY_PATH, 'README.md'),
    'employer pack\n',
  );
  const packExecutable = path.join(
    sourceRoot,
    D9_DEPENDENCY_PATH,
    'scripts',
    'render.sh',
  );
  fs.writeFileSync(packExecutable, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(packExecutable, 0o755);
  fs.mkdirSync(lifeRuntimeRoot, { recursive: true });
  fs.mkdirSync(workRuntimeRoot, { recursive: true });
  fs.mkdirSync(stateRoot);
  binding(lifeProjectRoot, 'life');
  binding(workProjectRoot, 'work');

  execFileSync('git', ['init', '-q', sourceRoot]);
  revision = commitSource();
  const genericDigest = hashSkillSubtreeAtRevision(sourceRoot, {
    revision,
    sourcePath: GENERIC_SKILL_PATH,
  });
  const d9Digest = hashSkillSubtreeAtRevision(sourceRoot, {
    revision,
    sourcePath: D9_SKILL_PATH,
  });
  const dependencyDigest = hashSkillSubtreeAtRevision(sourceRoot, {
    revision,
    sourcePath: D9_DEPENDENCY_PATH,
  });

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
      [GENERIC_SKILL]: {
        source: 'private',
        path: GENERIC_SKILL_PATH,
        ownership: 'managed-link',
        exposure_name: 'audio-transcriber',
        description_chars: 100,
        capabilities: [],
        data_dependencies: [],
      },
      [D9_SKILL]: {
        source: 'private',
        path: D9_SKILL_PATH,
        ownership: 'managed-link',
        exposure_name: 'artifact-template-cstc-eu-rspo-default-deck',
        description_chars: 100,
        capabilities: [],
        data_dependencies: [{
          id: D9_DEPENDENCY,
          source: 'private',
          path: D9_DEPENDENCY_PATH,
          privacy: 'work-private',
          deployments: ['work'],
          required: true,
        }],
      },
    },
    profiles: {
      life: {
        include: [GENERIC_SKILL],
        exclude: [],
        budgets: {
          max_skills: 2,
          max_description_chars: 1000,
        },
      },
      work: {
        include: [D9_SKILL],
        exclude: [],
        budgets: {
          max_skills: 2,
          max_description_chars: 1000,
        },
      },
    },
    deployments: {
      life: {
        project_ref: 'life-project',
        profiles: ['life'],
        include: [],
        exclude: [],
      },
      work: {
        project_ref: 'work-project',
        profiles: ['work'],
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
        revision,
      },
    },
    skills: {
      [GENERIC_SKILL]: {
        source: 'private',
        path: GENERIC_SKILL_PATH,
        source_revision: revision,
        tree_hash: genericDigest.tree_hash,
        executable_files: genericDigest.executable_files,
        overlay_hash: null,
        data_dependencies: {},
      },
      [D9_SKILL]: {
        source: 'private',
        path: D9_SKILL_PATH,
        source_revision: revision,
        tree_hash: d9Digest.tree_hash,
        executable_files: d9Digest.executable_files,
        overlay_hash: null,
        data_dependencies: {
          [D9_DEPENDENCY]: {
            source_revision: revision,
            path: D9_DEPENDENCY_PATH,
            tree_hash: dependencyDigest.tree_hash,
            executable_files: dependencyDigest.executable_files,
          },
        },
      },
    },
    deployments: {
      life: {
        resolved_skills: [GENERIC_SKILL],
      },
      work: {
        resolved_skills: [D9_SKILL],
      },
    },
    exceptions: [],
  });

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
          life: {
            project_ref: 'life-project',
            path: lifeRuntimeRoot,
            storage_provider: 'google-drive-file-provider',
            deployment_backend: 'managed-materialized',
          },
          work: {
            project_ref: 'work-project',
            path: workRuntimeRoot,
            storage_provider: 'local-filesystem',
            deployment_backend: 'managed-link',
          },
        },
      },
    },
  });
});

afterEach(() => {
  process.exitCode = undefined as unknown as number;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('fixture-only Portfolio runtime commands', () => {
  it('returns a deterministic apply dry-run with zero writes', async () => {
    const before = inventory(fixtureRoot);
    const captured = await captureCommand(() =>
      portfolioRuntimeApplyCommand(options('work', { dryRun: true }), 'apply'));
    const result = parsedOutput(captured);

    expect(captured.exitCode).toBeUndefined();
    expect(captured.errors).toEqual([]);
    expect(result).toEqual({
      mode: 'dry-run',
      mutation: 'apply',
      deployment: 'work',
      backend: 'managed-link',
      provider: 'local-filesystem',
      generation: 1,
      skills: [D9_SKILL],
      dependencies: [D9_DEPENDENCY],
      generated_files: ['.aspg/generated/private-skill-packs.json'],
      health: 'missing',
      blocking: true,
      writes_performed: 0,
    });
    expect(inventory(fixtureRoot)).toEqual(before);
  });

  it('applies local links, doctors them, then refreshes the generation', async () => {
    const applied = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('work', { operationId: 'command-link-apply' }),
      'apply',
    ));
    expect(applied.exitCode).toBeUndefined();
    expect(applied.errors).toEqual([]);
    expect(parsedOutput(applied)).toMatchObject({
      phase: 'committed',
      generation: 1,
      backend: 'managed-link',
    });
    const skillTarget = path.join(
      workRuntimeRoot,
      'artifact-template-cstc-eu-rspo-default-deck',
    );
    const dependencyTarget = path.join(
      workProjectRoot,
      '.aspg',
      'dependencies',
      D9_DEPENDENCY,
    );
    expect(fs.lstatSync(skillTarget).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(dependencyTarget).isSymbolicLink()).toBe(true);

    const doctor = await captureCommand(() =>
      portfolioRuntimeDoctorCommand(options('work')));
    expect(doctor.exitCode, JSON.stringify(doctor)).toBeUndefined();
    expect(doctor.errors).toEqual([]);
    expect(parsedOutput(doctor)).toMatchObject({
      deployment: 'work',
      backend: 'managed-link',
      health: 'in-sync',
      blocking: false,
      state_generation: 1,
    });

    const refreshed = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('work', { operationId: 'command-link-refresh' }),
      'refresh',
    ));
    expect(refreshed.exitCode).toBeUndefined();
    expect(refreshed.errors).toEqual([]);
    expect(parsedOutput(refreshed)).toMatchObject({
      phase: 'committed',
      generation: 2,
      backend: 'managed-link',
    });
    expect(portableState(workProjectRoot, 'work')).toMatchObject({
      generation: 2,
      entries: [{
        skill_id: D9_SKILL,
        dependencies: [{ id: D9_DEPENDENCY }],
      }],
    });
  });

  it('materializes Google Drive content only with explicit ready observations', async () => {
    const captured = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('life', {
        operationId: 'command-drive-apply',
        providerStatus: 'online',
        providerHydrated: true,
        providerWritable: true,
      }),
      'apply',
    ));

    expect(captured.exitCode).toBeUndefined();
    expect(captured.errors).toEqual([]);
    expect(parsedOutput(captured)).toMatchObject({
      phase: 'committed',
      generation: 1,
      backend: 'managed-materialized',
    });
    const target = path.join(lifeRuntimeRoot, 'audio-transcriber');
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'))
      .toBe('# audio transcriber\n');
  });

  it('explicitly bootstraps a new device state root from portable generation', async () => {
    await captureCommand(() => portfolioRuntimeApplyCommand(
      options('work', { operationId: 'bootstrap-source-apply' }),
      'apply',
    ));
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.mkdirSync(stateRoot, { recursive: true });

    const beforeDryRun = inventory(fixtureRoot);
    const dryRun = await captureCommand(() => portfolioRuntimeBootstrapCommand(
      options('work', { dryRun: true }),
    ));
    expect(dryRun.exitCode).toBeUndefined();
    expect(parsedOutput(dryRun)).toMatchObject({
      mode: 'dry-run',
      action: 'bootstrap-device-state',
      generation: 1,
      writes_performed: 0,
    });
    expect(inventory(fixtureRoot)).toEqual(beforeDryRun);

    const bootstrapped = runBuiltRuntimeCli('bootstrap-device-state', 'work');
    expect(bootstrapped.status, bootstrapped.stderr).toBe(0);
    expect(bootstrapped.stderr).toBe('');
    expect(JSON.parse(bootstrapped.stdout)).toMatchObject({
      status: 'bootstrapped',
      portfolio: 'test-portfolio',
      deployment: 'work',
      project_ref: 'work-project',
      generation: 1,
    });

    const refreshed = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('work', { operationId: 'after-device-bootstrap' }),
      'refresh',
    ));
    expect(refreshed.exitCode).toBeUndefined();
    expect(parsedOutput(refreshed)).toMatchObject({
      phase: 'committed',
      generation: 2,
    });
  });

  it('fails closed with zero writes when Google provider observations are missing', async () => {
    const before = inventory(fixtureRoot);
    const captured = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('life', { operationId: 'command-drive-uncertain' }),
      'apply',
    ));

    expect(captured.exitCode).toBe(2);
    expect(captured.logs).toEqual([]);
    expect(captured.errors.join('\n')).toContain('ASPG_RUNTIME_PROVIDER_NOT_READY');
    expect(captured.errors.join('\n'))
      .toContain('Google Drive status/hydration/writability must be explicit');
    expect(inventory(fixtureRoot)).toEqual(before);
  });

  it('routes repair and rollback through explicit device operation paths', async () => {
    const source = path.join(sourceRoot, GENERIC_SKILL_PATH);
    const target = path.join(workRuntimeRoot, 'recovery-target');
    fs.symlinkSync(source, target, 'dir');
    const statePath = path.join(
      workProjectRoot,
      '.aspg',
      'deployments',
      'recovery',
      'state.yaml',
    );
    const repair = createActivationOperation({
      fixtureRoot,
      stateRoot,
      targetRoot: workProjectRoot,
      portableStatePath: statePath,
      portfolio: 'test-portfolio',
      deployment: 'recovery',
      projectRef: 'work-project',
      deviceId: 'test-device',
      mutation: 'repair',
      expectedGeneration: 0,
      operationId: 'command-repair',
    });
    acquireActivationLock(repair);
    captureActivationSnapshot(repair, ['.agents/skills/recovery-target']);
    advanceActivationPhase(repair, 'staged');
    fs.unlinkSync(target);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'partial.txt'), 'partial\n');
    advanceActivationPhase(repair, 'activated');

    const repaired = await captureCommand(() => portfolioRuntimeRecoveryCommand(
      recoveryOptions('command-repair'),
      'repair',
    ));
    expect(repaired.exitCode).toBeUndefined();
    expect(repaired.errors).toEqual([]);
    expect(parsedOutput(repaired)).toMatchObject({
      operation_id: 'command-repair',
      phase: 'rolled-back',
    });
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));

    const rollbackTarget = path.join(workRuntimeRoot, 'rollback-target');
    fs.symlinkSync(source, rollbackTarget, 'dir');
    const rollback = createActivationOperation({
      fixtureRoot,
      stateRoot,
      targetRoot: workProjectRoot,
      portableStatePath: path.join(
        workProjectRoot,
        '.aspg',
        'deployments',
        'rollback',
        'state.yaml',
      ),
      portfolio: 'test-portfolio',
      deployment: 'rollback',
      projectRef: 'work-project',
      deviceId: 'test-device',
      mutation: 'rollback',
      expectedGeneration: 0,
      operationId: 'command-rollback',
    });
    acquireActivationLock(rollback);
    captureActivationSnapshot(rollback, ['.agents/skills/rollback-target']);
    advanceActivationPhase(rollback, 'staged');
    fs.unlinkSync(rollbackTarget);
    fs.symlinkSync(path.join(sourceRoot, D9_DEPENDENCY_PATH), rollbackTarget, 'dir');

    const rolledBack = await captureCommand(() => portfolioRuntimeRecoveryCommand(
      recoveryOptions('command-rollback'),
      'rollback',
    ));
    expect(rolledBack.exitCode).toBeUndefined();
    expect(rolledBack.errors).toEqual([]);
    expect(parsedOutput(rolledBack)).toMatchObject({
      operation_id: 'command-rollback',
      phase: 'rolled-back',
    });
    expect(fs.realpathSync(rollbackTarget)).toBe(fs.realpathSync(source));
  });

  it('writes the D9 generated pack config with a project-relative root', async () => {
    const captured = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('work', { operationId: 'command-d9-apply' }),
      'apply',
    ));
    expect(captured.exitCode).toBeUndefined();
    expect(captured.errors).toEqual([]);

    const generated = JSON.parse(fs.readFileSync(
      path.join(
        workProjectRoot,
        '.aspg',
        'generated',
        'private-skill-packs.json',
      ),
      'utf8',
    ));
    expect(generated).toEqual({
      schema_version: 1,
      packs: [{
        pack_id: 'work-private/cstc-eu-rspo-default-deck',
        root: `.aspg/dependencies/${D9_DEPENDENCY}`,
      }],
    });
    expect(JSON.stringify(generated)).not.toContain(fixtureRoot);
  });

  it('refuses a real fixture root before any runtime write', async () => {
    const before = inventory(fixtureRoot);
    const realTarget = path.join(
      process.cwd(),
      '.agents',
      'skills',
      'w6-command-never',
    );
    const captured = await captureCommand(() => portfolioRuntimeApplyCommand(
      options('work', {
        fixtureRoot: process.cwd(),
        operationId: 'command-real-refused',
      }),
      'apply',
    ));

    expect(captured.exitCode).toBe(2);
    expect(captured.logs).toEqual([]);
    expect(captured.errors.join('\n')).toContain('ASPG_RUNTIME_REAL_PATH_REFUSED');
    expect(inventory(fixtureRoot)).toEqual(before);
    expect(fs.existsSync(realTarget)).toBe(false);
  });

  it('executes one built CLI dry-run smoke entirely below the fixture', () => {
    const result = runBuiltRuntimeCli('apply', 'work', ['--dry-run']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      mutation: 'apply',
      backend: 'managed-link',
      writes_performed: 0,
    });
    expect(fs.statSync(builtCli).isFile()).toBe(true);
  });

  it('parses explicit true Google provider booleans in the built CLI', () => {
    const result = runBuiltRuntimeCli('apply', 'life', [
      '--operation-id',
      'built-drive-true',
      '--provider-status',
      'online',
      '--provider-hydrated',
      'true',
      '--provider-writable',
      'true',
    ]);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      phase: 'committed',
      generation: 1,
      backend: 'managed-materialized',
    });
    expect(fs.lstatSync(path.join(lifeRuntimeRoot, 'audio-transcriber')).isDirectory())
      .toBe(true);
  });

  it('parses explicit false Google hydration and performs zero writes', () => {
    const before = inventory(fixtureRoot);
    const result = runBuiltRuntimeCli('apply', 'life', [
      '--operation-id',
      'built-drive-not-hydrated',
      '--provider-status',
      'online',
      '--provider-hydrated',
      'false',
      '--provider-writable',
      'true',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ASPG_RUNTIME_PROVIDER_NOT_READY');
    expect(result.stderr).toContain('google drive content is not hydrated');
    expect(inventory(fixtureRoot)).toEqual(before);
  });

  it('parses explicit false Google writability and performs zero writes', () => {
    const before = inventory(fixtureRoot);
    const result = runBuiltRuntimeCli('apply', 'life', [
      '--operation-id',
      'built-drive-not-writable',
      '--provider-status',
      'online',
      '--provider-hydrated',
      'true',
      '--provider-writable',
      'false',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ASPG_RUNTIME_PROVIDER_NOT_READY');
    expect(result.stderr).toContain('google drive runtime root is not writable');
    expect(inventory(fixtureRoot)).toEqual(before);
  });

  it('rejects a missing operation ID in the built CLI with zero writes', () => {
    const before = inventory(fixtureRoot);
    const result = runBuiltRuntimeCli('apply', 'work');

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('--operation-id is required');
    expect(inventory(fixtureRoot)).toEqual(before);
  });

  it('rejects built CLI apply when a portable generation already exists', () => {
    const first = runBuiltRuntimeCli('apply', 'work', [
      '--operation-id',
      'built-first-apply',
    ]);
    expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0);
    expect(portableState(workProjectRoot, 'work')).toMatchObject({ generation: 1 });
    const before = inventory(fixtureRoot);

    const second = runBuiltRuntimeCli('apply', 'work', [
      '--operation-id',
      'built-second-apply',
    ]);
    expect(second.status).toBe(2);
    expect(second.stdout).toBe('');
    expect(second.stderr).toContain(
      'apply requires no existing portable deployment state',
    );
    expect(inventory(fixtureRoot)).toEqual(before);
  });

  it('rejects built CLI refresh without a portable generation and writes nothing', () => {
    const before = inventory(fixtureRoot);
    const result = runBuiltRuntimeCli('refresh', 'work', [
      '--operation-id',
      'built-refresh-without-state',
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'refresh requires existing portable deployment state',
    );
    expect(inventory(fixtureRoot)).toEqual(before);
  });
});
