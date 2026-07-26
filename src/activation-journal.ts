import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ACTIVATION_PHASES,
  type ActivationJournalEntry,
  type ActivationPhase,
  type PortfolioMutationKind,
} from './portfolio-runtime-types.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORWARD_PHASES: ActivationPhase[] = [
  'planned',
  'locked',
  'snapshotted',
  'staged',
  'activated',
  'verified',
  'committed',
];

type SnapshotKind = 'missing' | 'file' | 'directory' | 'symlink';

interface OperationOwner {
  version: 1;
  operation_id: string;
  portfolio: string;
  deployment: string;
  project_ref: string;
  device_id: string;
  mutation: PortfolioMutationKind;
  expected_generation: number;
  fixture_root: string;
  state_root: string;
  target_root: string;
  portable_state_path: string;
  created_by_pid: number;
}

interface GenerationState {
  version: 1;
  portfolio: string;
  deployment: string;
  project_ref?: string;
  generation: number;
  operation_id: string | null;
}

interface LockOwner {
  version: 1;
  operation_id: string;
  portfolio: string;
  deployment: string;
  generation: number;
  pid: number;
  acquired_at: string;
}

interface SnapshotEntry {
  path: string;
  kind: SnapshotKind;
  mode: number | null;
  link_target: string | null;
  payload_file: string | null;
}

interface SnapshotManifest {
  version: 1;
  operation_id: string;
  portfolio: string;
  deployment: string;
  generation: number;
  target_root: string;
  roots: string[];
  entries: SnapshotEntry[];
}

export class ActivationJournalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ActivationJournalError';
    this.code = code;
  }
}

export interface CreateActivationOperationInput {
  fixtureRoot: string;
  stateRoot: string;
  targetRoot: string;
  portableStatePath: string;
  portfolio: string;
  deployment: string;
  projectRef: string;
  deviceId: string;
  mutation: PortfolioMutationKind;
  expectedGeneration: number;
  operationId?: string;
  now?: () => string;
}

export interface LoadActivationOperationInput {
  fixtureRoot: string;
  stateRoot: string;
  operationId: string;
  now?: () => string;
}

export interface ActivationOperation {
  readonly fixtureRoot: string;
  readonly stateRoot: string;
  readonly targetRoot: string;
  readonly portableStatePath: string;
  readonly operationId: string;
  readonly portfolio: string;
  readonly deployment: string;
  readonly projectRef: string;
  readonly expectedGeneration: number;
  readonly journalPath: string;
  readonly ownerPath: string;
  readonly lockPath: string;
  readonly generationPath: string;
  readonly snapshotManifestPath: string;
  readonly rollbackPayloadPath: string;
  readonly now: () => string;
}

export type ActivationRecoveryAction = 'none' | 'resume' | 'rollback';

export interface BootstrapActivationGenerationInput {
  fixtureRoot: string;
  stateRoot: string;
  portable: {
    portfolio: string;
    deployment: string;
    project_ref: string;
    generation: number;
  };
}

export interface BootstrapActivationGenerationResult {
  status: 'bootstrapped' | 'in-sync';
  path: string;
  generation: number;
  portfolio: string;
  deployment: string;
  project_ref: string;
}

function fail(code: string, message: string): never {
  throw new ActivationJournalError(code, message);
}

function validateIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value) || value === '.' || value === '..') {
    fail('invalid-identifier', `${label} must be a single portable identifier`);
  }
  return value;
}

function validateGeneration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid-generation', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function isSameOrWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative));
}

function isProperlyWithin(parent: string, candidate: string): boolean {
  return parent !== candidate && isSameOrWithin(parent, candidate);
}

function pathExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function resolveWithExistingAncestor(candidate: string): string {
  const absolute = path.resolve(candidate);
  const remainder: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      fail('path-unresolvable', `cannot resolve an existing ancestor for ${candidate}`);
    }
    remainder.unshift(path.basename(cursor));
    cursor = parent;
  }
  const resolved = fs.realpathSync(cursor);
  return path.resolve(resolved, ...remainder);
}

function assertAbsolute(candidate: string, label: string): string {
  if (!path.isAbsolute(candidate)) {
    fail('path-not-absolute', `${label} must be explicit and absolute`);
  }
  return resolveWithExistingAncestor(candidate);
}

function assertNoSymlinkAncestors(root: string, candidate: string): void {
  if (!isSameOrWithin(root, candidate)) {
    fail('path-escape', `${candidate} escapes ${root}`);
  }
  if (pathExists(root) && fs.lstatSync(root).isSymbolicLink()) {
    fail('symlink-ancestor', `symlink root is not allowed: ${root}`);
  }
  const relative = path.relative(root, candidate);
  if (!relative) return;
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (!pathExists(cursor)) continue;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      fail('symlink-ancestor', `symlink ancestor is not allowed: ${cursor}`);
    }
  }
}

function assertFixtureLayout(
  fixtureRootInput: string,
  stateRootInput: string,
  targetRootInput: string,
  portableStatePathInput: string,
): {
  fixtureRoot: string;
  stateRoot: string;
  targetRoot: string;
  portableStatePath: string;
} {
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const fixtureRoot = assertAbsolute(fixtureRootInput, 'fixtureRoot');
  if (!fs.existsSync(fixtureRoot) || !fs.statSync(fixtureRoot).isDirectory()) {
    fail('fixture-root-missing', 'fixtureRoot must be an existing directory');
  }
  if (!isProperlyWithin(tmpRoot, fixtureRoot)) {
    fail('non-fixture-root', `fixtureRoot must be a child of $TMPDIR (${tmpRoot})`);
  }
  assertNoSymlinkAncestors(tmpRoot, fixtureRoot);

  const stateRoot = assertAbsolute(stateRootInput, 'stateRoot');
  const targetRoot = assertAbsolute(targetRootInput, 'targetRoot');
  const portableStatePath = assertAbsolute(portableStatePathInput, 'portableStatePath');
  for (const [label, candidate] of [
    ['stateRoot', stateRoot],
    ['targetRoot', targetRoot],
    ['portableStatePath', portableStatePath],
  ] as const) {
    if (!isProperlyWithin(fixtureRoot, candidate)) {
      fail('fixture-path-escape', `${label} must be a proper child of fixtureRoot`);
    }
  }
  if (
    isSameOrWithin(stateRoot, targetRoot)
    || isSameOrWithin(targetRoot, stateRoot)
    || isSameOrWithin(stateRoot, portableStatePath)
    || isSameOrWithin(portableStatePath, stateRoot)
  ) {
    fail(
      'state-root-overlap',
      'device-local stateRoot must be separate from target and portable project state',
    );
  }
  assertNoSymlinkAncestors(fixtureRoot, path.dirname(stateRoot));
  assertNoSymlinkAncestors(fixtureRoot, path.dirname(targetRoot));
  assertNoSymlinkAncestors(fixtureRoot, path.dirname(portableStatePath));
  return { fixtureRoot, stateRoot, targetRoot, portableStatePath };
}

