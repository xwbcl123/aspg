/**
 * Fixture-only managed-materialized primitive.
 *
 * The caller resolves Portfolio identities and ownership. This module reads
 * pinned Git objects, stages sibling directories, verifies digest/mode
 * symmetry, and activates the batch with rollback on any partial failure.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashSkillSubtree,
  hashSkillSubtreeAtRevision,
  type SkillSubtreeDigest,
} from './portfolio-hash.js';
import type {
  LockedContentIdentity,
  PortfolioMutationKind,
  ProviderPreflight,
} from './portfolio-runtime-types.js';

export class ProviderMaterializeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ProviderMaterializeError';
  }
}

export interface ManagedMaterializationItem {
  id: string;
  kind: 'skill' | 'dependency';
  required: boolean;
  repository_root: string;
  /** Defaults to the preflight runtime root; dependencies may use project root. */
  target_root?: string;
  target: string;
  locked: LockedContentIdentity;
  deployed: SkillSubtreeDigest | null;
}

export interface ManagedMaterializationRequest {
  fixture_root: string;
  operation_id: string;
  mutation: Extract<PortfolioMutationKind, 'apply' | 'refresh'>;
  preflight: ProviderPreflight;
  items: ManagedMaterializationItem[];
}

export interface ManagedMaterializationResult {
  operation_id: string;
  status: 'noop' | 'committed';
  targets: Array<{
    id: string;
    kind: ManagedMaterializationItem['kind'];
    target: string;
    action: 'noop' | 'created' | 'refreshed';
    tree_hash: string;
    executable_files: string[];
  }>;
}

interface GitEntry {
  mode: string;
  type: string;
  objectId: string;
  relative: string;
}

interface PlannedItem {
  item: ManagedMaterializationItem;
  target: string;
  action: 'noop' | 'created' | 'refreshed';
  initialDigest: SkillSubtreeDigest | null;
  stage: string | null;
  backup: string | null;
}

const ROOT_CONTROL_NAMES = new Set(['.git', '.aspg', '.aspg-copy-fallback']);
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sameDigest(first: SkillSubtreeDigest, second: SkillSubtreeDigest): boolean {
  const left = sortedUnique(first.executable_files);
  const right = sortedUnique(second.executable_files);
  return first.tree_hash === second.tree_hash
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lstatIfPresent(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function resolveWithExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_PATH_UNRESOLVED',
        `path has no existing ancestor: ${candidate}`,
      );
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function assertFixtureRoot(fixtureRootInput: string): string {
  let fixtureRoot: string;
  let temporaryRoot: string;
  try {
    fixtureRoot = fs.realpathSync(fixtureRootInput);
    temporaryRoot = fs.realpathSync(os.tmpdir());
  } catch (error) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_FIXTURE_ROOT_INVALID',
      'fixture root is unavailable',
      { cause: error },
    );
  }
  if (!fs.statSync(fixtureRoot).isDirectory()) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_FIXTURE_ROOT_INVALID',
      'fixture root is not a directory',
    );
  }
  if (fixtureRoot === temporaryRoot || !isWithin(temporaryRoot, fixtureRoot)) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_REAL_RUNTIME_REFUSED',
      'fixture root must be an explicit child of the system temporary directory',
    );
  }
  return fixtureRoot;
}

function assertWithinFixture(
  fixtureRoot: string,
  candidate: string,
  label: string,
): string {
  const resolved = resolveWithExistingAncestor(candidate);
  if (!isWithin(fixtureRoot, resolved)) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_REAL_RUNTIME_REFUSED',
      `${label} escapes the explicit fixture root: ${candidate}`,
    );
  }
  return resolved;
}

function assertPortableTarget(target: string): void {
  if (
    target.length === 0
    || target.startsWith('/')
    || target.includes('\\')
    || path.posix.normalize(target) !== target
    || target.split('/').some((segment) => (
      segment === '' || segment === '.' || segment === '..'
    ))
  ) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_TARGET_INVALID',
      `target must be a normalized portable relative path: ${target}`,
    );
  }
}

