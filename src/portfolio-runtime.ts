/**
 * Fixture-only Wave 6 Portfolio transaction executor.
 *
 * Manifest, Lock and Device Registry parsing deliberately live above this
 * module. Every path, provider, backend, generation and locked identity is
 * supplied explicitly by the caller. Mutations are refused unless the complete
 * deployment is contained by one isolated child of the operating-system
 * temporary directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireActivationLock,
  activationRecoveryAction,
  advanceActivationPhase,
  captureActivationSnapshot,
  commitActivation,
  createActivationOperation,
  loadActivationOperation,
  readActivationJournal,
  recordActivationBlockingFailure,
  resumeActivationLock,
  rollbackActivation,
  type ActivationOperation,
} from './activation-journal.js';
import {
  inspectManagedLinkTarget,
  normalizePortableDeploymentState,
  serializePortableDeploymentState,
  writePortableDeploymentState,
} from './deployment-state.js';
import {
  hashSkillSubtree,
  hashSkillSubtreeAtRevision,
  type SkillSubtreeDigest,
} from './portfolio-hash.js';
import {
  materializeManagedContent,
  type ManagedMaterializationItem,
} from './provider-materialize.js';
import {
  preflightProvider,
  type GoogleDriveProviderObservation,
} from './provider-preflight.js';
import type {
  ActivationJournalEntry,
  DeploymentEntryState,
  LockedContentIdentity,
  PortableDeploymentState,
  PortfolioDeploymentBackend,
  PortfolioHealth,
  ProjectedDataDependency,
  ProviderPreflight,
} from './portfolio-runtime-types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_SKILL_ID =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const REVISION = /^[0-9a-f]{40}$/;
const TREE_HASH = /^sha256:[0-9a-f]{64}$/;

export class PortfolioRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'PortfolioRuntimeError';
  }
}

export interface ResolvedRuntimeDependency extends ProjectedDataDependency {
  repository_root: string;
}

export interface ResolvedRuntimeEntry extends LockedContentIdentity {
  skill_id: string;
  exposure_name: string;
  repository_root: string;
  /**
   * Portable path relative to project_root. It must resolve below runtime_root.
   */
  target: string;
  dependencies: ResolvedRuntimeDependency[];
}

export interface ResolvedPortfolioRuntimeDeployment {
  fixture_root: string;
  project_root: string;
  runtime_root: string;
  state_root: string;
  storage_provider: ProviderPreflight['provider'];
  deployment_backend: PortfolioDeploymentBackend;
  google_drive?: GoogleDriveProviderObservation;
  portfolio: string;
  deployment: string;
  project_ref: string;
  device_id: string;
  lock_revision: string;
  current_generation: number;
  next_generation: number;
  entries: ResolvedRuntimeEntry[];
  generated_files?: Array<{
    target: string;
    bytes: string;
  }>;
}

export interface ExecutePortfolioRuntimeRequest
  extends ResolvedPortfolioRuntimeDeployment {
  mutation: 'apply' | 'refresh';
  operation_id: string;
  now?: () => string;
}

export interface PortfolioRuntimeTargetInspection {
  id: string;
  kind: 'skill' | 'dependency' | 'generated';
  target: string;
  required: boolean;
  health: PortfolioHealth;
  blocking: boolean;
}

export interface PortfolioRuntimeInspection {
  deployment: string;
  backend: PortfolioDeploymentBackend;
  provider: ProviderPreflight;
  state_path: string;
  state_generation: number | null;
  health: PortfolioHealth;
  blocking: boolean;
  targets: PortfolioRuntimeTargetInspection[];
}

export interface PortfolioRuntimeExecutionResult {
  operation_id: string;
  phase: 'committed';
  generation: number;
  backend: PortfolioDeploymentBackend;
  state_path: string;
  targets: Array<{
    id: string;
    kind: 'skill' | 'dependency';
    target: string;
    action: 'noop' | 'created' | 'refreshed';
  }>;
}

export interface PortfolioRuntimeRecoveryRequest {
  fixture_root: string;
  state_root: string;
  operation_id: string;
  now?: () => string;
}

interface RuntimeItem {
  id: string;
  kind: 'skill' | 'dependency';
  required: boolean;
  repositoryRoot: string;
  targetRelative: string;
  targetAbsolute: string;
  sourceAbsolute: string;
  locked: LockedContentIdentity;
  parentEntry: ResolvedRuntimeEntry;
}

interface ValidatedDeployment {
  fixtureRoot: string;
  projectRoot: string;
  runtimeRoot: string;
  stateRoot: string;
  stateRelativePath: string;
  statePath: string;
  deploymentDirectoryRelative: string;
  items: RuntimeItem[];
  currentState: PortableDeploymentState | null;
  provider: ProviderPreflight;
  generatedFiles: Array<{
    targetRelative: string;
    targetAbsolute: string;
    bytes: string;
  }>;
  generatedHealth: PortfolioHealth;
  transitionIncomplete: boolean;
}

interface LinkPlan {
  item: RuntimeItem;
  action: 'noop' | 'created' | 'refreshed';
  stage: string | null;
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new PortfolioRuntimeError(code, message, options);
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
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('ASPG_RUNTIME_PATH_UNRESOLVED', candidate);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function assertFixtureRoot(candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    fail('ASPG_RUNTIME_FIXTURE_REQUIRED', 'fixture_root must be explicit and absolute');
  }
  let fixtureRoot: string;
  try {
    fixtureRoot = fs.realpathSync(candidate);
  } catch (error) {
    fail('ASPG_RUNTIME_FIXTURE_REQUIRED', 'fixture_root is unavailable', { cause: error });
  }
  if (!fs.statSync(fixtureRoot).isDirectory()) {
    fail('ASPG_RUNTIME_FIXTURE_REQUIRED', 'fixture_root is not a directory');
  }
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (fixtureRoot === temporaryRoot || !isWithin(temporaryRoot, fixtureRoot)) {
    fail(
      'ASPG_RUNTIME_REAL_PROJECT_REFUSED',
      'fixture_root must be an isolated child of the operating-system temporary directory',
    );
  }
  return fixtureRoot;
}

