import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  materializeManagedContent,
  type ManagedMaterializationItem,
} from '../src/provider-materialize.js';
import { preflightProvider } from '../src/provider-preflight.js';
import {
  hashSkillSubtree,
  hashSkillSubtreeAtRevision,
  type SkillSubtreeDigest,
} from '../src/portfolio-hash.js';
import type { LockedContentIdentity } from '../src/portfolio-runtime-types.js';

let fixtureRoot: string;
let repositoryRoot: string;
let runtimeRoot: string;
let baseRevision: string;
let skillDigest: SkillSubtreeDigest;
let dependencyDigest: SkillSubtreeDigest;

const skillPath = 'skills/demo';
const dependencyPath = 'packs/work-private/demo';

function commit(repository: string, message: string): string {
  execFileSync('git', ['-C', repository, 'add', '.']);
  execFileSync(
    'git',
    [
      '-C',
      repository,
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
    ['-C', repository, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
}

function locked(
  source: string,
  sourcePath: string,
  revision: string,
  digest: SkillSubtreeDigest,
): LockedContentIdentity {
  return {
    source,
    source_revision: revision,
    path: sourcePath,
    tree_hash: digest.tree_hash,
    executable_files: digest.executable_files,
  };
}

function item(
  id: string,
  kind: ManagedMaterializationItem['kind'],
  sourcePath: string,
  target: string,
  revision: string,
  digest: SkillSubtreeDigest,
  deployed: SkillSubtreeDigest | null = null,
  repository = repositoryRoot,
): ManagedMaterializationItem {
  return {
    id,
    kind,
    required: true,
    repository_root: repository,
    target,
    locked: locked('private', sourcePath, revision, digest),
    deployed,
  };
}

function readyPreflight() {
  return preflightProvider({
    fixture_root: fixtureRoot,
    runtime_root: runtimeRoot,
    storage_provider: 'google-drive-file-provider',
    deployment_backend: 'managed-materialized',
    google_drive: { status: 'online', hydrated: true, writable: true },
  });
}

function apply(
  items: ManagedMaterializationItem[],
  operationId = 'test-operation',
  mutation: 'apply' | 'refresh' = 'apply',
) {
  return materializeManagedContent({
    fixture_root: fixtureRoot,
    operation_id: operationId,
    mutation,
    preflight: readyPreflight(),
    items,
  });
}

function baseItems(
  skillDeployed: SkillSubtreeDigest | null = null,
  dependencyDeployed: SkillSubtreeDigest | null = null,
): ManagedMaterializationItem[] {
  return [
    item(
      'martin/demo',
      'skill',
      skillPath,
      'demo',
      baseRevision,
      skillDigest,
      skillDeployed,
    ),
    item(
      'demo-employer-pack',
      'dependency',
      dependencyPath,
      'demo-pack',
      baseRevision,
      dependencyDigest,
      dependencyDeployed,
    ),
  ];
}

function runtimeEntries(): string[] {
  return fs.readdirSync(runtimeRoot).sort();
}

function operationArtifacts(): string[] {
  return runtimeEntries().filter((entry) => (
    entry.includes('.aspg-stage-') || entry.includes('.aspg-backup-')
  ));
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-provider-materialize-'));
  repositoryRoot = path.join(fixtureRoot, 'source', 'private');
  runtimeRoot = path.join(fixtureRoot, 'runtime', '.agents', 'skills');
  fs.mkdirSync(path.join(repositoryRoot, skillPath, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, dependencyPath, 'scripts'), { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, skillPath, 'SKILL.md'), 'demo v1\n');
  const skillExecutable = path.join(repositoryRoot, skillPath, 'scripts', 'run.sh');
  fs.writeFileSync(skillExecutable, '#!/bin/sh\necho v1\n');
  fs.chmodSync(skillExecutable, 0o755);
  fs.writeFileSync(
    path.join(repositoryRoot, dependencyPath, 'README.md'),
    'employer pack v1\n',
  );
  const dependencyExecutable = path.join(
    repositoryRoot,
    dependencyPath,
    'scripts',
    'render.sh',
  );
  fs.writeFileSync(dependencyExecutable, '#!/bin/sh\necho employer v1\n');
  fs.chmodSync(dependencyExecutable, 0o755);
  execFileSync('git', ['init', '-q', repositoryRoot]);
  baseRevision = commit(repositoryRoot, 'base canonical content');
  skillDigest = hashSkillSubtreeAtRevision(
    repositoryRoot,
    { revision: baseRevision, sourcePath: skillPath },
  );
  dependencyDigest = hashSkillSubtreeAtRevision(
    repositoryRoot,
    { revision: baseRevision, sourcePath: dependencyPath },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('Wave 6 managed materialization', () => {
  it('atomically applies Skill and required dependency from pinned Git objects', () => {
    fs.writeFileSync(
      path.join(repositoryRoot, 'portfolio-lock-marker.yaml'),
      `source_revision: ${baseRevision}\n`,
    );
    const lockCommit = commit(repositoryRoot, 'self-hosted Lock commit');
    expect(lockCommit).not.toBe(baseRevision);

    const result = apply(baseItems());
    expect(result.status).toBe('committed');
    expect(result.targets.map((target) => target.action)).toEqual(['created', 'created']);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(skillDigest);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo-pack'))).toEqual(dependencyDigest);
    expect(
      fs.statSync(path.join(runtimeRoot, 'demo', 'scripts', 'run.sh')).mode & 0o111,
    ).not.toBe(0);
    expect(
      fs.statSync(path.join(runtimeRoot, 'demo-pack', 'scripts', 'render.sh')).mode & 0o111,
    ).not.toBe(0);
    expect(runtimeEntries()).toEqual(['demo', 'demo-pack']);
    expect(operationArtifacts()).toEqual([]);
    expect(
      runtimeEntries().some((entry) => (
        entry.includes('aspg-managed-link') || entry === '.aspg-copy-fallback'
      )),
    ).toBe(false);

    const before = hashSkillSubtree(runtimeRoot);
    const second = apply(
      baseItems(skillDigest, dependencyDigest),
      'idempotent-refresh',
      'refresh',
    );
    expect(second.status).toBe('noop');
    expect(second.targets.map((target) => target.action)).toEqual(['noop', 'noop']);
    expect(hashSkillSubtree(runtimeRoot)).toEqual(before);
  });

  it('blocks required dependency target missing, content drift and mode drift', () => {
    apply(baseItems());
    const skillBefore = hashSkillSubtree(path.join(runtimeRoot, 'demo'));

    fs.rmSync(path.join(runtimeRoot, 'demo-pack'), { recursive: true });
    expect(() => apply(
      baseItems(skillDigest, dependencyDigest),
      'dependency-missing',
      'refresh',
    )).toThrow(/ASPG_MATERIALIZE_DEPENDENCY_MISSING/);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(skillBefore);
    expect(operationArtifacts()).toEqual([]);

    apply([
      item(
        'demo-employer-pack',
        'dependency',
        dependencyPath,
        'demo-pack',
        baseRevision,
        dependencyDigest,
      ),
    ], 'restore-dependency');
    fs.appendFileSync(path.join(runtimeRoot, 'demo-pack', 'README.md'), 'local drift\n');
    expect(() => apply(
      baseItems(skillDigest, dependencyDigest),
      'dependency-content-drift',
      'refresh',
    )).toThrow(/ASPG_MATERIALIZE_DEPENDENCY_CONTENT_DRIFT/);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(skillBefore);
    expect(operationArtifacts()).toEqual([]);

    fs.rmSync(path.join(runtimeRoot, 'demo-pack'), { recursive: true });
    apply([
      item(
        'demo-employer-pack',
        'dependency',
        dependencyPath,
        'demo-pack',
        baseRevision,
        dependencyDigest,
      ),
    ], 'restore-dependency-again');
    fs.chmodSync(path.join(runtimeRoot, 'demo-pack', 'scripts', 'render.sh'), 0o644);
    expect(() => apply(
      baseItems(skillDigest, dependencyDigest),
      'dependency-mode-drift',
      'refresh',
    )).toThrow(/ASPG_MATERIALIZE_DEPENDENCY_MODE_DRIFT/);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(skillBefore);
    expect(operationArtifacts()).toEqual([]);
  });

  it('refreshes from a new revision and rolls the entire batch back on partial activation', () => {
    apply(baseItems());
    const oldSkill = hashSkillSubtree(path.join(runtimeRoot, 'demo'));
    const oldDependency = hashSkillSubtree(path.join(runtimeRoot, 'demo-pack'));

    fs.writeFileSync(path.join(repositoryRoot, skillPath, 'SKILL.md'), 'demo v2\n');
    fs.writeFileSync(
      path.join(repositoryRoot, dependencyPath, 'README.md'),
      'employer pack v2\n',
    );
    const nextRevision = commit(repositoryRoot, 'updated canonical content');
    const nextSkillDigest = hashSkillSubtreeAtRevision(
      repositoryRoot,
      { revision: nextRevision, sourcePath: skillPath },
    );
    const nextDependencyDigest = hashSkillSubtreeAtRevision(
      repositoryRoot,
      { revision: nextRevision, sourcePath: dependencyPath },
    );
    const refreshItems = [
      item(
        'martin/demo',
        'skill',
        skillPath,
        'demo',
        nextRevision,
        nextSkillDigest,
        oldSkill,
      ),
      item(
        'demo-employer-pack',
        'dependency',
        dependencyPath,
        'demo-pack',
        nextRevision,
        nextDependencyDigest,
        oldDependency,
      ),
    ];

    const originalRename = fs.renameSync;
    let renameCalls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(((source, destination) => {
      renameCalls += 1;
      if (renameCalls === 4) {
        throw new Error('injected second activation failure');
      }
      return originalRename(source, destination);
    }) as typeof fs.renameSync);

    expect(() => apply(refreshItems, 'partial-activation', 'refresh'))
      .toThrow(/injected second activation failure/);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(oldSkill);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo-pack'))).toEqual(oldDependency);
    expect(operationArtifacts()).toEqual([]);

    vi.restoreAllMocks();
    const success = apply(refreshItems, 'successful-refresh', 'refresh');
    expect(success.targets.map((target) => target.action))
      .toEqual(['refreshed', 'refreshed']);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(nextSkillDigest);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo-pack')))
      .toEqual(nextDependencyDigest);
  });

  it('fails before staging for provider, source, unmanaged-target and path hazards', () => {
    fs.writeFileSync(path.join(runtimeRoot, 'sentinel.txt'), 'unchanged\n');
    const before = hashSkillSubtree(runtimeRoot);
    const offline = preflightProvider({
      fixture_root: fixtureRoot,
      runtime_root: runtimeRoot,
      storage_provider: 'google-drive-file-provider',
      deployment_backend: 'managed-materialized',
      google_drive: { status: 'offline', hydrated: false, writable: false },
    });
    expect(() => materializeManagedContent({
      fixture_root: fixtureRoot,
      operation_id: 'offline',
      mutation: 'apply',
      preflight: offline,
      items: baseItems(),
    })).toThrow(/ASPG_MATERIALIZE_PROVIDER_NOT_READY/);
    expect(hashSkillSubtree(runtimeRoot)).toEqual(before);

    const unavailable = baseItems();
    unavailable[0].repository_root = path.join(fixtureRoot, 'missing-source');
    expect(() => apply(unavailable, 'source-unavailable'))
      .toThrow(/ASPG_MATERIALIZE_SOURCE_UNAVAILABLE/);
    expect(hashSkillSubtree(runtimeRoot)).toEqual(before);

    fs.mkdirSync(path.join(runtimeRoot, 'demo'));
    fs.writeFileSync(path.join(runtimeRoot, 'demo', 'unmanaged.txt'), 'unmanaged\n');
    expect(() => apply(baseItems(), 'unmanaged-target'))
      .toThrow(/ASPG_MATERIALIZE_TARGET_UNMANAGED/);
    expect(operationArtifacts()).toEqual([]);

    fs.rmSync(path.join(runtimeRoot, 'demo'), { recursive: true });
    const escaping = baseItems();
    escaping[0].target = '../outside';
    expect(() => apply(escaping, 'escaping-target'))
      .toThrow(/ASPG_MATERIALIZE_TARGET_INVALID/);
    expect(fs.existsSync(path.join(fixtureRoot, 'runtime', '.agents', 'outside'))).toBe(false);
  });

  it('rejects unsafe pinned symlinks and removes partial staging', () => {
    const unsafeRepository = path.join(fixtureRoot, 'source', 'unsafe');
    fs.mkdirSync(path.join(unsafeRepository, 'skills', 'unsafe'), { recursive: true });
    fs.writeFileSync(path.join(unsafeRepository, 'skills', 'unsafe', 'SKILL.md'), 'unsafe\n');
    fs.symlinkSync('/tmp', path.join(unsafeRepository, 'skills', 'unsafe', 'escape'));
    execFileSync('git', ['init', '-q', unsafeRepository]);
    const revision = commit(unsafeRepository, 'unsafe symlink');
    const digest = hashSkillSubtreeAtRevision(
      unsafeRepository,
      { revision, sourcePath: 'skills/unsafe' },
    );

    expect(() => apply([
      item(
        'unsafe',
        'skill',
        'skills/unsafe',
        'unsafe',
        revision,
        digest,
        null,
        unsafeRepository,
      ),
    ], 'unsafe-symlink')).toThrow(/ASPG_MATERIALIZE_SYMLINK_UNSAFE/);
    expect(fs.existsSync(path.join(runtimeRoot, 'unsafe'))).toBe(false);
    expect(operationArtifacts()).toEqual([]);
  });

  it('materializes repository-root and non-root tracked sets symmetrically', () => {
    const rootRepository = path.join(fixtureRoot, 'source', 'root-skill');
    fs.mkdirSync(path.join(rootRepository, '.aspg'), { recursive: true });
    fs.writeFileSync(path.join(rootRepository, 'SKILL.md'), 'root Skill\n');
    fs.writeFileSync(path.join(rootRepository, '.aspg', 'local-state'), 'control\n');
    execFileSync('git', ['init', '-q', rootRepository]);
    const rootRevision = commit(rootRepository, 'root Skill');
    const rootDigest = hashSkillSubtreeAtRevision(
      rootRepository,
      { revision: rootRevision, sourcePath: '.' },
    );

    const result = apply([
      item(
        'root-skill',
        'skill',
        '.',
        'root-skill',
        rootRevision,
        rootDigest,
        null,
        rootRepository,
      ),
      item(
        'martin/demo',
        'skill',
        skillPath,
        'demo',
        baseRevision,
        skillDigest,
      ),
    ], 'root-and-nonroot');
    expect(result.status).toBe('committed');
    expect(hashSkillSubtree(path.join(runtimeRoot, 'root-skill'))).toEqual(rootDigest);
    expect(hashSkillSubtree(path.join(runtimeRoot, 'demo'))).toEqual(skillDigest);
    expect(fs.existsSync(path.join(runtimeRoot, 'root-skill', '.git'))).toBe(false);
    expect(fs.existsSync(path.join(runtimeRoot, 'root-skill', '.aspg'))).toBe(false);
  });
});