function isTopLevelControlPath(relative: string): boolean {
  const segments = relative.split('/');
  const top = segments[0];
  if (ROOT_CONTROL_NAMES.has(top)) return true;
  return segments.length === 1 && top.endsWith('.aspg-managed-link.json');
}

function readPinnedEntries(
  repositoryRoot: string,
  locked: LockedContentIdentity,
): GitEntry[] {
  let output: Buffer;
  try {
    output = execFileSync(
      'git',
      [
        '-C',
        repositoryRoot,
        'ls-tree',
        '-r',
        '-z',
        '--full-tree',
        locked.source_revision,
        '--',
        `:(literal)${locked.path}`,
      ],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_SOURCE_UNAVAILABLE',
      `${locked.source}@${locked.source_revision}:${locked.path}`,
      { cause: error },
    );
  }

  const prefix = locked.path === '.' ? '' : `${locked.path}/`;
  const entries = output.toString('utf8').split('\0').filter(Boolean).map((record) => {
    const match = /^([0-7]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        'cannot parse pinned Git tree entry',
      );
    }
    const [, mode, type, objectId, repositoryRelative] = match;
    if (
      path.posix.isAbsolute(repositoryRelative)
      || repositoryRelative.includes('\\')
      || path.posix.normalize(repositoryRelative) !== repositoryRelative
      || repositoryRelative.split('/').some((segment) => (
        segment === '' || segment === '.' || segment === '..'
      ))
    ) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        `pinned Git tree contains an unsafe path: ${repositoryRelative}`,
      );
    }
    if (prefix && !repositoryRelative.startsWith(prefix)) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        `pinned path escapes ${locked.path}: ${repositoryRelative}`,
      );
    }
    const relative = prefix ? repositoryRelative.slice(prefix.length) : repositoryRelative;
    if (!relative) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        `source path is not a directory: ${locked.path}`,
      );
    }
    return { mode, type, objectId, relative };
  }).filter((entry) => locked.path !== '.' || !isTopLevelControlPath(entry.relative));

  if (entries.length === 0) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_SOURCE_UNAVAILABLE',
      `pinned source has no tracked files: ${locked.path}`,
    );
  }
  return entries.sort((a, b) => compareText(a.relative, b.relative));
}

function readBlob(repositoryRoot: string, entry: GitEntry): Buffer {
  try {
    return execFileSync(
      'git',
      ['-C', repositoryRoot, 'cat-file', 'blob', entry.objectId],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_SOURCE_UNAVAILABLE',
      `cannot read pinned blob: ${entry.relative}`,
      { cause: error },
    );
  }
}