function assertContained(
  fixtureRoot: string,
  candidate: string,
  label: string,
  mustExist = true,
): string {
  if (!path.isAbsolute(candidate)) {
    fail('ASPG_RUNTIME_PATH_INVALID', `${label} must be explicit and absolute`);
  }
  const resolved = resolveWithExistingAncestor(candidate);
  if (!isWithin(fixtureRoot, resolved) || resolved === fixtureRoot) {
    fail('ASPG_RUNTIME_REAL_PROJECT_REFUSED', `${label} escapes fixture_root`);
  }
  if (mustExist) {
    const stat = lstatIfPresent(resolved);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      fail('ASPG_RUNTIME_PATH_INVALID', `${label} must be an existing directory`);
    }
  }
  return resolved;
}

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER.test(value) || value === '.' || value === '..') {
    fail('ASPG_RUNTIME_ID_INVALID', `${label} must be a portable identifier`);
  }
}

function assertCanonicalSkillId(value: string): void {
  if (!CANONICAL_SKILL_ID.test(value)) {
    fail(
      'ASPG_RUNTIME_ID_INVALID',
      'skill_id must use canonical namespace/name syntax',
    );
  }
}

function assertPortablePath(value: string, label: string, allowDot = false): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    fail('ASPG_RUNTIME_PATH_INVALID', `${label} must be a portable relative path`);
  }
  if (allowDot && value === '.') return;
  if (
    path.posix.normalize(value) !== value
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail('ASPG_RUNTIME_PATH_INVALID', `${label} must be normalized and contained`);
  }
}

function assertLocked(locked: LockedContentIdentity, label: string): void {
  if (!locked.source || !REVISION.test(locked.source_revision)) {
    fail('ASPG_RUNTIME_LOCK_INVALID', `${label} has an invalid source identity`);
  }
  assertPortablePath(locked.path, `${label}.path`, true);
  if (!TREE_HASH.test(locked.tree_hash)) {
    fail('ASPG_RUNTIME_LOCK_INVALID', `${label}.tree_hash is invalid`);
  }
  if (
    !Array.isArray(locked.executable_files)
    || new Set(locked.executable_files).size !== locked.executable_files.length
  ) {
    fail('ASPG_RUNTIME_LOCK_INVALID', `${label}.executable_files is invalid`);
  }
  for (const executable of locked.executable_files) {
    assertPortablePath(executable, `${label}.executable_files[]`);
  }
}

