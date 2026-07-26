/**
 * Fixture-only Wave 6 managed-link state and inspection primitives.
 *
 * This module does not parse Portfolio manifests, mutate runtime targets,
 * materialize content, implement rollback, or expose a CLI. Callers must pass
 * explicit fixture roots and already-resolved identities/digests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashSkillSubtree } from './portfolio-hash.js';
import {
  PORTFOLIO_HEALTH_STATES,
  type DeploymentEntryState,
  type LockedContentIdentity,
  type PortableDeploymentState,
  type PortfolioHealth,
  type ProjectedDataDependency,
} from './portfolio-runtime-types.js';

const revisionPattern = /^[0-9a-f]{40}$/;
const treeHashPattern = /^sha256:[0-9a-f]{64}$/;
const backends = new Set(['managed-link', 'managed-materialized']);
const healthStates = new Set<string>(PORTFOLIO_HEALTH_STATES);

export class DeploymentStateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'DeploymentStateError';
  }
}

export interface WritePortableDeploymentStateOptions {
  projectRoot: string;
  stateRelativePath: string;
  expectedGeneration: number | null;
  state: PortableDeploymentState;
}

export interface PortableDeploymentStateWriteResult {
  path: string;
  state: PortableDeploymentState;
  bytes: string;
}

export interface ManagedLinkTargetInspectionOptions {
  fixtureRoot: string;
  targetPath: string;
  expectedSourcePath: string;
  expected: Pick<LockedContentIdentity, 'tree_hash' | 'executable_files'>;
  required: boolean;
}

export interface ManagedLinkDependencyInspectionOptions {
  fixtureRoot: string;
  projectRoot: string;
  sourceRoot: string;
  dependency: ProjectedDataDependency;
}

export interface ManagedLinkInspection {
  health: PortfolioHealth;
  blocking: boolean;
  target_mutated: false;
  resolved_target: string | null;
  observed_tree_hash: string | null;
  observed_executable_files: string[];
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new DeploymentStateError(code, message, options);
}

function lstatIfPresent(targetPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('ASPG_STATE_INVALID', `${label} must be a non-empty string`);
  }
}

function assertPortablePath(value: unknown, label: string, allowDot = false): asserts value is string {
  assertNonEmptyString(value, label);
  if (
    path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes('\\')
    || value === '~'
    || value.startsWith('~/')
  ) {
    fail('ASPG_STATE_PATH_INVALID', `${label} must be a portable relative path`);
  }
  if (allowDot && value === '.') return;
  const segments = value.split('/');
  if (
    path.posix.normalize(value) !== value
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('ASPG_STATE_PATH_INVALID', `${label} must be normalized and contained`);
  }
}

function assertExecutableFiles(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail('ASPG_STATE_INVALID', `${label} must be a string array`);
  }
  for (const entry of value) assertPortablePath(entry, `${label} entry`);
  if (new Set(value).size !== value.length) {
    fail('ASPG_STATE_INVALID', `${label} must not contain duplicates`);
  }
}

function assertLockedIdentity(identity: LockedContentIdentity, label: string): void {
  assertNonEmptyString(identity.source, `${label}.source`);
  if (!revisionPattern.test(identity.source_revision)) {
    fail('ASPG_STATE_INVALID', `${label}.source_revision is invalid`);
  }
  assertPortablePath(identity.path, `${label}.path`, true);
  if (!treeHashPattern.test(identity.tree_hash)) {
    fail('ASPG_STATE_INVALID', `${label}.tree_hash is invalid`);
  }
  assertExecutableFiles(identity.executable_files, `${label}.executable_files`);
}

function normalizeDependency(
  dependency: ProjectedDataDependency,
  label: string,
): ProjectedDataDependency {
  assertLockedIdentity(dependency, label);
  assertNonEmptyString(dependency.id, `${label}.id`);
  if (dependency.privacy !== 'work-private') {
    fail('ASPG_STATE_INVALID', `${label}.privacy must be work-private`);
  }
  assertPortablePath(dependency.target, `${label}.target`);
  if (typeof dependency.required !== 'boolean') {
    fail('ASPG_STATE_INVALID', `${label}.required must be boolean`);
  }
  return {
    source: dependency.source,
    source_revision: dependency.source_revision,
    path: dependency.path,
    tree_hash: dependency.tree_hash,
    executable_files: [...dependency.executable_files].sort(compareText),
    id: dependency.id,
    privacy: 'work-private',
    target: dependency.target,
    required: dependency.required,
  };
}

function normalizeEntry(entry: DeploymentEntryState, index: number): DeploymentEntryState {
  const label = `entries[${index}]`;
  assertLockedIdentity(entry, label);
  assertNonEmptyString(entry.skill_id, `${label}.skill_id`);
  assertNonEmptyString(entry.exposure_name, `${label}.exposure_name`);
  assertPortablePath(entry.target, `${label}.target`);
  if (!backends.has(entry.backend)) {
    fail('ASPG_STATE_INVALID', `${label}.backend is invalid`);
  }
  if (!healthStates.has(entry.health)) {
    fail('ASPG_STATE_INVALID', `${label}.health is invalid`);
  }
  if (!Array.isArray(entry.dependencies)) {
    fail('ASPG_STATE_INVALID', `${label}.dependencies must be an array`);
  }
  const dependencies = entry.dependencies
    .map((dependency, dependencyIndex) =>
      normalizeDependency(dependency, `${label}.dependencies[${dependencyIndex}]`))
    .sort((left, right) => compareText(left.id, right.id));
  if (new Set(dependencies.map((dependency) => dependency.id)).size !== dependencies.length) {
    fail('ASPG_STATE_INVALID', `${label}.dependencies must have unique IDs`);
  }
  return {
    source: entry.source,
    source_revision: entry.source_revision,
    path: entry.path,
    tree_hash: entry.tree_hash,
    executable_files: [...entry.executable_files].sort(compareText),
    skill_id: entry.skill_id,
    exposure_name: entry.exposure_name,
    target: entry.target,
    backend: entry.backend,
    health: entry.health,
    dependencies,
  };
}

export function normalizePortableDeploymentState(
  state: PortableDeploymentState,
): PortableDeploymentState {
  if (!state || typeof state !== 'object' || state.version !== 1) {
    fail('ASPG_STATE_INVALID', 'portable deployment state version must be 1');
  }
  for (const field of ['portfolio', 'deployment', 'project_ref', 'lock_revision'] as const) {
    assertNonEmptyString(state[field], field);
  }
  if (!revisionPattern.test(state.lock_revision)) {
    fail('ASPG_STATE_INVALID', 'lock_revision is invalid');
  }
  if (!Number.isSafeInteger(state.generation) || state.generation < 1) {
    fail('ASPG_STATE_INVALID', 'generation must be a positive safe integer');
  }
  assertNonEmptyString(state.updated_at, 'updated_at');
  if (Number.isNaN(Date.parse(state.updated_at))) {
    fail('ASPG_STATE_INVALID', 'updated_at must be an ISO-compatible timestamp');
  }
  if (!Array.isArray(state.entries)) {
    fail('ASPG_STATE_INVALID', 'entries must be an array');
  }
  const entries = state.entries
    .map(normalizeEntry)
    .sort((left, right) => compareText(left.skill_id, right.skill_id));
  for (const key of ['skill_id', 'exposure_name', 'target'] as const) {
    if (new Set(entries.map((entry) => entry[key])).size !== entries.length) {
      fail('ASPG_STATE_INVALID', `entries must have unique ${key} values`);
    }
  }
  return {
    version: 1,
    portfolio: state.portfolio,
    deployment: state.deployment,
    project_ref: state.project_ref,
    lock_revision: state.lock_revision,
    generation: state.generation,
    entries,
    updated_at: state.updated_at,
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function serializePortableDeploymentState(
  state: PortableDeploymentState,
): string {
  return `${JSON.stringify(sortJson(normalizePortableDeploymentState(state)), null, 2)}\n`;
}

function assertFixtureDirectory(directory: string, label: string): string {
  if (!path.isAbsolute(directory)) {
    fail('ASPG_FIXTURE_ROOT_REQUIRED', `${label} must be an explicit absolute path`);
  }
  let realDirectory: string;
  try {
    realDirectory = fs.realpathSync(directory);
  } catch (error) {
    fail('ASPG_FIXTURE_ROOT_REQUIRED', `${label} is unavailable`, { cause: error });
  }
  if (!fs.statSync(realDirectory).isDirectory()) {
    fail('ASPG_FIXTURE_ROOT_REQUIRED', `${label} is not a directory`);
  }
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (realDirectory === temporaryRoot || !isWithin(temporaryRoot, realDirectory)) {
    fail(
      'ASPG_REAL_PROJECT_FORBIDDEN',
      `${label} must be an isolated child of the operating-system temporary directory`,
    );
  }
  return realDirectory;
}

function assertContainedParent(
  ownerRoot: string,
  candidate: string,
  label: string,
): void {
  if (!path.isAbsolute(candidate) || !isWithin(ownerRoot, path.resolve(candidate))) {
    fail('ASPG_STATE_PATH_ESCAPE', `${label} escapes its owner root`);
  }
  let current = path.dirname(path.resolve(candidate));
  while (!lstatIfPresent(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      fail('ASPG_STATE_PATH_ESCAPE', `${label} has no contained existing ancestor`);
    }
    current = parent;
  }
  let realParent: string;
  try {
    realParent = fs.realpathSync(current);
  } catch (error) {
    fail('ASPG_STATE_PATH_ESCAPE', `${label} parent is unavailable`, { cause: error });
  }
  if (!isWithin(ownerRoot, realParent)) {
    fail('ASPG_STATE_PATH_ESCAPE', `${label} parent resolves outside its owner root`);
  }
}

function prepareStatePath(
  projectRoot: string,
  stateRelativePath: string,
): { projectRoot: string; statePath: string } {
  const projectRealpath = assertFixtureDirectory(projectRoot, 'projectRoot');
  assertPortablePath(stateRelativePath, 'stateRelativePath');
  if (!stateRelativePath.startsWith('.aspg/')) {
    fail('ASPG_STATE_PATH_INVALID', 'stateRelativePath must live below project .aspg');
  }
  const statePath = path.resolve(projectRealpath, ...stateRelativePath.split('/'));
  if (!isWithin(path.join(projectRealpath, '.aspg'), statePath)) {
    fail('ASPG_STATE_PATH_ESCAPE', 'state path escapes project .aspg');
  }

  const relativeParent = path.dirname(stateRelativePath).split('/');
  let current = projectRealpath;
  for (const segment of relativeParent) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat?.isSymbolicLink()) {
      fail('ASPG_STATE_PATH_ESCAPE', `state parent is a symlink: ${current}`);
    }
    if (stat && !stat.isDirectory()) {
      fail('ASPG_STATE_PATH_INVALID', `state parent is not a directory: ${current}`);
    }
    if (!stat) fs.mkdirSync(current);
    const realCurrent = fs.realpathSync(current);
    if (!isWithin(projectRealpath, realCurrent)) {
      fail('ASPG_STATE_PATH_ESCAPE', `state parent resolves outside project: ${current}`);
    }
  }
  return { projectRoot: projectRealpath, statePath };
}

function readManagedState(
  statePath: string,
): { state: PortableDeploymentState; bytes: string } | null {
  const stat = lstatIfPresent(statePath);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ASPG_STATE_UNMANAGED_TARGET', 'refusing to replace a non-regular state target');
  }
  const bytes = fs.readFileSync(statePath, 'utf8');
  let parsed: PortableDeploymentState;
  try {
    parsed = normalizePortableDeploymentState(
      JSON.parse(bytes) as PortableDeploymentState,
    );
  } catch (error) {
    if (error instanceof DeploymentStateError) throw error;
    fail('ASPG_STATE_UNMANAGED_TARGET', 'existing state is not valid JSON', { cause: error });
  }
  if (serializePortableDeploymentState(parsed) !== bytes) {
    fail('ASPG_STATE_UNMANAGED_TARGET', 'existing state is not canonical ASPG state');
  }
  return { state: parsed, bytes };
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Atomically create or advance one portable deployment state generation.
 *
 * The caller must provide both the fixture project root and the project-relative
 * state path. Existing invalid files, links and directories are never replaced.
 */