function cleanupOwnedPath(target: string | null): void {
  if (!target) return;
  const stat = lstatIfPresent(target);
  if (!stat) return;
  if (stat.isFile() || stat.isSymbolicLink()) {
    fs.unlinkSync(target);
  } else {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function verifySafeSymlinks(root: string): void {
  function visit(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const raw = fs.readlinkSync(absolute);
      if (path.isAbsolute(raw)) {
        throw new ProviderMaterializeError(
          'ASPG_MATERIALIZE_SYMLINK_UNSAFE',
          `absolute symlink is forbidden: ${path.relative(root, absolute)}`,
        );
      }
      const lexicalTarget = path.resolve(path.dirname(absolute), raw);
      if (!isWithin(root, lexicalTarget)) {
        throw new ProviderMaterializeError(
          'ASPG_MATERIALIZE_SYMLINK_UNSAFE',
          `symlink escapes staged root: ${path.relative(root, absolute)}`,
        );
      }
      let resolvedTarget: string;
      try {
        resolvedTarget = fs.realpathSync(lexicalTarget);
      } catch (error) {
        throw new ProviderMaterializeError(
          'ASPG_MATERIALIZE_SYMLINK_UNSAFE',
          `dangling or cyclic symlink is forbidden: ${path.relative(root, absolute)}`,
          { cause: error },
        );
      }
      if (!isWithin(root, resolvedTarget)) {
        throw new ProviderMaterializeError(
          'ASPG_MATERIALIZE_SYMLINK_UNSAFE',
          `symlink resolves outside staged root: ${path.relative(root, absolute)}`,
        );
      }
    }
  }
  visit(root);
}

function materializePinnedTree(
  repositoryRoot: string,
  locked: LockedContentIdentity,
  stage: string,
): void {
  const entries = readPinnedEntries(repositoryRoot, locked);
  const symlinks: Array<{ absolute: string; target: string }> = [];
  fs.mkdirSync(stage, { mode: 0o700 });
  for (const entry of entries) {
    if (entry.type !== 'blob') {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        `unsupported Git entry type at ${entry.relative}: ${entry.type}`,
      );
    }
    const absolute = path.join(stage, ...entry.relative.split('/'));
    if (!isWithin(stage, absolute)) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        `pinned path escapes staged root: ${entry.relative}`,
      );
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const bytes = readBlob(repositoryRoot, entry);
    if (entry.mode === '120000') {
      const target = bytes.toString('utf8');
      if (!Buffer.from(target).equals(bytes) || target.includes('\0')) {
        throw new ProviderMaterializeError(
          'ASPG_MATERIALIZE_SYMLINK_UNSAFE',
          `symlink target is not portable text: ${entry.relative}`,
        );
      }
      symlinks.push({ absolute, target });
    } else if (entry.mode === '100644' || entry.mode === '100755') {
      fs.writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(absolute, entry.mode === '100755' ? 0o755 : 0o644);
    } else {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_INVALID',
        `unsupported Git mode at ${entry.relative}: ${entry.mode}`,
      );
    }
  }
  for (const symlink of symlinks) fs.symlinkSync(symlink.target, symlink.absolute);
  verifySafeSymlinks(stage);
  fs.chmodSync(stage, 0o755);
}

function dependencyCode(
  item: ManagedMaterializationItem,
  suffix: string,
): string {
  return item.kind === 'dependency' && item.required
    ? `ASPG_MATERIALIZE_DEPENDENCY_${suffix}`
    : `ASPG_MATERIALIZE_TARGET_${suffix}`;
}