function sameDigest(
  observed: SkillSubtreeDigest,
  expected: Pick<LockedContentIdentity, 'tree_hash' | 'executable_files'>,
): boolean {
  const left = [...observed.executable_files].sort();
  const right = [...expected.executable_files].sort();
  return observed.tree_hash === expected.tree_hash
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function absoluteFromPortable(root: string, relative: string): string {
  return path.resolve(root, ...relative.split('/'));
}

function portableFromAbsolute(root: string, candidate: string, label: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  assertPortablePath(relative, label);
  return relative;
}

function sourcePath(repositoryRoot: string, locked: LockedContentIdentity): string {
  return locked.path === '.'
    ? repositoryRoot
    : absoluteFromPortable(repositoryRoot, locked.path);
}

function deploymentStateRelativePath(deployment: string): string {
  return `.aspg/deployments/${deployment}/state.yaml`;
}

function providerHealth(provider: ProviderPreflight): PortfolioHealth {
  if (provider.status === 'offline') return 'provider-offline';
  if (provider.status === 'uncertain') return 'provider-uncertain';
  return 'provider-conflict';
}

function runtimeProvider(
  input: ResolvedPortfolioRuntimeDeployment,
  fixtureRoot: string,
  runtimeRoot: string,
): ProviderPreflight {
  if (input.deployment_backend === 'managed-materialized') {
    return preflightProvider({
      fixture_root: fixtureRoot,
      runtime_root: runtimeRoot,
      storage_provider: input.storage_provider,
      deployment_backend: input.deployment_backend,
      google_drive: input.google_drive,
    });
  }
  if (input.storage_provider !== 'local-filesystem') {
    return {
      provider: input.storage_provider,
      runtime_root: runtimeRoot,
      status: 'conflict',
      hydrated: false,
      writable: false,
      reason: 'managed-link requires an explicit local-filesystem provider',
    };
  }
  let writable = false;
  try {
    fs.accessSync(runtimeRoot, fs.constants.W_OK);
    writable = true;
  } catch {
    // Represented in the returned preflight.
  }
  return {
    provider: input.storage_provider,
    runtime_root: runtimeRoot,
    status: writable ? 'ready' : 'conflict',
    hydrated: true,
    writable,
    reason: writable ? null : 'managed-link runtime root is not writable',
  };
}

function readCurrentState(
  input: ResolvedPortfolioRuntimeDeployment,
  statePath: string,
): PortableDeploymentState | null {
  const stat = lstatIfPresent(statePath);
  if (!stat) {
    if (input.current_generation !== 0) {
      fail('ASPG_RUNTIME_STATE_MISSING', 'current generation requires portable state');
    }
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('ASPG_RUNTIME_STATE_UNMANAGED', 'portable state is not a regular file');
  }
  const bytes = fs.readFileSync(statePath, 'utf8');
  let parsed: PortableDeploymentState;
  try {
    parsed = normalizePortableDeploymentState(
      JSON.parse(bytes) as PortableDeploymentState,
    );
  } catch (error) {
    fail('ASPG_RUNTIME_STATE_UNMANAGED', 'portable state is invalid', { cause: error });
  }
  if (serializePortableDeploymentState(parsed) !== bytes) {
    fail('ASPG_RUNTIME_STATE_UNMANAGED', 'portable state is not canonical');
  }
  if (
    parsed.portfolio !== input.portfolio
    || parsed.deployment !== input.deployment
    || parsed.project_ref !== input.project_ref
    || parsed.generation !== input.current_generation
  ) {
    fail('ASPG_RUNTIME_STATE_CONFLICT', 'portable state identity or generation differs');
  }
  return parsed;
}

function flattenItems(
  input: ResolvedPortfolioRuntimeDeployment,
  fixtureRoot: string,
  projectRoot: string,
  runtimeRoot: string,
): RuntimeItem[] {
  if (input.entries.length === 0) {
    fail('ASPG_RUNTIME_EMPTY_DEPLOYMENT', 'deployment must contain at least one Skill');
  }
  const items: RuntimeItem[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();

  const add = (
    parentEntry: ResolvedRuntimeEntry,
    value: LockedContentIdentity & {
      repository_root: string;
      target: string;
      required: boolean;
    },
    id: string,
    kind: RuntimeItem['kind'],
  ): void => {
    if (ids.has(id)) fail('ASPG_RUNTIME_DUPLICATE_ITEM', `duplicate item ID: ${id}`);
    ids.add(id);
    assertPortablePath(value.target, `${id}.target`);
    assertLocked(value, id);
    const targetAbsolute = absoluteFromPortable(projectRoot, value.target);
    if (kind === 'skill') {
      if (!isWithin(runtimeRoot, targetAbsolute) || targetAbsolute === runtimeRoot) {
        fail('ASPG_RUNTIME_TARGET_INVALID', `${id} target is outside runtime_root`);
      }
    } else if (
      !value.target.startsWith('.aspg/dependencies/')
      || !isWithin(projectRoot, targetAbsolute)
      || targetAbsolute === projectRoot
    ) {
      fail(
        'ASPG_RUNTIME_TARGET_INVALID',
        `${id} dependency target must be below .aspg/dependencies`,
      );
    }
    if (targets.has(targetAbsolute)) {
      fail('ASPG_RUNTIME_DUPLICATE_TARGET', `duplicate target: ${value.target}`);
    }
    targets.add(targetAbsolute);
    const repositoryRoot = assertContained(
      fixtureRoot,
      value.repository_root,
      `${id}.repository_root`,
    );
    const sourceAbsolute = sourcePath(repositoryRoot, value);
    if (!isWithin(repositoryRoot, sourceAbsolute)) {
      fail('ASPG_RUNTIME_SOURCE_INVALID', `${id} source escapes repository`);
    }
    items.push({
      id,
      kind,
      required: value.required,
      repositoryRoot,
      targetRelative: value.target,
      targetAbsolute,
      sourceAbsolute,
      locked: value,
      parentEntry,
    });
  };

  for (const entry of input.entries) {
    assertCanonicalSkillId(entry.skill_id);
    assertIdentifier(entry.exposure_name, 'exposure_name');
    add(entry, { ...entry, required: true }, entry.skill_id, 'skill');
    for (const dependency of entry.dependencies) {
      assertIdentifier(dependency.id, 'dependency.id');
      if (dependency.privacy !== 'work-private') {
        fail('ASPG_RUNTIME_DEPENDENCY_INVALID', `${dependency.id} must be work-private`);
      }
      add(entry, dependency, dependency.id, 'dependency');
    }
  }
  return items;
}

function privatePackId(dependencyId: string): string {
  return dependencyId === 'cstc-eu-rspo-employer-pack'
    ? 'work-private/cstc-eu-rspo-default-deck'
    : `work-private/${dependencyId}`;
}

function privatePackConfigBytes(
  entries: PortableDeploymentState['entries'],
): string | null {
  const packs = entries
    .flatMap((entry) => entry.dependencies)
    .filter((dependency) => dependency.required)
    .map((dependency) => ({
      pack_id: privatePackId(dependency.id),
      root: dependency.target,
    }))
    .sort((left, right) => (
      left.pack_id < right.pack_id
        ? -1
        : left.pack_id > right.pack_id
          ? 1
          : left.root < right.root
            ? -1
            : left.root > right.root
              ? 1
              : 0
    ));
  if (packs.length === 0) return null;
  return `${JSON.stringify({ schema_version: 1, packs }, null, 2)}\n`;
}

function nextStateShape(input: ResolvedPortfolioRuntimeDeployment): PortableDeploymentState {
  return normalizePortableDeploymentState({
    version: 1,
    portfolio: input.portfolio,
    deployment: input.deployment,
    project_ref: input.project_ref,
    lock_revision: input.lock_revision,
    generation: input.next_generation,
    entries: input.entries.map((entry) => ({
      source: entry.source,
      source_revision: entry.source_revision,
      path: entry.path,
      tree_hash: entry.tree_hash,
      executable_files: [...entry.executable_files],
      skill_id: entry.skill_id,
      exposure_name: entry.exposure_name,
      target: entry.target,
      backend: input.deployment_backend,
      health: 'in-sync',
      dependencies: entry.dependencies.map((dependency) => ({
        source: dependency.source,
        source_revision: dependency.source_revision,
        path: dependency.path,
        tree_hash: dependency.tree_hash,
        executable_files: [...dependency.executable_files],
        id: dependency.id,
        privacy: dependency.privacy,
        target: dependency.target,
        required: dependency.required,
      })),
    })),
    updated_at: '1970-01-01T00:00:00.000Z',
  });
}

function transitionIncomplete(
  stateRoot: string,
  portfolio: string,
  deployment: string,
  portableGeneration: number,
): boolean {
  const stem = `${portfolio}-${deployment}`;
  const lockPath = path.join(stateRoot, 'locks', `${stem}.lock`);
  if (lstatIfPresent(lockPath)) return true;
  const generationPath = path.join(stateRoot, 'generations', `${stem}.json`);
  const generationStat = lstatIfPresent(generationPath);
  if (!generationStat) return portableGeneration > 0;
  if (generationStat.isSymbolicLink() || !generationStat.isFile()) return true;
  try {
    const parsed = JSON.parse(fs.readFileSync(generationPath, 'utf8')) as {
      portfolio?: unknown;
      deployment?: unknown;
      generation?: unknown;
      operation_id?: unknown;
    };
    return parsed.portfolio !== portfolio
      || parsed.deployment !== deployment
      || parsed.generation !== portableGeneration
      || (parsed.operation_id !== null && parsed.operation_id !== undefined);
  } catch {
    return true;
  }
}

function validateDeployment(
  input: ResolvedPortfolioRuntimeDeployment,
): ValidatedDeployment {
  const fixtureRoot = assertFixtureRoot(input.fixture_root);
  const projectRoot = assertContained(fixtureRoot, input.project_root, 'project_root');
  const runtimeRoot = assertContained(fixtureRoot, input.runtime_root, 'runtime_root');
  const stateRoot = assertContained(fixtureRoot, input.state_root, 'state_root', false);
  if (!isWithin(projectRoot, runtimeRoot) || runtimeRoot === projectRoot) {
    fail(
      'ASPG_RUNTIME_LAYOUT_INVALID',
      'runtime_root must be a proper child of project_root for transactional snapshots',
    );
  }
  if (isWithin(projectRoot, stateRoot) || isWithin(stateRoot, projectRoot)) {
    fail(
      'ASPG_RUNTIME_LAYOUT_INVALID',
      'device-local state_root must be separate from project_root',
    );
  }
  for (const [value, label] of [
    [input.portfolio, 'portfolio'],
    [input.deployment, 'deployment'],
    [input.project_ref, 'project_ref'],
    [input.device_id, 'device_id'],
  ] as const) {
    assertIdentifier(value, label);
  }
  if (!REVISION.test(input.lock_revision)) {
    fail('ASPG_RUNTIME_LOCK_INVALID', 'lock_revision must be a full Git revision');
  }
  if (
    !Number.isSafeInteger(input.current_generation)
    || input.current_generation < 0
    || input.next_generation !== input.current_generation + 1
  ) {
    fail(
      'ASPG_RUNTIME_GENERATION_INVALID',
      'next_generation must immediately follow current_generation',
    );
  }
  const stateRelativePath = deploymentStateRelativePath(input.deployment);
  const statePath = absoluteFromPortable(projectRoot, stateRelativePath);
  const currentState = readCurrentState(input, statePath);
  const items = flattenItems(input, fixtureRoot, projectRoot, runtimeRoot);
  if (currentState) {
    const desiredTargets = new Set(items.map((item) => item.targetRelative));
    const removedTargets = currentState.entries.flatMap((entry) => [
      entry.target,
      ...entry.dependencies.map((dependency) => dependency.target),
    ]).filter((target) => !desiredTargets.has(target));
    if (removedTargets.length > 0) {
      fail(
        'ASPG_RUNTIME_REMOVAL_REQUIRED',
        `transactional removal is required for: ${removedTargets.sort().join(', ')}`,
      );
    }
  }
  const generatedFiles = (input.generated_files ?? []).map((generated, index) => {
    assertPortablePath(generated.target, `generated_files[${index}].target`);
    if (!generated.target.startsWith('.aspg/generated/')) {
      fail(
        'ASPG_RUNTIME_GENERATED_PATH_INVALID',
        'generated files must live below .aspg/generated',
      );
    }
    if (typeof generated.bytes !== 'string' || generated.bytes.length === 0) {
      fail(
        'ASPG_RUNTIME_GENERATED_CONTENT_INVALID',
        'generated file content must be non-empty',
      );
    }
    const targetAbsolute = absoluteFromPortable(projectRoot, generated.target);
    if (!isWithin(projectRoot, targetAbsolute)) {
      fail('ASPG_RUNTIME_GENERATED_PATH_INVALID', 'generated file escapes project root');
    }
    return {
      targetRelative: generated.target,
      targetAbsolute,
      bytes: generated.bytes,
    };
  });
  if (
    new Set(generatedFiles.map((generated) => generated.targetRelative)).size
    !== generatedFiles.length
  ) {
    fail('ASPG_RUNTIME_GENERATED_PATH_INVALID', 'generated file targets must be unique');
  }
  const nextExpectedConfig = privatePackConfigBytes(nextStateShape(input).entries);
  if (nextExpectedConfig === null && generatedFiles.length > 0) {
    fail(
      'ASPG_RUNTIME_GENERATED_CONTENT_INVALID',
      'generated private pack config is forbidden without required dependencies',
    );
  }
  if (
    nextExpectedConfig !== null
    && (
      generatedFiles.length !== 1
      || generatedFiles[0].targetRelative
        !== '.aspg/generated/private-skill-packs.json'
      || generatedFiles[0].bytes !== nextExpectedConfig
    )
  ) {
    fail(
      'ASPG_RUNTIME_GENERATED_CONTENT_INVALID',
      'generated private pack config differs from resolved dependencies',
    );
  }
  const previousExpectedConfig = currentState
    ? privatePackConfigBytes(currentState.entries)
    : null;
  const configPath = path.join(
    projectRoot,
    '.aspg',
    'generated',
    'private-skill-packs.json',
  );
  const configStat = lstatIfPresent(configPath);
  let generatedHealth: PortfolioHealth = 'in-sync';
  if (previousExpectedConfig === null) {
    if (configStat) generatedHealth = 'unmanaged-content';
  } else if (!configStat) {
    generatedHealth = 'missing';
  } else if (configStat.isSymbolicLink() || !configStat.isFile()) {
    generatedHealth = 'unmanaged-content';
  } else if (fs.readFileSync(configPath, 'utf8') !== previousExpectedConfig) {
    generatedHealth = 'local-drift';
  }
  const provider = runtimeProvider(input, fixtureRoot, runtimeRoot);
  return {
    fixtureRoot,
    projectRoot,
    runtimeRoot,
    stateRoot,
    stateRelativePath,
    statePath,
    deploymentDirectoryRelative: path.posix.dirname(stateRelativePath),
    items,
    currentState,
    provider,
    generatedFiles,
    generatedHealth,
    transitionIncomplete: transitionIncomplete(
      stateRoot,
      input.portfolio,
      input.deployment,
      input.current_generation,
    ),
  };
}

function stateTargets(state: PortableDeploymentState | null): Map<string, {
  backend: PortfolioDeploymentBackend;
  locked: LockedContentIdentity;
}> {
  const result = new Map<string, {
    backend: PortfolioDeploymentBackend;
    locked: LockedContentIdentity;
  }>();
  if (!state) return result;
  for (const entry of state.entries) {
    result.set(entry.target, { backend: entry.backend, locked: entry });
    for (const dependency of entry.dependencies) {
      result.set(dependency.target, { backend: entry.backend, locked: dependency });
    }
  }
  return result;
}

function verifyPinnedSource(item: RuntimeItem, requireWorktree: boolean): void {
  let pinned: SkillSubtreeDigest;
  try {
    pinned = hashSkillSubtreeAtRevision(item.repositoryRoot, {
      revision: item.locked.source_revision,
      sourcePath: item.locked.path,
    });
  } catch (error) {
    fail(
      item.kind === 'dependency' && item.required
        ? 'ASPG_RUNTIME_DEPENDENCY_SOURCE_UNAVAILABLE'
        : 'ASPG_RUNTIME_SOURCE_UNAVAILABLE',
      `${item.id} pinned source is unavailable`,
      { cause: error },
    );
  }
  if (!sameDigest(pinned, item.locked)) {
    fail('ASPG_RUNTIME_SOURCE_LOCK_DIVERGENT', `${item.id} differs from Lock`);
  }
  if (!requireWorktree) return;
  let worktree: SkillSubtreeDigest;
  try {
    worktree = hashSkillSubtree(item.sourceAbsolute);
  } catch (error) {
    fail(
      item.kind === 'dependency' && item.required
        ? 'ASPG_RUNTIME_DEPENDENCY_SOURCE_UNAVAILABLE'
        : 'ASPG_RUNTIME_SOURCE_UNAVAILABLE',
      `${item.id} worktree source is unavailable`,
      { cause: error },
    );
  }
  if (!sameDigest(worktree, item.locked)) {
    fail('ASPG_RUNTIME_SOURCE_LOCK_DIVERGENT', `${item.id} worktree differs from Lock`);
  }
}

function currentTargetOwner(
  current: Map<string, { backend: PortfolioDeploymentBackend; locked: LockedContentIdentity }>,
  item: RuntimeItem,
): { backend: PortfolioDeploymentBackend; locked: LockedContentIdentity } | null {
  return current.get(item.targetRelative) ?? null;
}

function linkPlan(validated: ValidatedDeployment): LinkPlan[] {
  const current = stateTargets(validated.currentState);
  const plans: LinkPlan[] = [];
  for (const item of validated.items) {
    verifyPinnedSource(item, true);
    const stat = lstatIfPresent(item.targetAbsolute);
    const owner = currentTargetOwner(current, item);
    if (!owner) {
      if (stat) {
        fail('ASPG_RUNTIME_TARGET_UNMANAGED', `refusing existing target ${item.targetRelative}`);
      }
      plans.push({ item, action: 'created', stage: null });
      continue;
    }
    if (owner.backend !== 'managed-link') {
      fail('ASPG_RUNTIME_TARGET_UNMANAGED', `${item.targetRelative} changed backend ownership`);
    }
    if (!stat) {
      fail(
        item.kind === 'dependency' && item.required
          ? 'ASPG_RUNTIME_DEPENDENCY_MISSING'
          : 'ASPG_RUNTIME_TARGET_MISSING',
        item.targetRelative,
      );
    }
    if (!stat.isSymbolicLink()) {
      fail('ASPG_RUNTIME_TARGET_UNMANAGED', `${item.targetRelative} is not an owned link`);
    }
    const priorSource = sourcePath(item.repositoryRoot, owner.locked);
    let resolved: string;
    try {
      resolved = fs.realpathSync(item.targetAbsolute);
    } catch (error) {
      fail('ASPG_RUNTIME_TARGET_UNMANAGED', `${item.targetRelative} is a broken link`, {
        cause: error,
      });
    }
    let priorResolved: string;
    try {
      priorResolved = fs.realpathSync(priorSource);
    } catch (error) {
      fail('ASPG_RUNTIME_SOURCE_UNAVAILABLE', `${item.id} previous source is unavailable`, {
        cause: error,
      });
    }
    if (resolved !== priorResolved) {
      fail('ASPG_RUNTIME_TARGET_UNMANAGED', `${item.targetRelative} points elsewhere`);
    }
    const nextResolved = fs.realpathSync(item.sourceAbsolute);
    plans.push({
      item,
      action: resolved === nextResolved && sameDigest({
        tree_hash: owner.locked.tree_hash,
        executable_files: owner.locked.executable_files,
      }, item.locked)
        ? 'noop'
        : 'refreshed',
      stage: null,
    });
  }
  return plans;
}

function materializationItems(
  validated: ValidatedDeployment,
): ManagedMaterializationItem[] {
  const current = stateTargets(validated.currentState);
  return validated.items.map((item) => {
    verifyPinnedSource(item, false);
    const owner = currentTargetOwner(current, item);
    if (owner && owner.backend !== 'managed-materialized') {
      fail('ASPG_RUNTIME_TARGET_UNMANAGED', `${item.targetRelative} changed backend ownership`);
    }
    return {
      id: item.id,
      kind: item.kind,
      required: item.required,
      repository_root: item.repositoryRoot,
      target_root: item.kind === 'skill'
        ? validated.runtimeRoot
        : validated.projectRoot,
      target: portableFromAbsolute(
        item.kind === 'skill' ? validated.runtimeRoot : validated.projectRoot,
        item.targetAbsolute,
        `${item.id}.materialized_target`,
      ),
      locked: item.locked,
      deployed: owner
        ? {
          tree_hash: owner.locked.tree_hash,
          executable_files: [...owner.locked.executable_files],
        }
        : null,
    };
  });
}

function nextPortableState(
  input: ExecutePortfolioRuntimeRequest,
  now: string,
): PortableDeploymentState {
  return normalizePortableDeploymentState({
    ...nextStateShape(input),
    updated_at: now,
  });
}

function snapshotRoots(validated: ValidatedDeployment): string[] {
  const roots = [
    validated.deploymentDirectoryRelative,
    ...validated.items
      .filter((item) => item.kind === 'skill')
      .map((item) => item.targetRelative),
  ];
  if (validated.items.some((item) => item.kind === 'dependency')) {
    roots.push('.aspg/dependencies');
  }
  if (validated.generatedFiles.length > 0) roots.push('.aspg/generated');
  return [...new Set(roots)].sort();
}

function writeGeneratedFiles(
  files: ValidatedDeployment['generatedFiles'],
  operationId: string,
): void {
  for (const generated of files) {
    const parent = path.dirname(generated.targetAbsolute);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      parent,
      `.${path.basename(generated.targetAbsolute)}.aspg-generated-${operationId}-${randomUUID()}`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      fs.writeFileSync(descriptor, generated.bytes, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, generated.targetAbsolute);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      const stat = lstatIfPresent(temporary);
      if (stat?.isFile()) fs.unlinkSync(temporary);
    }
  }
}

function stageLinks(plans: LinkPlan[], operationId: string): void {
  for (const plan of plans) {
    if (plan.action === 'noop') continue;
    const parent = path.dirname(plan.item.targetAbsolute);
    plan.stage = path.join(
      parent,
      `.${path.basename(plan.item.targetAbsolute)}.aspg-link-stage-${operationId}-${randomUUID()}`,
    );
    const relativeSource = path.relative(parent, plan.item.sourceAbsolute);
    if (!relativeSource || path.isAbsolute(relativeSource)) {
      fail('ASPG_RUNTIME_LINK_TARGET_INVALID', plan.item.id);
    }
    fs.symlinkSync(relativeSource, plan.stage);
  }
}

function activateLinks(plans: LinkPlan[]): void {
  for (const plan of plans) {
    if (plan.action === 'noop') continue;
    fs.renameSync(plan.stage!, plan.item.targetAbsolute);
    plan.stage = null;
  }
}

function cleanupLinkStages(plans: LinkPlan[]): void {
  for (const plan of plans) {
    if (plan.stage) fs.rmSync(plan.stage, { recursive: true, force: true });
    plan.stage = null;
  }
}

function verifyTargets(
  input: ResolvedPortfolioRuntimeDeployment,
  validated: ValidatedDeployment,
): void {
  for (const item of validated.items) {
    if (input.deployment_backend === 'managed-link') {
      const inspected = inspectManagedLinkTarget({
        fixtureRoot: validated.fixtureRoot,
        targetPath: item.targetAbsolute,
        expectedSourcePath: item.sourceAbsolute,
        expected: item.locked,
        required: item.required,
      });
      if (inspected.health !== 'in-sync') {
        fail(
          item.kind === 'dependency' && item.required
            ? 'ASPG_RUNTIME_DEPENDENCY_VERIFY_FAILED'
            : 'ASPG_RUNTIME_TARGET_VERIFY_FAILED',
          `${item.id}: ${inspected.health}`,
        );
      }
      continue;
    }
    const stat = lstatIfPresent(item.targetAbsolute);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      fail('ASPG_RUNTIME_TARGET_VERIFY_FAILED', `${item.id}: missing`);
    }
    const observed = hashSkillSubtree(item.targetAbsolute);
    if (!sameDigest(observed, item.locked)) {
      fail(
        item.kind === 'dependency' && item.required
          ? 'ASPG_RUNTIME_DEPENDENCY_VERIFY_FAILED'
          : 'ASPG_RUNTIME_TARGET_VERIFY_FAILED',
        item.id,
      );
    }
  }
}