function relativeTargetPath(value: string): string {
  if (
    !value
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
  ) {
    fail('invalid-target-path', 'snapshot target must be a portable relative path');
  }
  const normalized = path.posix.normalize(value);
  const parts = normalized.split('/');
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail('invalid-target-path', `unsafe snapshot target: ${value}`);
  }
  return normalized;
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes(code ?? '')) {
      throw error;
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function atomicWrite(pathname: string, bytes: Buffer | string, mode = 0o600): void {
  const directory = path.dirname(pathname);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(pathname)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, pathname);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function atomicWriteJson(pathname: string, value: unknown): void {
  atomicWrite(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(pathname: string, code: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(pathname, 'utf8'));
  } catch (error) {
    fail(code, `cannot read valid JSON from ${pathname}: ${(error as Error).message}`);
  }
}

function operationPaths(
  stateRoot: string,
  portfolio: string,
  deployment: string,
  operationId: string,
): Omit<
  ActivationOperation,
  | 'fixtureRoot'
  | 'stateRoot'
  | 'targetRoot'
  | 'portableStatePath'
  | 'operationId'
  | 'portfolio'
  | 'deployment'
  | 'projectRef'
  | 'expectedGeneration'
  | 'now'
> {
  const operationRoot = path.join(stateRoot, 'operations', operationId);
  const stem = `${portfolio}-${deployment}`;
  return {
    journalPath: path.join(operationRoot, 'journal.json'),
    ownerPath: path.join(operationRoot, 'owner.json'),
    lockPath: path.join(stateRoot, 'locks', `${stem}.lock`),
    generationPath: path.join(stateRoot, 'generations', `${stem}.json`),
    snapshotManifestPath: path.join(operationRoot, 'snapshot', 'manifest.json'),
    rollbackPayloadPath: path.join(operationRoot, 'snapshot', 'payload'),
  };
}

function toOperation(owner: OperationOwner, now: () => string): ActivationOperation {
  const paths = operationPaths(
    owner.state_root,
    owner.portfolio,
    owner.deployment,
    owner.operation_id,
  );
  return {
    fixtureRoot: owner.fixture_root,
    stateRoot: owner.state_root,
    targetRoot: owner.target_root,
    portableStatePath: owner.portable_state_path,
    operationId: owner.operation_id,
    portfolio: owner.portfolio,
    deployment: owner.deployment,
    projectRef: owner.project_ref,
    expectedGeneration: owner.expected_generation,
    now,
    ...paths,
  };
}

function parseOwner(value: unknown): OperationOwner {
  if (!value || typeof value !== 'object') fail('owner-invalid', 'owner must be an object');
  const owner = value as Record<string, unknown>;
  if (
    owner.version !== 1
    || typeof owner.operation_id !== 'string'
    || typeof owner.portfolio !== 'string'
    || typeof owner.deployment !== 'string'
    || typeof owner.project_ref !== 'string'
    || typeof owner.device_id !== 'string'
    || !['apply', 'refresh', 'repair', 'rollback'].includes(String(owner.mutation))
    || typeof owner.fixture_root !== 'string'
    || typeof owner.state_root !== 'string'
    || typeof owner.target_root !== 'string'
    || typeof owner.portable_state_path !== 'string'
    || typeof owner.created_by_pid !== 'number'
    || typeof owner.expected_generation !== 'number'
  ) {
    fail('owner-invalid', 'operation owner payload is incomplete or invalid');
  }
  validateIdentifier(owner.operation_id, 'operation_id');
  validateIdentifier(owner.portfolio, 'portfolio');
  validateIdentifier(owner.deployment, 'deployment');
  validateIdentifier(owner.project_ref, 'project_ref');
  validateIdentifier(owner.device_id, 'device_id');
  validateGeneration(owner.expected_generation, 'expected_generation');
  return owner as unknown as OperationOwner;
}

function parseJournal(value: unknown): ActivationJournalEntry {
  if (!value || typeof value !== 'object') fail('journal-invalid', 'journal must be an object');
  const journal = value as Record<string, unknown>;
  if (
    journal.version !== 1
    || typeof journal.operation_id !== 'string'
    || typeof journal.portfolio !== 'string'
    || typeof journal.deployment !== 'string'
    || typeof journal.project_ref !== 'string'
    || typeof journal.device_id !== 'string'
    || typeof journal.generation !== 'number'
    || !['apply', 'refresh', 'repair', 'rollback'].includes(String(journal.mutation))
    || !ACTIVATION_PHASES.includes(journal.phase as ActivationPhase)
    || typeof journal.target_root !== 'string'
    || typeof journal.portable_state_path !== 'string'
    || !(typeof journal.snapshot_path === 'string' || journal.snapshot_path === null)
    || !(
      typeof journal.rollback_payload_path === 'string'
      || journal.rollback_payload_path === null
    )
    || typeof journal.started_at !== 'string'
    || typeof journal.updated_at !== 'string'
    || !(typeof journal.error_code === 'string' || journal.error_code === null)
  ) {
    fail('journal-invalid', 'activation journal payload is incomplete or invalid');
  }
  validateGeneration(journal.generation, 'journal generation');
  return journal as unknown as ActivationJournalEntry;
}

function assertJournalOwnership(
  operation: ActivationOperation,
  journal: ActivationJournalEntry,
): void {
  if (
    journal.operation_id !== operation.operationId
    || journal.portfolio !== operation.portfolio
    || journal.deployment !== operation.deployment
    || journal.target_root !== operation.targetRoot
    || journal.portable_state_path !== operation.portableStatePath
  ) {
    fail('journal-ownership-mismatch', 'journal does not belong to this operation');
  }
}

function parseGeneration(value: unknown): GenerationState {
  if (!value || typeof value !== 'object') {
    fail('generation-invalid', 'generation state must be an object');
  }
  const generation = value as Record<string, unknown>;
  if (
    generation.version !== 1
    || typeof generation.portfolio !== 'string'
    || typeof generation.deployment !== 'string'
    || !(
      typeof generation.project_ref === 'string'
      || generation.project_ref === undefined
    )
    || typeof generation.generation !== 'number'
    || !(typeof generation.operation_id === 'string' || generation.operation_id === null)
  ) {
    fail('generation-invalid', 'generation state is incomplete or invalid');
  }
  validateGeneration(generation.generation, 'stored generation');
  return generation as unknown as GenerationState;
}

function generationState(operation: ActivationOperation): GenerationState {
  if (!pathExists(operation.generationPath)) {
    return {
      version: 1,
      portfolio: operation.portfolio,
      deployment: operation.deployment,
      project_ref: operation.projectRef,
      generation: 0,
      operation_id: null,
    };
  }
  const state = parseGeneration(
    readJson(operation.generationPath, 'generation-invalid'),
  );
  if (
    state.portfolio !== operation.portfolio
    || state.deployment !== operation.deployment
    || (
      state.project_ref !== undefined
      && state.project_ref !== operation.projectRef
    )
  ) {
    fail('generation-ownership-mismatch', 'generation file identity does not match');
  }
  return state;
}

function writeSettledGeneration(
  operation: ActivationOperation,
  generation: number,
): void {
  atomicWriteJson(operation.generationPath, {
    version: 1,
    portfolio: operation.portfolio,
    deployment: operation.deployment,
    project_ref: operation.projectRef,
    generation,
    operation_id: null,
  } satisfies GenerationState);
}

function parseLock(value: unknown): LockOwner {
  if (!value || typeof value !== 'object') fail('lock-invalid', 'lock must be an object');
  const lock = value as Record<string, unknown>;
  if (
    lock.version !== 1
    || typeof lock.operation_id !== 'string'
    || typeof lock.portfolio !== 'string'
    || typeof lock.deployment !== 'string'
    || typeof lock.generation !== 'number'
    || typeof lock.pid !== 'number'
    || typeof lock.acquired_at !== 'string'
  ) {
    fail('lock-invalid', 'activation lock is incomplete or corrupt');
  }
  return lock as unknown as LockOwner;
}

function lockOwner(operation: ActivationOperation): LockOwner {
  return {
    version: 1,
    operation_id: operation.operationId,
    portfolio: operation.portfolio,
    deployment: operation.deployment,
    generation: operation.expectedGeneration + 1,
    pid: process.pid,
    acquired_at: operation.now(),
  };
}

function writeExclusiveJson(pathname: string, value: unknown): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(pathname, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fsyncDirectory(path.dirname(pathname));
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail('activation-lock-held', `activation lock already exists: ${pathname}`);
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function bootstrapStateRoot(
  fixtureRootInput: string,
  stateRootInput: string,
): { fixtureRoot: string; stateRoot: string } {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const fixtureRoot = assertAbsolute(fixtureRootInput, 'fixtureRoot');
  if (
    !pathExists(fixtureRoot)
    || !fs.statSync(fixtureRoot).isDirectory()
    || !isProperlyWithin(temporaryRoot, fixtureRoot)
  ) {
    fail('non-fixture-root', 'fixtureRoot must be an existing child of $TMPDIR');
  }
  assertNoSymlinkAncestors(temporaryRoot, fixtureRoot);
  const unresolvedStateRoot = assertAbsolute(stateRootInput, 'stateRoot');
  if (!isProperlyWithin(fixtureRoot, unresolvedStateRoot)) {
    fail('fixture-path-escape', 'stateRoot must be a proper child of fixtureRoot');
  }
  assertNoSymlinkAncestors(fixtureRoot, path.dirname(unresolvedStateRoot));
  fs.mkdirSync(unresolvedStateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = fs.realpathSync(unresolvedStateRoot);
  if (stateRoot !== unresolvedStateRoot) {
    fail('state-root-alias', 'stateRoot must not resolve through an alias');
  }
  assertNoSymlinkAncestors(fixtureRoot, stateRoot);
  return { fixtureRoot, stateRoot };
}

function auditedMatchingJournals(
  stateRoot: string,
  portfolio: string,
  deployment: string,
): Map<string, ActivationJournalEntry> {
  const operationRoot = path.join(stateRoot, 'operations');
  if (!pathExists(operationRoot)) return new Map();
  assertNoSymlinkAncestors(stateRoot, operationRoot);
  if (!fs.statSync(operationRoot).isDirectory()) {
    fail('operation-root-invalid', 'operation root is not a directory');
  }
  const matching = new Map<string, ActivationJournalEntry>();
  for (const operationId of fs.readdirSync(operationRoot).sort()) {
    validateIdentifier(operationId, 'operation directory');
    const directory = path.join(operationRoot, operationId);
    assertNoSymlinkAncestors(stateRoot, directory);
    if (!fs.lstatSync(directory).isDirectory()) {
      fail('owner-invalid', `operation entry is not a directory: ${operationId}`);
    }
    const ownerPath = path.join(directory, 'owner.json');
    const journalPath = path.join(directory, 'journal.json');
    assertNoSymlinkAncestors(stateRoot, ownerPath);
    assertNoSymlinkAncestors(stateRoot, journalPath);
    const owner = parseOwner(readJson(ownerPath, 'owner-invalid'));
    const journal = parseJournal(readJson(journalPath, 'journal-invalid'));
    if (
      owner.operation_id !== operationId
      || journal.operation_id !== operationId
      || owner.portfolio !== journal.portfolio
      || owner.deployment !== journal.deployment
      || owner.project_ref !== journal.project_ref
      || journal.generation !== owner.expected_generation + 1
    ) {
      fail('journal-ownership-mismatch', `operation audit mismatch: ${operationId}`);
    }
    if (owner.portfolio === portfolio && owner.deployment === deployment) {
      matching.set(operationId, journal);
    }
  }
  return matching;
}

/**
 * Bootstrap one device-local generation from already-validated portable state.
 *
 * This is an explicit migration/recovery gate, not part of ordinary lock
 * acquisition. It never advances an existing different generation.
 */
export function bootstrapActivationGeneration(
  input: BootstrapActivationGenerationInput,
): BootstrapActivationGenerationResult {
  const portfolio = validateIdentifier(input.portable.portfolio, 'portfolio');
  const deployment = validateIdentifier(input.portable.deployment, 'deployment');
  const projectRef = validateIdentifier(input.portable.project_ref, 'project_ref');
  const portableGeneration = validateGeneration(
    input.portable.generation,
    'portable generation',
  );
  if (portableGeneration < 1) {
    fail('generation-bootstrap-invalid', 'portable generation must be positive');
  }
  const { stateRoot } = bootstrapStateRoot(input.fixtureRoot, input.stateRoot);
  const stem = `${portfolio}-${deployment}`;
  const lockPath = path.join(stateRoot, 'locks', `${stem}.lock`);
  const generationPath = path.join(stateRoot, 'generations', `${stem}.json`);
  assertNoSymlinkAncestors(stateRoot, lockPath);
  assertNoSymlinkAncestors(stateRoot, generationPath);
  const initialJournals = auditedMatchingJournals(stateRoot, portfolio, deployment);
  if (pathExists(lockPath)) {
    const existingLock = parseLock(readJson(lockPath, 'lock-invalid'));
    if (
      existingLock.portfolio !== portfolio
      || existingLock.deployment !== deployment
    ) {
      fail('generation-bootstrap-identity-conflict', 'activation lock identity differs');
    }
    if (processIsAlive(existingLock.pid)) {
      fail('generation-bootstrap-active-lock', 'generation bootstrap refuses a live lock');
    }
    const terminal = initialJournals.get(existingLock.operation_id);
    const isAbandonedBootstrapClaim = (
      existingLock.operation_id.startsWith('bootstrap-')
      && terminal === undefined
    );
    if (
      !isAbandonedBootstrapClaim
      && (
        terminal === undefined
        || terminal.project_ref !== projectRef
        || terminal.generation !== existingLock.generation
        || !['committed', 'rolled-back', 'failed'].includes(terminal.phase)
      )
    ) {
      fail(
        'generation-bootstrap-recovery-required',
        'dead lock does not belong to an audited terminal operation',
      );
    }
    const stalePath = `${lockPath}.bootstrap-stale-${process.pid}-${randomUUID()}`;
    fs.renameSync(lockPath, stalePath);
    fsyncDirectory(path.dirname(lockPath));
    fs.rmSync(stalePath, { force: true });
    fsyncDirectory(path.dirname(lockPath));
  }

  const bootstrapOperationId = `bootstrap-${randomUUID()}`;
  const bootstrapClaim: LockOwner = {
    version: 1,
    operation_id: bootstrapOperationId,
    portfolio,
    deployment,
    generation: portableGeneration,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  };
  try {
    writeExclusiveJson(lockPath, bootstrapClaim);
  } catch (error) {
    if (
      error instanceof ActivationJournalError
      && error.code === 'activation-lock-held'
    ) {
      fail(
        'generation-bootstrap-active-lock',
        'activation lock appeared during generation bootstrap',
      );
    }
    throw error;
  }

  try {
    const journals = auditedMatchingJournals(stateRoot, portfolio, deployment);
    const identityConflict = [...journals.values()].find(
      (journal) => journal.project_ref !== projectRef,
    );
    if (identityConflict) {
      fail(
        'generation-bootstrap-identity-conflict',
        `operation ${identityConflict.operation_id} belongs to another project`,
      );
    }
    const nonterminal = [...journals.values()].find(
      (journal) => !['committed', 'rolled-back', 'failed'].includes(journal.phase),
    );
    if (nonterminal) {
      fail(
        'generation-bootstrap-nonterminal',
        `operation ${nonterminal.operation_id} is ${nonterminal.phase}`,
      );
    }
    const highestSettledJournalGeneration = Math.max(
      0,
      ...[...journals.values()].map((journal) => (
        journal.phase === 'committed'
          ? journal.generation
          : journal.generation - 1
      )),
    );
    if (highestSettledJournalGeneration > portableGeneration) {
      fail(
        'generation-bootstrap-downgrade',
        `portable generation ${portableGeneration} is below audited device generation ${highestSettledJournalGeneration}`,
      );
    }

    if (pathExists(generationPath)) {
      const existing = parseGeneration(readJson(generationPath, 'generation-invalid'));
      if (existing.portfolio !== portfolio || existing.deployment !== deployment) {
        fail('generation-ownership-mismatch', 'generation file identity does not match');
      }
      if (existing.project_ref !== undefined && existing.project_ref !== projectRef) {
        fail('generation-bootstrap-identity-conflict', 'project identity differs');
      }
      if (existing.operation_id !== null) {
        const terminal = journals.get(existing.operation_id);
        if (!terminal) {
          fail(
            'generation-bootstrap-audit-missing',
            'generation references a missing matching journal',
          );
        }
        if (!['committed', 'rolled-back', 'failed'].includes(terminal.phase)) {
          fail(
            'generation-bootstrap-nonterminal',
            `operation ${terminal.operation_id} is ${terminal.phase}`,
          );
        }
        const settledGeneration = terminal.phase === 'committed'
          ? terminal.generation
          : terminal.generation - 1;
        if (
          terminal.project_ref !== projectRef
          || existing.generation !== terminal.generation
          || settledGeneration !== portableGeneration
        ) {
          fail(
            'generation-bootstrap-conflict',
            'terminal generation claim does not reconcile with portable state',
          );
        }
        atomicWriteJson(generationPath, {
          version: 1,
          portfolio,
          deployment,
          project_ref: projectRef,
          generation: portableGeneration,
          operation_id: null,
        } satisfies GenerationState);
        return {
          status: 'bootstrapped',
          path: generationPath,
          generation: portableGeneration,
          portfolio,
          deployment,
          project_ref: projectRef,
        };
      }
      if (existing.generation > portableGeneration) {
        fail('generation-bootstrap-downgrade', 'portable generation would downgrade device');
      }
      if (existing.generation < portableGeneration) {
        fail(
          'generation-bootstrap-conflict',
          'existing device generation cannot be advanced by bootstrap',
        );
      }
      if (existing.project_ref === projectRef) {
        return {
          status: 'in-sync',
          path: generationPath,
          generation: portableGeneration,
          portfolio,
          deployment,
          project_ref: projectRef,
        };
      }
      atomicWriteJson(generationPath, {
        ...existing,
        project_ref: projectRef,
      } satisfies GenerationState);
      return {
        status: 'bootstrapped',
        path: generationPath,
        generation: portableGeneration,
        portfolio,
        deployment,
        project_ref: projectRef,
      };
    }

    atomicWriteJson(generationPath, {
      version: 1,
      portfolio,
      deployment,
      project_ref: projectRef,
      generation: portableGeneration,
      operation_id: null,
    } satisfies GenerationState);
    return {
      status: 'bootstrapped',
      path: generationPath,
      generation: portableGeneration,
      portfolio,
      deployment,
      project_ref: projectRef,
    };
  } finally {
    if (pathExists(lockPath)) {
      const currentLock = parseLock(readJson(lockPath, 'lock-invalid'));
      if (
        currentLock.operation_id === bootstrapOperationId
        && currentLock.pid === process.pid
      ) {
        fs.rmSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
      }
    }
  }
}

function assertCurrentLock(operation: ActivationOperation): LockOwner {
  assertNoSymlinkAncestors(operation.stateRoot, operation.lockPath);
  const lock = parseLock(readJson(operation.lockPath, 'lock-invalid'));
  if (
    lock.operation_id !== operation.operationId
    || lock.portfolio !== operation.portfolio
    || lock.deployment !== operation.deployment
    || lock.pid !== process.pid
  ) {
    fail('lock-ownership-mismatch', 'current process does not own the activation lock');
  }
  const journal = readActivationJournal(operation);
  if (lock.generation !== journal.generation) {
    fail('lock-generation-mismatch', 'lock generation does not match journal');
  }
  const generation = generationState(operation);
  if (
    generation.generation !== journal.generation
    || generation.operation_id !== operation.operationId
  ) {
    fail('stale-generation', 'operation no longer owns the active generation');
  }
  return lock;
}

function updateJournal(
  operation: ActivationOperation,
  update: (current: ActivationJournalEntry) => ActivationJournalEntry,
  requireLock = true,
): ActivationJournalEntry {
  if (requireLock) assertCurrentLock(operation);
  const current = readActivationJournal(operation);
  const next = update(current);
  assertJournalOwnership(operation, next);
  atomicWriteJson(operation.journalPath, next);
  return next;
}

export function createActivationOperation(
  input: CreateActivationOperationInput,
): ActivationOperation {
  const layout = assertFixtureLayout(
    input.fixtureRoot,
    input.stateRoot,
    input.targetRoot,
    input.portableStatePath,
  );
  const operationId = validateIdentifier(
    input.operationId ?? randomUUID(),
    'operationId',
  );
  const portfolio = validateIdentifier(input.portfolio, 'portfolio');
  const deployment = validateIdentifier(input.deployment, 'deployment');
  validateIdentifier(input.projectRef, 'projectRef');
  validateIdentifier(input.deviceId, 'deviceId');
  const expectedGeneration = validateGeneration(
    input.expectedGeneration,
    'expectedGeneration',
  );
  fs.mkdirSync(layout.stateRoot, { recursive: true, mode: 0o700 });
  const stateRoot = fs.realpathSync(layout.stateRoot);
  if (stateRoot !== layout.stateRoot) {
    fail('state-root-alias', 'stateRoot must not resolve through an alias');
  }
  const paths = operationPaths(stateRoot, portfolio, deployment, operationId);
  const operationRoot = path.dirname(paths.ownerPath);
  fs.mkdirSync(path.dirname(operationRoot), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(operationRoot, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail('operation-id-collision', `operation already exists: ${operationId}`);
    }
    throw error;
  }
  const owner: OperationOwner = {
    version: 1,
    operation_id: operationId,
    portfolio,
    deployment,
    project_ref: input.projectRef,
    device_id: input.deviceId,
    mutation: input.mutation,
    expected_generation: expectedGeneration,
    fixture_root: layout.fixtureRoot,
    state_root: stateRoot,
    target_root: layout.targetRoot,
    portable_state_path: layout.portableStatePath,
    created_by_pid: process.pid,
  };
  atomicWriteJson(paths.ownerPath, owner);
  const operation = toOperation(owner, input.now ?? (() => new Date().toISOString()));
  const timestamp = operation.now();
  const journal: ActivationJournalEntry = {
    version: 1,
    operation_id: operationId,
    portfolio,
    deployment,
    project_ref: input.projectRef,
    device_id: input.deviceId,
    generation: expectedGeneration + 1,
    mutation: input.mutation,
    phase: 'planned',
    target_root: layout.targetRoot,
    portable_state_path: layout.portableStatePath,
    snapshot_path: null,
    rollback_payload_path: null,
    started_at: timestamp,
    updated_at: timestamp,
    error_code: null,
  };
  atomicWriteJson(paths.journalPath, journal);
  return operation;
}

export function loadActivationOperation(
  input: LoadActivationOperationInput,
): ActivationOperation {
  const operationId = validateIdentifier(input.operationId, 'operationId');
  const fixtureRoot = assertAbsolute(input.fixtureRoot, 'fixtureRoot');
  const stateRoot = assertAbsolute(input.stateRoot, 'stateRoot');
  if (!isProperlyWithin(fixtureRoot, stateRoot)) {
    fail('fixture-path-escape', 'stateRoot must remain inside fixtureRoot');
  }
  const ownerPath = path.join(stateRoot, 'operations', operationId, 'owner.json');
  assertNoSymlinkAncestors(stateRoot, ownerPath);
  const owner = parseOwner(readJson(ownerPath, 'owner-invalid'));
  const layout = assertFixtureLayout(
    input.fixtureRoot,
    input.stateRoot,
    owner.target_root,
    owner.portable_state_path,
  );
  if (
    owner.operation_id !== operationId
    || owner.fixture_root !== layout.fixtureRoot
    || owner.state_root !== layout.stateRoot
  ) {
    fail('owner-identity-mismatch', 'operation owner does not match requested roots');
  }
  const operation = toOperation(owner, input.now ?? (() => new Date().toISOString()));
  readActivationJournal(operation);
  return operation;
}

export function readActivationJournal(
  operation: ActivationOperation,
): ActivationJournalEntry {
  assertNoSymlinkAncestors(operation.stateRoot, operation.journalPath);
  const journal = parseJournal(readJson(operation.journalPath, 'journal-invalid'));
  assertJournalOwnership(operation, journal);
  return journal;
}

export function acquireActivationLock(
  operation: ActivationOperation,
): ActivationJournalEntry {
  const current = readActivationJournal(operation);
  if (current.phase !== 'planned') {
    fail('phase-conflict', `lock acquisition requires planned, got ${current.phase}`);
  }
  if (pathExists(operation.lockPath)) {
    assertNoSymlinkAncestors(operation.stateRoot, operation.lockPath);
    const existing = parseLock(readJson(operation.lockPath, 'lock-invalid'));
    if (processIsAlive(existing.pid)) {
      fail('activation-lock-held', `activation owner process ${existing.pid} is alive`);
    }
    const previousJournalPath = path.join(
      operation.stateRoot,
      'operations',
      validateIdentifier(existing.operation_id, 'lock operation_id'),
      'journal.json',
    );
    assertNoSymlinkAncestors(operation.stateRoot, previousJournalPath);
    const previous = parseJournal(readJson(previousJournalPath, 'journal-invalid'));
    if (
      previous.operation_id !== existing.operation_id
      || previous.portfolio !== operation.portfolio
      || previous.deployment !== operation.deployment
      || previous.generation !== existing.generation
      || !['committed', 'rolled-back', 'failed'].includes(previous.phase)
    ) {
      fail(
        'activation-recovery-required',
        'an interrupted non-terminal activation must be resumed or rolled back',
      );
    }
    const stalePath = `${operation.lockPath}.terminal-${existing.operation_id}-${process.pid}`;
    fs.rmSync(stalePath, { force: true });
    fs.renameSync(operation.lockPath, stalePath);
    fsyncDirectory(path.dirname(operation.lockPath));
    fs.rmSync(stalePath, { force: true });
  }
  const owner = lockOwner(operation);
  writeExclusiveJson(operation.lockPath, owner);
  try {
    const claimed = readActivationJournal(operation);
    if (claimed.phase !== 'planned') {
      fail(
        'phase-conflict',
        `journal changed before lock claim completed: ${claimed.phase}`,
      );
    }
    const generation = generationState(operation);
    if (generation.generation !== operation.expectedGeneration) {
      const failed: ActivationJournalEntry = {
        ...claimed,
        phase: 'failed',
        updated_at: operation.now(),
        error_code: 'stale-generation',
      };
      atomicWriteJson(operation.journalPath, failed);
      fail(
        'stale-generation',
        `expected generation ${operation.expectedGeneration}, got ${generation.generation}`,
      );
    }
    const nextGeneration: GenerationState = {
      version: 1,
      portfolio: operation.portfolio,
      deployment: operation.deployment,
      project_ref: operation.projectRef,
      generation: claimed.generation,
      operation_id: operation.operationId,
    };
    atomicWriteJson(operation.generationPath, nextGeneration);
    const locked: ActivationJournalEntry = {
      ...claimed,
      phase: 'locked',
      updated_at: operation.now(),
    };
    atomicWriteJson(operation.journalPath, locked);
    return locked;
  } catch (error) {
    if (fs.existsSync(operation.lockPath)) {
      const lock = parseLock(readJson(operation.lockPath, 'lock-invalid'));
      if (lock.operation_id === operation.operationId && lock.pid === process.pid) {
        fs.rmSync(operation.lockPath);
        fsyncDirectory(path.dirname(operation.lockPath));
      }
    }
    throw error;
  }
}

export function resumeActivationLock(
  operation: ActivationOperation,
): ActivationJournalEntry {
  const journal = readActivationJournal(operation);
  if (['committed', 'rolled-back', 'failed'].includes(journal.phase)) {
    fail('terminal-operation', `cannot resume terminal phase ${journal.phase}`);
  }
  let generation = generationState(operation);
  const generationAlreadyClaimed = (
    generation.generation === journal.generation
    && generation.operation_id === operation.operationId
  );
  const generationNotYetClaimed = (
    journal.phase === 'planned'
    && generation.generation === journal.generation - 1
  );
  if (!generationAlreadyClaimed && !generationNotYetClaimed) {
    fail('stale-generation', 'cannot resume an operation that does not own generation');
  }
  if (pathExists(operation.lockPath)) {
    assertNoSymlinkAncestors(operation.stateRoot, operation.lockPath);
    const existing = parseLock(readJson(operation.lockPath, 'lock-invalid'));
    if (
      existing.operation_id !== operation.operationId
      || existing.portfolio !== operation.portfolio
      || existing.deployment !== operation.deployment
      || existing.generation !== journal.generation
    ) {
      fail('activation-lock-held', 'lock belongs to another activation operation');
    }
    if (existing.pid !== process.pid) {
      if (processIsAlive(existing.pid)) {
        fail('activation-lock-held', `activation owner process ${existing.pid} is alive`);
      }
      const stalePath = `${operation.lockPath}.stale-${operation.operationId}-${process.pid}`;
      fs.rmSync(stalePath, { force: true });
      fs.renameSync(operation.lockPath, stalePath);
      fsyncDirectory(path.dirname(operation.lockPath));
      try {
        writeExclusiveJson(operation.lockPath, {
          ...existing,
          pid: process.pid,
          acquired_at: operation.now(),
        });
      } finally {
        fs.rmSync(stalePath, { force: true });
      }
    }
  } else {
    writeExclusiveJson(operation.lockPath, {
      version: 1,
      operation_id: operation.operationId,
      portfolio: operation.portfolio,
      deployment: operation.deployment,
      generation: journal.generation,
      pid: process.pid,
      acquired_at: operation.now(),
    } satisfies LockOwner);
  }
  if (generationNotYetClaimed) {
    generation = {
      version: 1,
      portfolio: operation.portfolio,
      deployment: operation.deployment,
      project_ref: operation.projectRef,
      generation: journal.generation,
      operation_id: operation.operationId,
    };
    atomicWriteJson(operation.generationPath, generation);
  }
  if (journal.phase === 'planned') {
    const locked = {
      ...journal,
      phase: 'locked' as const,
      updated_at: operation.now(),
    };
    atomicWriteJson(operation.journalPath, locked);
    return locked;
  }
  return journal;
}

export function releaseActivationLock(operation: ActivationOperation): void {
  if (!pathExists(operation.lockPath)) return;
  assertNoSymlinkAncestors(operation.stateRoot, operation.lockPath);
  const lock = parseLock(readJson(operation.lockPath, 'lock-invalid'));
  if (lock.operation_id !== operation.operationId || lock.pid !== process.pid) {
    fail('lock-ownership-mismatch', 'refusing to remove a lock owned by another process');
  }
  fs.rmSync(operation.lockPath);
  fsyncDirectory(path.dirname(operation.lockPath));
}

function captureNode(
  operation: ActivationOperation,
  relativePath: string,
  entries: SnapshotEntry[],
): void {
  const absolute = path.resolve(operation.targetRoot, ...relativePath.split('/'));
  if (!isProperlyWithin(operation.targetRoot, absolute)) {
    fail('path-escape', `snapshot path escapes target root: ${relativePath}`);
  }
  assertNoSymlinkAncestors(operation.targetRoot, path.dirname(absolute));
  if (!pathExists(absolute) && !fs.lstatSync(path.dirname(absolute)).isDirectory()) {
    fail('target-parent-invalid', `snapshot parent is not a directory: ${relativePath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      entries.push({
        path: relativePath,
        kind: 'missing',
        mode: null,
        link_target: null,
        payload_file: null,
      });
      return;
    }
    throw error;
  }
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    entries.push({
      path: relativePath,
      kind: 'symlink',
      mode,
      link_target: fs.readlinkSync(absolute),
      payload_file: null,
    });
    return;
  }
  if (stat.isFile()) {
    const payloadFile = `${entries.length.toString().padStart(8, '0')}.bin`;
    const payloadPath = path.join(operation.rollbackPayloadPath, payloadFile);
    atomicWrite(payloadPath, fs.readFileSync(absolute), 0o600);
    entries.push({
      path: relativePath,
      kind: 'file',
      mode,
      link_target: null,
      payload_file: payloadFile,
    });
    return;
  }
  if (!stat.isDirectory()) {
    fail('unsupported-target-type', `unsupported target type: ${relativePath}`);
  }
  entries.push({
    path: relativePath,
    kind: 'directory',
    mode,
    link_target: null,
    payload_file: null,
  });
  for (const child of fs.readdirSync(absolute).sort((left, right) => left.localeCompare(right))) {
    captureNode(operation, `${relativePath}/${child}`, entries);
  }
}

function assertNonOverlappingRoots(roots: string[]): void {
  const sorted = [...roots].sort((left, right) => left.localeCompare(right));
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      if (
        sorted[right] === sorted[left]
        || sorted[right].startsWith(`${sorted[left]}/`)
      ) {
        fail('snapshot-root-overlap', 'snapshot roots must be unique and non-overlapping');
      }
    }
  }
}

export function captureActivationSnapshot(
  operation: ActivationOperation,
  targets: string[],
): ActivationJournalEntry {
  assertCurrentLock(operation);
  const journal = readActivationJournal(operation);
  if (journal.phase !== 'locked') {
    fail('phase-conflict', `snapshot requires locked, got ${journal.phase}`);
  }
  if (targets.length === 0) fail('snapshot-empty', 'at least one target is required');
  const roots = targets.map(relativeTargetPath);
  assertNonOverlappingRoots(roots);
  if (pathExists(path.dirname(operation.snapshotManifestPath))) {
    fail('snapshot-already-exists', 'operation snapshot already exists');
  }
  fs.mkdirSync(operation.rollbackPayloadPath, { recursive: true, mode: 0o700 });
  const entries: SnapshotEntry[] = [];
  for (const target of roots) captureNode(operation, target, entries);
  const manifest: SnapshotManifest = {
    version: 1,
    operation_id: operation.operationId,
    portfolio: operation.portfolio,
    deployment: operation.deployment,
    generation: journal.generation,
    target_root: operation.targetRoot,
    roots,
    entries,
  };
  atomicWriteJson(operation.snapshotManifestPath, manifest);
  return updateJournal(operation, (current) => {
    if (current.phase !== 'locked') {
      fail('phase-conflict', `snapshot CAS expected locked, got ${current.phase}`);
    }
    return {
      ...current,
      phase: 'snapshotted',
      snapshot_path: operation.snapshotManifestPath,
      rollback_payload_path: operation.rollbackPayloadPath,
      updated_at: operation.now(),
    };
  });
}

export function advanceActivationPhase(
  operation: ActivationOperation,
  phase: 'staged' | 'activated' | 'verified',
): ActivationJournalEntry {
  return updateJournal(operation, (current) => {
    const currentIndex = FORWARD_PHASES.indexOf(current.phase);
    const nextIndex = FORWARD_PHASES.indexOf(phase);
    if (currentIndex < 0 || nextIndex !== currentIndex + 1) {
      fail('phase-conflict', `cannot advance ${current.phase} to ${phase}`);
    }
    return {
      ...current,
      phase,
      updated_at: operation.now(),
    };
  });
}

function parseSnapshot(value: unknown): SnapshotManifest {
  if (!value || typeof value !== 'object') {
    fail('snapshot-invalid', 'snapshot manifest must be an object');
  }
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== 1
    || typeof snapshot.operation_id !== 'string'
    || typeof snapshot.portfolio !== 'string'
    || typeof snapshot.deployment !== 'string'
    || typeof snapshot.generation !== 'number'
    || typeof snapshot.target_root !== 'string'
    || !Array.isArray(snapshot.roots)
    || !Array.isArray(snapshot.entries)
  ) {
    fail('snapshot-invalid', 'snapshot manifest is incomplete');
  }
  for (const root of snapshot.roots) {
    if (typeof root !== 'string') fail('snapshot-invalid', 'snapshot root is invalid');
    relativeTargetPath(root);
  }
  for (const raw of snapshot.entries) {
    if (!raw || typeof raw !== 'object') fail('snapshot-invalid', 'snapshot entry invalid');
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.path !== 'string'
      || !['missing', 'file', 'directory', 'symlink'].includes(String(entry.kind))
      || !(typeof entry.mode === 'number' || entry.mode === null)
      || !(typeof entry.link_target === 'string' || entry.link_target === null)
      || !(typeof entry.payload_file === 'string' || entry.payload_file === null)
    ) {
      fail('snapshot-invalid', 'snapshot entry is incomplete');
    }
    relativeTargetPath(entry.path);
    if (
      entry.payload_file !== null
      && !/^[0-9]{8}\.bin$/.test(entry.payload_file)
    ) {
      fail('snapshot-invalid', 'snapshot payload filename is invalid');
    }
  }
  return snapshot as unknown as SnapshotManifest;
}

function assertSnapshotOwnership(
  operation: ActivationOperation,
  journal: ActivationJournalEntry,
  snapshot: SnapshotManifest,
): void {
  if (
    journal.snapshot_path !== operation.snapshotManifestPath
    || journal.rollback_payload_path !== operation.rollbackPayloadPath
    || snapshot.operation_id !== operation.operationId
    || snapshot.portfolio !== operation.portfolio
    || snapshot.deployment !== operation.deployment
    || snapshot.generation !== journal.generation
    || snapshot.target_root !== operation.targetRoot
  ) {
    fail('snapshot-ownership-mismatch', 'snapshot does not belong to this operation');
  }
  const roots = new Set(snapshot.roots);
  for (const entry of snapshot.entries) {
    if (![...roots].some((root) => entry.path === root || entry.path.startsWith(`${root}/`))) {
      fail('snapshot-root-mismatch', `entry is outside declared roots: ${entry.path}`);
    }
  }
}

function entryForRoot(snapshot: SnapshotManifest, root: string): SnapshotEntry {
  const entry = snapshot.entries.find((candidate) => candidate.path === root);
  if (!entry) fail('snapshot-invalid', `missing snapshot root entry: ${root}`);
  return entry;
}

function materializeSnapshotRoot(
  operation: ActivationOperation,
  snapshot: SnapshotManifest,
  root: string,
  staging: string,
): void {
  const rootEntry = entryForRoot(snapshot, root);
  if (rootEntry.kind === 'missing') return;
  const relevant = snapshot.entries
    .filter((entry) => entry.path === root || entry.path.startsWith(`${root}/`))
    .sort((left, right) => left.path.localeCompare(right.path));
  const targetFor = (entry: SnapshotEntry): string => {
    const relative = entry.path === root ? '' : entry.path.slice(root.length + 1);
    return relative ? path.join(staging, ...relative.split('/')) : staging;
  };

  if (rootEntry.kind === 'directory') {
    fs.mkdirSync(staging, { mode: 0o700 });
  }
  const directories = relevant.filter((entry) => entry.kind === 'directory');
  for (const entry of directories) {
    const destination = targetFor(entry);
    if (destination !== staging) fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  for (const entry of relevant) {
    const destination = targetFor(entry);
    if (entry.kind === 'missing' || entry.kind === 'directory') continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (entry.kind === 'symlink') {
      if (entry.link_target === null) fail('snapshot-invalid', 'symlink target missing');
      fs.symlinkSync(entry.link_target, destination);
      continue;
    }
    if (entry.payload_file === null || entry.mode === null) {
      fail('snapshot-invalid', 'file payload metadata missing');
    }
    const payload = path.join(operation.rollbackPayloadPath, entry.payload_file);
    assertNoSymlinkAncestors(operation.rollbackPayloadPath, payload);
    atomicWrite(destination, fs.readFileSync(payload), entry.mode);
    fs.chmodSync(destination, entry.mode);
  }
  for (const entry of directories.sort(
    (left, right) => right.path.split('/').length - left.path.split('/').length,
  )) {
    if (entry.mode === null) fail('snapshot-invalid', 'directory mode missing');
    fs.chmodSync(targetFor(entry), entry.mode);
  }
}

function rollbackRoot(
  operation: ActivationOperation,
  snapshot: SnapshotManifest,
  root: string,
  index: number,
): void {
  const target = path.resolve(operation.targetRoot, ...root.split('/'));
  if (!isProperlyWithin(operation.targetRoot, target)) {
    fail('path-escape', `rollback target escapes root: ${root}`);
  }
  const parent = path.dirname(target);
  assertNoSymlinkAncestors(operation.targetRoot, parent);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    fail('rollback-parent-missing', `rollback parent does not exist: ${parent}`);
  }
  const suffix = `${operation.operationId}-${index}`;
  const staging = path.join(parent, `.aspg-rollback-stage-${suffix}`);
  const displaced = path.join(parent, `.aspg-rollback-displaced-${suffix}`);
  if (!isProperlyWithin(operation.targetRoot, staging) || !isProperlyWithin(operation.targetRoot, displaced)) {
    fail('path-escape', 'rollback staging path escapes target root');
  }
  fs.rmSync(staging, { recursive: true, force: true });
  if (pathExists(displaced)) {
    fs.rmSync(displaced, { recursive: true, force: true });
  }
  const rootEntry = entryForRoot(snapshot, root);
  if (rootEntry.kind !== 'missing') {
    materializeSnapshotRoot(operation, snapshot, root, staging);
  }

  let displacedCurrent = false;
  try {
    if (pathExists(target)) {
      fs.renameSync(target, displaced);
      displacedCurrent = true;
    }
    if (rootEntry.kind !== 'missing') fs.renameSync(staging, target);
    fsyncDirectory(parent);
    fs.rmSync(displaced, { recursive: true, force: true });
    fsyncDirectory(parent);
  } catch (error) {
    if (
      displacedCurrent
      && !pathExists(target)
      && pathExists(displaced)
    ) {
      fs.renameSync(displaced, target);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function rollbackActivation(
  operation: ActivationOperation,
  errorCode: string | null = null,
): ActivationJournalEntry {
  const current = readActivationJournal(operation);
  if (current.phase === 'rolled-back') return current;
  if (current.phase === 'committed' || current.phase === 'failed') {
    fail('terminal-operation', `cannot roll back terminal phase ${current.phase}`);
  }
  assertCurrentLock(operation);
  if (!current.snapshot_path || !current.rollback_payload_path) {
    fail('snapshot-required', 'rollback requires a completed snapshot');
  }
  const withError = {
    ...current,
    error_code: errorCode,
    updated_at: operation.now(),
  };
  atomicWriteJson(operation.journalPath, withError);
  assertNoSymlinkAncestors(operation.stateRoot, operation.snapshotManifestPath);
  assertNoSymlinkAncestors(operation.stateRoot, operation.rollbackPayloadPath);
  const snapshot = parseSnapshot(
    readJson(operation.snapshotManifestPath, 'snapshot-invalid'),
  );
  assertSnapshotOwnership(operation, withError, snapshot);
  snapshot.roots.forEach((root, index) => rollbackRoot(operation, snapshot, root, index));
  const rolledBack: ActivationJournalEntry = {
    ...withError,
    phase: 'rolled-back',
    updated_at: operation.now(),
  };
  atomicWriteJson(operation.journalPath, rolledBack);
  writeSettledGeneration(operation, operation.expectedGeneration);
  releaseActivationLock(operation);
  return rolledBack;
}

function recordPlannedBlockingFailure(
  operation: ActivationOperation,
  errorCode: string,
): ActivationJournalEntry {
  const owner = parseOwner(readJson(operation.ownerPath, 'owner-invalid'));
  if (
    owner.operation_id !== operation.operationId
    || owner.portfolio !== operation.portfolio
    || owner.deployment !== operation.deployment
    || owner.project_ref !== operation.projectRef
  ) {
    fail('owner-identity-mismatch', 'planned operation owner does not match');
  }
  if (
    owner.created_by_pid !== process.pid
    && processIsAlive(owner.created_by_pid)
  ) {
    fail(
      'activation-owner-live',
      `planned activation owner process ${owner.created_by_pid} is alive`,
    );
  }
  const claim: LockOwner = {
    version: 1,
    operation_id: operation.operationId,
    portfolio: operation.portfolio,
    deployment: operation.deployment,
    generation: operation.expectedGeneration + 1,
    pid: process.pid,
    acquired_at: operation.now(),
  };
  writeExclusiveJson(operation.lockPath, claim);
  try {
    const current = readActivationJournal(operation);
    if (current.phase !== 'planned') {
      fail('phase-conflict', `planned failure claim observed ${current.phase}`);
    }
    const failed: ActivationJournalEntry = {
      ...current,
      phase: 'failed',
      error_code: errorCode,
      updated_at: operation.now(),
    };
    atomicWriteJson(operation.journalPath, failed);
    return failed;
  } finally {
    if (pathExists(operation.lockPath)) {
      const currentLock = parseLock(readJson(operation.lockPath, 'lock-invalid'));
      if (
        currentLock.operation_id === operation.operationId
        && currentLock.pid === process.pid
      ) {
        fs.rmSync(operation.lockPath);
        fsyncDirectory(path.dirname(operation.lockPath));
      }
    }
  }
}

export function recordActivationBlockingFailure(
  operation: ActivationOperation,
  errorCode: string,
): ActivationJournalEntry {
  validateIdentifier(errorCode, 'errorCode');
  const current = readActivationJournal(operation);
  if (current.phase === 'committed') {
    fail('terminal-operation', 'a committed activation cannot accept a blocking failure');
  }
  if (current.phase === 'rolled-back' || current.phase === 'failed') return current;
  if (current.snapshot_path) return rollbackActivation(operation, errorCode);
  if (current.phase === 'planned') {
    return recordPlannedBlockingFailure(operation, errorCode);
  }
  assertCurrentLock(operation);
  const failed: ActivationJournalEntry = {
    ...current,
    phase: 'failed',
    error_code: errorCode,
    updated_at: operation.now(),
  };
  atomicWriteJson(operation.journalPath, failed);
  writeSettledGeneration(operation, operation.expectedGeneration);
  releaseActivationLock(operation);
  return failed;
}

export function commitActivation(operation: ActivationOperation): ActivationJournalEntry {
  const committed = updateJournal(operation, (current) => {
    if (current.phase !== 'verified') {
      fail('phase-conflict', `commit requires verified, got ${current.phase}`);
    }
    return {
      ...current,
      phase: 'committed',
      updated_at: operation.now(),
    };
  });
  writeSettledGeneration(operation, committed.generation);
  releaseActivationLock(operation);
  return committed;
}

export function activationRecoveryAction(
  journal: ActivationJournalEntry,
): ActivationRecoveryAction {
  if (['committed', 'rolled-back', 'failed'].includes(journal.phase)) return 'none';
  if (journal.phase === 'planned' || journal.phase === 'locked') return 'resume';
  return 'rollback';
}