function inspectTarget(
  item: ManagedMaterializationItem,
  target: string,
): Pick<PlannedItem, 'action' | 'initialDigest'> {
  const stat = lstatIfPresent(target);
  if (!stat) {
    if (item.deployed) {
      throw new ProviderMaterializeError(
        dependencyCode(item, 'MISSING'),
        `managed target is missing: ${target}`,
      );
    }
    return { action: 'created', initialDigest: null };
  }
  if (stat.isSymbolicLink()) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_TARGET_SYMLINK_REFUSED',
      `managed-materialized target must not be a symlink: ${target}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_TARGET_UNMANAGED',
      `refusing to replace a non-directory target: ${target}`,
    );
  }
  if (!item.deployed) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_TARGET_UNMANAGED',
      `existing target has no deployment-state ownership: ${target}`,
    );
  }

  let actual: SkillSubtreeDigest;
  try {
    actual = hashSkillSubtree(target);
  } catch (error) {
    throw new ProviderMaterializeError(
      dependencyCode(item, 'CONTENT_DRIFT'),
      `cannot hash managed target: ${target}`,
      { cause: error },
    );
  }
  const expected: SkillSubtreeDigest = {
    tree_hash: item.locked.tree_hash,
    executable_files: item.locked.executable_files,
  };
  if (sameDigest(actual, expected)) return { action: 'noop', initialDigest: actual };

  const executableMatches = sortedUnique(actual.executable_files).join('\0')
    === sortedUnique(item.deployed.executable_files).join('\0');
  if (!executableMatches) {
    throw new ProviderMaterializeError(
      dependencyCode(item, 'MODE_DRIFT'),
      `managed target executable mode differs from deployment state: ${target}`,
    );
  }
  if (actual.tree_hash !== item.deployed.tree_hash) {
    throw new ProviderMaterializeError(
      dependencyCode(item, 'CONTENT_DRIFT'),
      `managed target content differs from deployment state: ${target}`,
    );
  }
  return { action: 'refreshed', initialDigest: actual };
}

function assertTargetUnchanged(plan: PlannedItem): void {
  const stat = lstatIfPresent(plan.target);
  if (!plan.initialDigest) {
    if (stat) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_TARGET_CHANGED',
        `target appeared during staging: ${plan.target}`,
      );
    }
    return;
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_TARGET_CHANGED',
      `target changed type during staging: ${plan.target}`,
    );
  }
  const actual = hashSkillSubtree(plan.target);
  if (!sameDigest(actual, plan.initialDigest)) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_TARGET_CHANGED',
      `target changed during staging: ${plan.target}`,
    );
  }
}

function verifyTarget(plan: PlannedItem): void {
  let actual: SkillSubtreeDigest;
  try {
    actual = hashSkillSubtree(plan.target);
  } catch (error) {
    throw new ProviderMaterializeError(
      dependencyCode(plan.item, 'MISSING'),
      `activated target is unavailable: ${plan.target}`,
      { cause: error },
    );
  }
  const expected: SkillSubtreeDigest = {
    tree_hash: plan.item.locked.tree_hash,
    executable_files: plan.item.locked.executable_files,
  };
  if (!sameDigest(actual, expected)) {
    const actualExecutables = sortedUnique(actual.executable_files).join('\0');
    const expectedExecutables = sortedUnique(expected.executable_files).join('\0');
    throw new ProviderMaterializeError(
      dependencyCode(
        plan.item,
        actualExecutables === expectedExecutables ? 'CONTENT_DRIFT' : 'MODE_DRIFT',
      ),
      `activated target differs from locked content: ${plan.target}`,
    );
  }
}

export function materializeManagedContent(
  request: ManagedMaterializationRequest,
): ManagedMaterializationResult {
  if (!OPERATION_ID_PATTERN.test(request.operation_id)) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_OPERATION_ID_INVALID',
      `invalid operation ID: ${request.operation_id}`,
    );
  }
  if (
    request.preflight.status !== 'ready'
    || !request.preflight.hydrated
    || !request.preflight.writable
  ) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_PROVIDER_NOT_READY',
      request.preflight.reason ?? request.preflight.status,
    );
  }
  if (request.items.length === 0) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_EMPTY_BATCH',
      'materialization requires at least one item',
    );
  }

  const fixtureRoot = assertFixtureRoot(request.fixture_root);
  const runtimeRoot = assertWithinFixture(
    fixtureRoot,
    request.preflight.runtime_root,
    'runtime root',
  );
  if (!fs.statSync(runtimeRoot).isDirectory()) {
    throw new ProviderMaterializeError(
      'ASPG_MATERIALIZE_RUNTIME_ROOT_INVALID',
      `runtime root is not a directory: ${runtimeRoot}`,
    );
  }

  const ids = new Set<string>();
  const targets = new Set<string>();
  const plans: PlannedItem[] = [];

  // Complete the whole read-only preflight before creating any staging path.
  for (const item of request.items) {
    if (ids.has(item.id)) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_DUPLICATE_ITEM',
        `duplicate item ID: ${item.id}`,
      );
    }
    ids.add(item.id);
    assertPortableTarget(item.target);
    const targetRoot = item.target_root
      ? assertWithinFixture(fixtureRoot, item.target_root, 'item target root')
      : runtimeRoot;
    if (!fs.statSync(targetRoot).isDirectory()) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_TARGET_ROOT_INVALID',
        `target root is not a directory: ${targetRoot}`,
      );
    }
    const target = path.join(targetRoot, ...item.target.split('/'));
    if (!isWithin(targetRoot, target) || targets.has(target)) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_TARGET_INVALID',
        `duplicate or escaping target: ${item.target}`,
      );
    }
    targets.add(target);
    const targetParent = assertWithinFixture(
      fixtureRoot,
      path.dirname(target),
      'target parent',
    );
    if (!fs.existsSync(targetParent) || !fs.statSync(targetParent).isDirectory()) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_TARGET_PARENT_INVALID',
        `target parent must already exist: ${targetParent}`,
      );
    }

    const repositoryRoot = assertWithinFixture(
      fixtureRoot,
      item.repository_root,
      'source repository',
    );
    let sourceDigest: SkillSubtreeDigest;
    try {
      sourceDigest = hashSkillSubtreeAtRevision(repositoryRoot, {
        revision: item.locked.source_revision,
        sourcePath: item.locked.path,
      });
    } catch (error) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_UNAVAILABLE',
        `${item.locked.source}@${item.locked.source_revision}:${item.locked.path}`,
        { cause: error },
      );
    }
    const expected: SkillSubtreeDigest = {
      tree_hash: item.locked.tree_hash,
      executable_files: item.locked.executable_files,
    };
    if (!sameDigest(sourceDigest, expected)) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_SOURCE_LOCK_DIVERGENT',
        `${item.id} pinned source digest differs from Lock`,
      );
    }
    const targetState = inspectTarget(item, target);
    plans.push({
      item,
      target,
      action: targetState.action,
      initialDigest: targetState.initialDigest,
      stage: null,
      backup: null,
    });
  }

  const changing = plans.filter((plan) => plan.action !== 'noop');
  if (changing.length === 0) {
    return {
      operation_id: request.operation_id,
      status: 'noop',
      targets: plans.map((plan) => ({
        id: plan.item.id,
        kind: plan.item.kind,
        target: plan.target,
        action: 'noop',
        tree_hash: plan.item.locked.tree_hash,
        executable_files: [...plan.item.locked.executable_files],
      })),
    };
  }

  const activated: PlannedItem[] = [];
  let activationVerified = false;
  try {
    for (const plan of changing) {
      plan.stage = path.join(
        path.dirname(plan.target),
        `.${path.basename(plan.target)}.aspg-stage-${request.operation_id}-${randomUUID()}`,
      );
      materializePinnedTree(plan.item.repository_root, plan.item.locked, plan.stage);
      verifyTarget({ ...plan, target: plan.stage });
    }

    for (const plan of changing) {
      assertTargetUnchanged(plan);
      if (plan.initialDigest) {
        plan.backup = path.join(
          path.dirname(plan.target),
          `.${path.basename(plan.target)}.aspg-backup-${request.operation_id}-${randomUUID()}`,
        );
        fs.renameSync(plan.target, plan.backup);
      }
      activated.push(plan);
      fs.renameSync(plan.stage!, plan.target);
      plan.stage = null;
    }

    for (const plan of plans) verifyTarget(plan);
    activationVerified = true;
    for (const plan of activated) {
      cleanupOwnedPath(plan.backup);
      plan.backup = null;
    }

    return {
      operation_id: request.operation_id,
      status: 'committed',
      targets: plans.map((plan) => ({
        id: plan.item.id,
        kind: plan.item.kind,
        target: plan.target,
        action: plan.action,
        tree_hash: plan.item.locked.tree_hash,
        executable_files: [...plan.item.locked.executable_files],
      })),
    };
  } catch (error) {
    if (activationVerified) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_BACKUP_CLEANUP_FAILED',
        'targets were verified but an operation-owned backup could not be removed',
        { cause: error },
      );
    }
    let rollbackError: unknown;
    for (const plan of [...activated].reverse()) {
      try {
        cleanupOwnedPath(plan.target);
        if (plan.backup && lstatIfPresent(plan.backup)) {
          fs.renameSync(plan.backup, plan.target);
          plan.backup = null;
        }
      } catch (candidate) {
        rollbackError ??= candidate;
      }
    }
    if (rollbackError) {
      throw new ProviderMaterializeError(
        'ASPG_MATERIALIZE_ROLLBACK_FAILED',
        'activation failed and an operation-owned backup could not be restored',
        { cause: rollbackError },
      );
    }
    throw error;
  } finally {
    for (const plan of plans) {
      cleanupOwnedPath(plan.stage);
      // Backups are removed only after successful commit or successful restore.
    }
  }
}