function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown };
  const raw = typeof candidate?.code === 'string' ? candidate.code : 'runtime-activation-failed';
  const normalized = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 128);
  return IDENTIFIER.test(normalized) ? normalized : 'runtime-activation-failed';
}

function rollbackFailedOperation(
  operation: ActivationOperation,
  error: unknown,
): void {
  const journal = readActivationJournal(operation);
  if (['committed', 'rolled-back', 'failed'].includes(journal.phase)) return;
  if (journal.phase === 'planned') {
    recordActivationBlockingFailure(operation, errorCode(error));
    return;
  }
  if (!journal.snapshot_path) {
    recordActivationBlockingFailure(operation, errorCode(error));
    return;
  }
  rollbackActivation(operation, errorCode(error));
}

/**
 * Apply or refresh one already-resolved deployment as a generation-checked
 * transaction. No all-projects/default-cwd mode exists.
 */
export function executePortfolioRuntimeMutation(
  input: ExecutePortfolioRuntimeRequest,
): PortfolioRuntimeExecutionResult {
  assertIdentifier(input.operation_id, 'operation_id');
  if (input.mutation === 'apply' && input.current_generation !== 0) {
    fail('ASPG_RUNTIME_MUTATION_INVALID', 'apply requires current_generation 0');
  }
  if (input.mutation === 'refresh' && input.current_generation === 0) {
    fail('ASPG_RUNTIME_MUTATION_INVALID', 'refresh requires an existing generation');
  }
  const validated = validateDeployment(input);
  if (validated.transitionIncomplete) {
    fail(
      'ASPG_RUNTIME_TRANSITION_INCOMPLETE',
      'device generation or activation lock is not reconciled',
    );
  }
  if (validated.generatedHealth !== 'in-sync') {
    fail(
      'ASPG_RUNTIME_GENERATED_CONFIG_DRIFT',
      `generated private pack config is ${validated.generatedHealth}`,
    );
  }
  if (
    validated.provider.status !== 'ready'
    || !validated.provider.hydrated
    || !validated.provider.writable
  ) {
    fail(
      'ASPG_RUNTIME_PROVIDER_NOT_READY',
      validated.provider.reason ?? validated.provider.status,
    );
  }

  // Link preflight and pinned object checks happen before any transaction write.
  const links = input.deployment_backend === 'managed-link'
    ? linkPlan(validated)
    : null;
  const copies = input.deployment_backend === 'managed-materialized'
    ? materializationItems(validated)
    : null;

  // The deployment parent is ASPG-owned scaffolding. Snapshot the deployment
  // directory itself so a new state.yaml is removed on rollback.
  fs.mkdirSync(
    path.join(validated.projectRoot, '.aspg', 'deployments'),
    { recursive: true, mode: 0o700 },
  );
  const operation = createActivationOperation({
    fixtureRoot: validated.fixtureRoot,
    stateRoot: validated.stateRoot,
    targetRoot: validated.projectRoot,
    portableStatePath: validated.statePath,
    portfolio: input.portfolio,
    deployment: input.deployment,
    projectRef: input.project_ref,
    deviceId: input.device_id,
    mutation: input.mutation,
    expectedGeneration: input.current_generation,
    operationId: input.operation_id,
    now: input.now,
  });

  let materializationResult: ReturnType<typeof materializeManagedContent> | null = null;
  try {
    acquireActivationLock(operation);
    captureActivationSnapshot(operation, snapshotRoots(validated));
    for (const item of validated.items) {
      if (item.kind === 'dependency') {
        fs.mkdirSync(path.dirname(item.targetAbsolute), {
          recursive: true,
          mode: 0o700,
        });
      }
    }
    for (const generated of validated.generatedFiles) {
      fs.mkdirSync(path.dirname(generated.targetAbsolute), {
        recursive: true,
        mode: 0o700,
      });
    }

    if (links) {
      stageLinks(links, input.operation_id);
      advanceActivationPhase(operation, 'staged');
      activateLinks(links);
    } else {
      advanceActivationPhase(operation, 'staged');
      materializationResult = materializeManagedContent({
        fixture_root: validated.fixtureRoot,
        operation_id: input.operation_id,
        mutation: input.mutation,
        preflight: validated.provider,
        items: copies!,
      });
    }
    advanceActivationPhase(operation, 'activated');
    verifyTargets(input, validated);
    writeGeneratedFiles(validated.generatedFiles, input.operation_id);
    writePortableDeploymentState({
      projectRoot: validated.projectRoot,
      stateRelativePath: validated.stateRelativePath,
      expectedGeneration: input.current_generation === 0
        ? null
        : input.current_generation,
      state: nextPortableState(
        input,
        input.now?.() ?? new Date().toISOString(),
      ),
    });
    advanceActivationPhase(operation, 'verified');
    commitActivation(operation);

    const targetActions = links
      ? links.map((plan) => ({
        id: plan.item.id,
        kind: plan.item.kind,
        target: plan.item.targetRelative,
        action: plan.action,
      }))
      : materializationResult!.targets.map((target) => {
        const item = validated.items.find((candidate) => candidate.id === target.id)!;
        return {
          id: target.id,
          kind: target.kind,
          target: item.targetRelative,
          action: target.action,
        };
      });
    return {
      operation_id: input.operation_id,
      phase: 'committed',
      generation: input.next_generation,
      backend: input.deployment_backend,
      state_path: validated.statePath,
      targets: targetActions,
    };
  } catch (error) {
    try {
      rollbackFailedOperation(operation, error);
    } catch (rollbackError) {
      fail(
        'ASPG_RUNTIME_ROLLBACK_FAILED',
        'activation failed and journal rollback did not complete',
        { cause: rollbackError },
      );
    } finally {
      if (links) cleanupLinkStages(links);
    }
    throw error;
  } finally {
    if (links) cleanupLinkStages(links);
  }
}