export function writePortableDeploymentState(
  options: WritePortableDeploymentStateOptions,
): PortableDeploymentStateWriteResult {
  const location = prepareStatePath(options.projectRoot, options.stateRelativePath);
  const nextState = normalizePortableDeploymentState(options.state);
  const nextBytes = serializePortableDeploymentState(nextState);
  const existing = readManagedState(location.statePath);

  if (!existing) {
    if (options.expectedGeneration !== null || nextState.generation !== 1) {
      fail(
        'ASPG_STATE_GENERATION_CONFLICT',
        'new state requires expectedGeneration null and generation 1',
      );
    }
  } else if (
    options.expectedGeneration !== existing.state.generation
    || nextState.generation !== existing.state.generation + 1
  ) {
    fail(
      'ASPG_STATE_GENERATION_CONFLICT',
      `expected generation ${existing.state.generation} followed by ${
        existing.state.generation + 1
      }`,
    );
  }

  const temporaryPath = path.join(
    path.dirname(location.statePath),
    `.${path.basename(location.statePath)}.aspg-state-${process.pid}-${randomUUID()}`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, nextBytes, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const current = readManagedState(location.statePath);
    if (
      (!existing && current)
      || (existing && (!current || current.bytes !== existing.bytes))
    ) {
      fail('ASPG_STATE_GENERATION_CONFLICT', 'state changed during atomic write');
    }
    fs.renameSync(temporaryPath, location.statePath);
    fsyncDirectory(path.dirname(location.statePath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    const temporary = lstatIfPresent(temporaryPath);
    if (temporary?.isFile()) fs.unlinkSync(temporaryPath);
  }
  return {
    path: location.statePath,
    state: nextState,
    bytes: nextBytes,
  };
}

function inspection(
  health: PortfolioHealth,
  required: boolean,
  resolvedTarget: string | null = null,
  observedTreeHash: string | null = null,
  observedExecutableFiles: string[] = [],
): ManagedLinkInspection {
  return {
    health,
    blocking: required && health !== 'in-sync',
    target_mutated: false,
    resolved_target: resolvedTarget,
    observed_tree_hash: observedTreeHash,
    observed_executable_files: [...observedExecutableFiles],
  };
}

function assertInspectionPath(
  fixtureRoot: string,
  candidate: string,
  label: string,
): string {
  if (!path.isAbsolute(candidate)) {
    fail('ASPG_LINK_INSPECTION_PATH_INVALID', `${label} must be absolute`);
  }
  const absolute = path.resolve(candidate);
  if (!isWithin(fixtureRoot, absolute)) {
    fail('ASPG_LINK_INSPECTION_PATH_ESCAPE', `${label} escapes fixtureRoot`);
  }
  assertContainedParent(fixtureRoot, absolute, label);
  return absolute;
}

function sameExecutables(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

/**
 * Inspect one managed-link target without mutating it.
 *
 * A link is owned only when it resolves to the caller-supplied source path.
 * No platform sidecar is consulted or created; ownership is persisted solely
 * by the portable deployment state managed above.
 */
export function inspectManagedLinkTarget(
  options: ManagedLinkTargetInspectionOptions,
): ManagedLinkInspection {
  const fixtureRoot = assertFixtureDirectory(options.fixtureRoot, 'fixtureRoot');
  const targetPath = assertInspectionPath(fixtureRoot, options.targetPath, 'targetPath');
  const expectedSourcePath = assertInspectionPath(
    fixtureRoot,
    options.expectedSourcePath,
    'expectedSourcePath',
  );
  if (!treeHashPattern.test(options.expected.tree_hash)) {
    fail('ASPG_LINK_EXPECTATION_INVALID', 'expected tree_hash is invalid');
  }
  assertExecutableFiles(
    options.expected.executable_files,
    'expected executable_files',
  );
  const expectedExecutables = [...options.expected.executable_files].sort(compareText);
  if (!sameExecutables(options.expected.executable_files, expectedExecutables)) {
    fail('ASPG_LINK_EXPECTATION_INVALID', 'expected executable_files must be sorted');
  }

  const sourceStat = lstatIfPresent(expectedSourcePath);
  if (!sourceStat) return inspection('source-unavailable', options.required);
  let sourceRealpath: string;
  try {
    sourceRealpath = fs.realpathSync(expectedSourcePath);
  } catch {
    return inspection('source-unavailable', options.required);
  }
  if (
    !isWithin(fixtureRoot, sourceRealpath)
    || !fs.statSync(sourceRealpath).isDirectory()
  ) {
    return inspection('source-unavailable', options.required);
  }

  const targetStat = lstatIfPresent(targetPath);
  if (!targetStat) return inspection('missing', options.required);
  if (!targetStat.isSymbolicLink()) {
    return inspection(
      targetStat.isDirectory() ? 'unmanaged-copy' : 'unmanaged-content',
      options.required,
    );
  }

  let targetRealpath: string;
  try {
    targetRealpath = fs.realpathSync(targetPath);
  } catch {
    return inspection('unmanaged-content', options.required);
  }
  if (targetRealpath !== sourceRealpath) {
    return inspection('unmanaged-content', options.required, targetRealpath);
  }

  let observed;
  try {
    observed = hashSkillSubtree(targetRealpath);
  } catch {
    return inspection('source-unavailable', options.required, targetRealpath);
  }
  if (!sameExecutables(observed.executable_files, expectedExecutables)) {
    return inspection(
      'mode-drift',
      options.required,
      targetRealpath,
      observed.tree_hash,
      observed.executable_files,
    );
  }
  if (observed.tree_hash !== options.expected.tree_hash) {
    return inspection(
      'local-drift',
      options.required,
      targetRealpath,
      observed.tree_hash,
      observed.executable_files,
    );
  }
  return inspection(
    'in-sync',
    options.required,
    targetRealpath,
    observed.tree_hash,
    observed.executable_files,
  );
}

/**
 * Resolve and inspect one caller-projected managed-link dependency.
 *
 * Manifest/Lock parsing and backend selection remain integration-owned.
 */
export function inspectManagedLinkDependency(
  options: ManagedLinkDependencyInspectionOptions,
): ManagedLinkInspection {
  const fixtureRoot = assertFixtureDirectory(options.fixtureRoot, 'fixtureRoot');
  const projectRoot = assertFixtureDirectory(options.projectRoot, 'projectRoot');
  const sourceRoot = assertFixtureDirectory(options.sourceRoot, 'sourceRoot');
  if (!isWithin(fixtureRoot, projectRoot) || !isWithin(fixtureRoot, sourceRoot)) {
    fail(
      'ASPG_LINK_INSPECTION_PATH_ESCAPE',
      'projectRoot and sourceRoot must be contained by fixtureRoot',
    );
  }
  const dependency = normalizeDependency(options.dependency, 'dependency');
  const targetPath = path.resolve(projectRoot, ...dependency.target.split('/'));
  const expectedSourcePath = dependency.path === '.'
    ? sourceRoot
    : path.resolve(sourceRoot, ...dependency.path.split('/'));
  return inspectManagedLinkTarget({
    fixtureRoot,
    targetPath,
    expectedSourcePath,
    expected: dependency,
    required: dependency.required,
  });
}