function inspectMaterialized(item: RuntimeItem): PortfolioHealth {
  const stat = lstatIfPresent(item.targetAbsolute);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) return 'unmanaged-content';
  if (!stat.isDirectory()) return 'unmanaged-content';
  let observed: SkillSubtreeDigest;
  try {
    observed = hashSkillSubtree(item.targetAbsolute);
  } catch {
    return 'unmanaged-content';
  }
  const actualModes = [...observed.executable_files].sort();
  const lockedModes = [...item.locked.executable_files].sort();
  if (
    actualModes.length !== lockedModes.length
    || actualModes.some((entry, index) => entry !== lockedModes[index])
  ) {
    return 'mode-drift';
  }
  return observed.tree_hash === item.locked.tree_hash ? 'in-sync' : 'local-drift';
}

/**
 * Read-only status/doctor inspection of one resolved deployment.
 */
export function inspectPortfolioRuntime(
  input: ResolvedPortfolioRuntimeDeployment,
): PortfolioRuntimeInspection {
  const validated = validateDeployment(input);
  const current = stateTargets(validated.currentState);
  const targets = validated.items.map((item): PortfolioRuntimeTargetInspection => {
    let health: PortfolioHealth;
    if (validated.provider.status !== 'ready') {
      health = providerHealth(validated.provider);
    } else if (!currentTargetOwner(current, item)) {
      const stat = lstatIfPresent(item.targetAbsolute);
      health = stat
        ? stat.isDirectory() && !stat.isSymbolicLink()
          ? 'unmanaged-copy'
          : 'unmanaged-content'
        : 'missing';
    } else if (input.deployment_backend === 'managed-link') {
      health = inspectManagedLinkTarget({
        fixtureRoot: validated.fixtureRoot,
        targetPath: item.targetAbsolute,
        expectedSourcePath: item.sourceAbsolute,
        expected: item.locked,
        required: item.required,
      }).health;
    } else {
      health = inspectMaterialized(item);
    }
    return {
      id: item.id,
      kind: item.kind,
      target: item.targetRelative,
      required: item.required,
      health,
      blocking: item.required && health !== 'in-sync',
    };
  });
  const expectsGeneratedConfig =
    privatePackConfigBytes(nextStateShape(input).entries) !== null
    || privatePackConfigBytes(validated.currentState?.entries ?? []) !== null
    || lstatIfPresent(path.join(
      validated.projectRoot,
      '.aspg',
      'generated',
      'private-skill-packs.json',
    )) !== null;
  if (expectsGeneratedConfig) {
    targets.push({
      id: 'private-skill-packs',
      kind: 'generated',
      target: '.aspg/generated/private-skill-packs.json',
      required: true,
      health: validated.generatedHealth,
      blocking: validated.generatedHealth !== 'in-sync',
    });
  }
  const blocking = targets.some((target) => target.blocking)
    || validated.provider.status !== 'ready'
    || validated.transitionIncomplete;
  const health = validated.transitionIncomplete
    ? 'transition-incomplete'
    : validated.provider.status !== 'ready'
      ? providerHealth(validated.provider)
      : targets.find((target) => target.blocking)?.health ?? 'in-sync';
  return {
    deployment: input.deployment,
    backend: input.deployment_backend,
    provider: validated.provider,
    state_path: validated.statePath,
    state_generation: validated.currentState?.generation ?? null,
    health,
    blocking,
    targets,
  };
}

function loadRecoveryOperation(
  input: PortfolioRuntimeRecoveryRequest,
): ActivationOperation {
  assertIdentifier(input.operation_id, 'operation_id');
  return loadActivationOperation({
    fixtureRoot: assertFixtureRoot(input.fixture_root),
    stateRoot: assertContained(
      assertFixtureRoot(input.fixture_root),
      input.state_root,
      'state_root',
      false,
    ),
    operationId: input.operation_id,
    now: input.now,
  });
}

/**
 * Conservative repair: phases with a snapshot are rolled back; planned/locked
 * operations are terminated without touching targets because their resolved
 * deployment input is intentionally not persisted in the journal.
 */
export function repairPortfolioRuntimeOperation(
  input: PortfolioRuntimeRecoveryRequest,
): ActivationJournalEntry {
  const operation = loadRecoveryOperation(input);
  const journal = readActivationJournal(operation);
  const action = activationRecoveryAction(journal);
  if (action === 'none') return journal;
  if (action === 'resume') {
    if (journal.phase === 'locked') resumeActivationLock(operation);
    return recordActivationBlockingFailure(operation, 'runtime-repair-required');
  }
  resumeActivationLock(operation);
  return rollbackActivation(operation, 'runtime-repair-rollback');
}

/**
 * Explicit rollback for an interrupted, non-terminal operation.
 */
export function rollbackPortfolioRuntimeOperation(
  input: PortfolioRuntimeRecoveryRequest,
): ActivationJournalEntry {
  const operation = loadRecoveryOperation(input);
  const journal = readActivationJournal(operation);
  if (journal.phase === 'committed') {
    fail(
      'ASPG_RUNTIME_TERMINAL_OPERATION',
      'committed operations require a new reverse transaction, not journal rollback',
    );
  }
  if (journal.phase === 'rolled-back' || journal.phase === 'failed') return journal;
  if (journal.phase === 'planned') {
    return recordActivationBlockingFailure(operation, 'runtime-rollback-before-lock');
  }
  resumeActivationLock(operation);
  if (!readActivationJournal(operation).snapshot_path) {
    return recordActivationBlockingFailure(operation, 'runtime-rollback-before-snapshot');
  }
  return rollbackActivation(operation, 'runtime-explicit-rollback');
}
