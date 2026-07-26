import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ActivationJournalError,
  acquireActivationLock,
  activationRecoveryAction,
  advanceActivationPhase,
  captureActivationSnapshot,
  commitActivation,
  createActivationOperation,
  loadActivationOperation,
  readActivationJournal,
  recordActivationBlockingFailure,
  releaseActivationLock,
  resumeActivationLock,
  rollbackActivation,
  type ActivationOperation,
} from '../src/activation-journal.js';

let fixtureRoot: string;
let stateRoot: string;
let targetRoot: string;
let portableStatePath: string;
let sequence = 0;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-w6-recovery-'));
  stateRoot = path.join(fixtureRoot, 'device-state');
  targetRoot = path.join(fixtureRoot, 'project', '.agents', 'skills');
  portableStatePath = path.join(fixtureRoot, 'project', '.aspg', 'portfolio-state.json');
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.mkdirSync(path.dirname(portableStatePath), { recursive: true });
  sequence = 0;
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function operation(
  overrides: Partial<Parameters<typeof createActivationOperation>[0]> = {},
): ActivationOperation {
  sequence += 1;
  return createActivationOperation({
    fixtureRoot,
    stateRoot,
    targetRoot,
    portableStatePath,
    portfolio: 'portfolio-main',
    deployment: 'work-pkm',
    projectRef: 'work-pkm',
    deviceId: 'test-device',
    mutation: 'apply',
    expectedGeneration: 0,
    operationId: `operation-${sequence}`,
    now: () => '2026-07-26T20:00:00.000Z',
    ...overrides,
  });
}

function lockedOperation(
  overrides: Partial<Parameters<typeof createActivationOperation>[0]> = {},
): ActivationOperation {
  const value = operation(overrides);
  acquireActivationLock(value);
  return value;
}

function writeTarget(
  relative: string,
  content: string,
  mode = 0o644,
): string {
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode });
  fs.chmodSync(target, mode);
  return target;
}

function phaseTo(
  value: ActivationOperation,
  phase: 'staged' | 'activated' | 'verified',
): void {
  const current = readActivationJournal(value).phase;
  if (current === 'locked') captureActivationSnapshot(value, ['skill-a']);
  if (phase === 'staged') {
    advanceActivationPhase(value, 'staged');
    return;
  }
  if (readActivationJournal(value).phase === 'snapshotted') {
    advanceActivationPhase(value, 'staged');
  }
  if (phase === 'activated') {
    advanceActivationPhase(value, 'activated');
    return;
  }
  if (readActivationJournal(value).phase === 'staged') {
    advanceActivationPhase(value, 'activated');
  }
  advanceActivationPhase(value, 'verified');
}

describe('device-local activation journal', () => {
  it('persists every frozen phase and classifies interrupted recovery conservatively', () => {
    writeTarget('skill-a/SKILL.md', 'previous');
    const expected = [
      ['planned', 'resume'],
      ['locked', 'resume'],
      ['snapshotted', 'rollback'],
      ['staged', 'rollback'],
      ['activated', 'rollback'],
      ['verified', 'rollback'],
      ['committed', 'none'],
      ['rolled-back', 'none'],
      ['failed', 'none'],
    ] as const;

    for (const [phase, action] of expected) {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      sequence = 0;
      const value = operation();
      if (phase !== 'planned' && phase !== 'failed') acquireActivationLock(value);
      if (['snapshotted', 'staged', 'activated', 'verified', 'committed', 'rolled-back'].includes(phase)) {
        captureActivationSnapshot(value, ['skill-a']);
      }
      if (['staged', 'activated', 'verified', 'committed'].includes(phase)) {
        advanceActivationPhase(value, 'staged');
      }
      if (['activated', 'verified', 'committed'].includes(phase)) {
        advanceActivationPhase(value, 'activated');
      }
      if (['verified', 'committed'].includes(phase)) {
        advanceActivationPhase(value, 'verified');
      }
      if (phase === 'committed') commitActivation(value);
      if (phase === 'rolled-back') rollbackActivation(value);
      if (phase === 'failed') recordActivationBlockingFailure(value, 'dependency-missing');

      const reloaded = loadActivationOperation({
        fixtureRoot,
        stateRoot,
        operationId: value.operationId,
        now: () => '2026-07-26T20:01:00.000Z',
      });
      const journal = readActivationJournal(reloaded);
      expect(journal.phase).toBe(phase);
      expect(activationRecoveryAction(journal)).toBe(action);
      if (!['committed', 'rolled-back', 'failed', 'planned'].includes(phase)) {
        releaseActivationLock(value);
      }
    }
  });

  it('stores locks, journals and snapshots only below state_root', () => {
    writeTarget('skill-a/SKILL.md', 'previous');
    const value = lockedOperation();
    const journal = captureActivationSnapshot(value, ['skill-a']);

    expect(value.lockPath).toBe(
      path.join(fs.realpathSync(stateRoot), 'locks', 'portfolio-main-work-pkm.lock'),
    );
    for (const pathname of [
      value.ownerPath,
      value.journalPath,
      value.lockPath,
      value.generationPath,
      journal.snapshot_path!,
      journal.rollback_payload_path!,
    ]) {
      expect(path.relative(value.stateRoot, pathname)).not.toMatch(/^\.\./);
    }
    expect(path.relative(value.stateRoot, value.portableStatePath)).toMatch(/^\.\./);
    releaseActivationLock(value);
  });

  it('fails closed on a concurrent writer and releases a failed generation claim', () => {
    const first = lockedOperation({ operationId: 'first' });
    const concurrent = operation({ operationId: 'concurrent' });
    expect(() => acquireActivationLock(concurrent)).toThrowError(
      expect.objectContaining({ code: 'activation-lock-held' }),
    );
    recordActivationBlockingFailure(first, 'dependency-missing');

    expect(JSON.parse(fs.readFileSync(first.generationPath, 'utf8'))).toMatchObject({
      generation: 0,
      operation_id: null,
    });
    expect(acquireActivationLock(concurrent)).toMatchObject({
      phase: 'locked',
      generation: 1,
    });
    recordActivationBlockingFailure(concurrent, 'fixture-stop');
    expect(fs.existsSync(concurrent.lockPath)).toBe(false);
  });

  it('resumes an interrupted owned generation without incrementing it', () => {
    const value = lockedOperation();
    releaseActivationLock(value);
    const reloaded = loadActivationOperation({
      fixtureRoot,
      stateRoot,
      operationId: value.operationId,
    });
    expect(resumeActivationLock(reloaded).phase).toBe('locked');
    const generation = JSON.parse(fs.readFileSync(value.generationPath, 'utf8'));
    expect(generation.generation).toBe(1);
    releaseActivationLock(reloaded);
  });

  it('recovers the crash window after lock creation but before generation claim', () => {
    const value = operation();
    fs.mkdirSync(path.dirname(value.lockPath), { recursive: true });
    fs.writeFileSync(value.lockPath, `${JSON.stringify({
      version: 1,
      operation_id: value.operationId,
      portfolio: value.portfolio,
      deployment: value.deployment,
      generation: 1,
      pid: process.pid,
      acquired_at: '2026-07-26T20:00:00.000Z',
    })}\n`);

    expect(resumeActivationLock(value)).toMatchObject({
      phase: 'locked',
      generation: 1,
    });
    expect(JSON.parse(fs.readFileSync(value.generationPath, 'utf8'))).toMatchObject({
      generation: 1,
      operation_id: value.operationId,
    });
    releaseActivationLock(value);
  });

  it('clears an orphaned terminal lock before the next generation', () => {
    writeTarget('skill-a/SKILL.md', 'previous');
    const previous = lockedOperation({ operationId: 'previous-operation' });
    captureActivationSnapshot(previous, ['skill-a']);
    phaseTo(previous, 'verified');
    commitActivation(previous);
    fs.writeFileSync(previous.lockPath, `${JSON.stringify({
      version: 1,
      operation_id: previous.operationId,
      portfolio: previous.portfolio,
      deployment: previous.deployment,
      generation: 1,
      pid: 999999,
      acquired_at: '2026-07-26T20:00:00.000Z',
    })}\n`);

    const next = operation({
      operationId: 'next-operation',
      expectedGeneration: 1,
    });
    expect(acquireActivationLock(next)).toMatchObject({
      phase: 'locked',
      generation: 2,
    });
    expect(JSON.parse(fs.readFileSync(next.lockPath, 'utf8'))).toMatchObject({
      operation_id: next.operationId,
      generation: 2,
    });
    releaseActivationLock(next);
  });

  it('requires recovery instead of stealing an orphaned non-terminal lock', () => {
    const previous = lockedOperation({ operationId: 'interrupted-operation' });
    const stale = JSON.parse(fs.readFileSync(previous.lockPath, 'utf8'));
    stale.pid = 999999;
    fs.writeFileSync(previous.lockPath, `${JSON.stringify(stale)}\n`);
    const next = operation({ operationId: 'blocked-operation' });

    expect(() => acquireActivationLock(next)).toThrowError(
      expect.objectContaining({ code: 'activation-recovery-required' }),
    );

    stale.pid = process.pid;
    fs.writeFileSync(previous.lockPath, `${JSON.stringify(stale)}\n`);
    releaseActivationLock(previous);
  });

  it('refuses a live lock even when an attacker reuses the operation id', () => {
    const value = lockedOperation();
    const lock = JSON.parse(fs.readFileSync(value.lockPath, 'utf8'));
    lock.pid = process.pid;
    fs.writeFileSync(value.lockPath, `${JSON.stringify(lock)}\n`);
    expect(() => acquireActivationLock(value)).toThrowError(
      expect.objectContaining({ code: 'phase-conflict' }),
    );
    releaseActivationLock(value);
  });

  it('enforces strict forward phase transitions and verified-only commit', () => {
    writeTarget('skill-a/SKILL.md', 'previous');
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    expect(() => advanceActivationPhase(value, 'activated')).toThrowError(
      expect.objectContaining({ code: 'phase-conflict' }),
    );
    expect(() => commitActivation(value)).toThrowError(
      expect.objectContaining({ code: 'phase-conflict' }),
    );
    phaseTo(value, 'verified');
    expect(commitActivation(value).phase).toBe('committed');
    expect(fs.existsSync(value.lockPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(value.generationPath, 'utf8'))).toEqual({
      version: 1,
      portfolio: 'portfolio-main',
      deployment: 'work-pkm',
      project_ref: 'work-pkm',
      generation: 1,
      operation_id: null,
    });
  });
});

describe('snapshot and rollback', () => {
  it('restores file bytes, executable modes, directories and symlinks', () => {
    const script = writeTarget('skill-a/scripts/run.sh', '#!/bin/sh\necho old\n', 0o755);
    writeTarget('skill-a/SKILL.md', 'old skill', 0o640);
    const link = path.join(targetRoot, 'skill-a', 'current');
    fs.symlinkSync('scripts/run.sh', link);
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    advanceActivationPhase(value, 'staged');

    fs.writeFileSync(script, 'new bytes');
    fs.chmodSync(script, 0o600);
    fs.unlinkSync(link);
    fs.symlinkSync('SKILL.md', link);
    writeTarget('skill-a/new.txt', 'partial');
    advanceActivationPhase(value, 'activated');

    const result = rollbackActivation(value, 'dependency-content-drift');
    expect(result).toMatchObject({
      phase: 'rolled-back',
      error_code: 'dependency-content-drift',
    });
    expect(fs.readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho old\n');
    expect(fs.statSync(script).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(targetRoot, 'skill-a', 'SKILL.md')).mode & 0o777)
      .toBe(0o640);
    expect(fs.readlinkSync(link)).toBe('scripts/run.sh');
    expect(fs.existsSync(path.join(targetRoot, 'skill-a', 'new.txt'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(value.generationPath, 'utf8'))).toEqual({
      version: 1,
      portfolio: 'portfolio-main',
      deployment: 'work-pkm',
      project_ref: 'work-pkm',
      generation: 0,
      operation_id: null,
    });
    expect(fs.existsSync(value.lockPath)).toBe(false);
  });

  it('restores an originally missing target by removing partial activation', () => {
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    advanceActivationPhase(value, 'staged');
    writeTarget('skill-a/SKILL.md', 'partial');
    advanceActivationPhase(value, 'activated');

    rollbackActivation(value, 'verification-failed');
    expect(fs.existsSync(path.join(targetRoot, 'skill-a'))).toBe(false);
  });

  it('is idempotent after a successful rollback', () => {
    writeTarget('skill-a/SKILL.md', 'old');
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    advanceActivationPhase(value, 'staged');
    writeTarget('skill-a/SKILL.md', 'new');
    advanceActivationPhase(value, 'activated');

    const first = rollbackActivation(value, 'dependency-content-drift');
    const firstBytes = fs.readFileSync(path.join(targetRoot, 'skill-a', 'SKILL.md'));
    const second = rollbackActivation(value, 'different-error');
    expect(second).toEqual(first);
    expect(fs.readFileSync(path.join(targetRoot, 'skill-a', 'SKILL.md')))
      .toEqual(firstBytes);
  });

  it('rejects overlapping snapshot roots and traversal paths', () => {
    writeTarget('skill-a/SKILL.md', 'old');
    const value = lockedOperation();
    expect(() => captureActivationSnapshot(value, ['skill-a', 'skill-a/SKILL.md']))
      .toThrowError(expect.objectContaining({ code: 'snapshot-root-overlap' }));
    expect(() => captureActivationSnapshot(value, ['../outside']))
      .toThrowError(expect.objectContaining({ code: 'invalid-target-path' }));
    expect(() => captureActivationSnapshot(value, ['/tmp/outside']))
      .toThrowError(expect.objectContaining({ code: 'invalid-target-path' }));
    releaseActivationLock(value);
  });

  it('fails closed if rollback payload storage is replaced by a symlink', () => {
    writeTarget('skill-a/SKILL.md', 'old');
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    advanceActivationPhase(value, 'staged');
    writeTarget('skill-a/SKILL.md', 'new');
    advanceActivationPhase(value, 'activated');

    const originalPayload = `${value.rollbackPayloadPath}-original`;
    const hostilePayload = path.join(fixtureRoot, 'hostile-payload');
    fs.renameSync(value.rollbackPayloadPath, originalPayload);
    fs.mkdirSync(hostilePayload);
    fs.symlinkSync(hostilePayload, value.rollbackPayloadPath, 'dir');

    expect(() => rollbackActivation(value, 'verification-failed')).toThrowError(
      expect.objectContaining({ code: 'symlink-ancestor' }),
    );
    expect(fs.readFileSync(path.join(targetRoot, 'skill-a', 'SKILL.md'), 'utf8'))
      .toBe('new');
    releaseActivationLock(value);
  });
});

describe('required dependency blocking failures', () => {
  it('required dependency missing before activation produces zero target mutation', () => {
    const before = fs.readdirSync(targetRoot);
    const value = lockedOperation();
    const journal = recordActivationBlockingFailure(value, 'required-dependency-missing');
    expect(journal).toMatchObject({
      phase: 'failed',
      error_code: 'required-dependency-missing',
      snapshot_path: null,
    });
    expect(fs.readdirSync(targetRoot)).toEqual(before);
    expect(fs.existsSync(value.lockPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(value.generationPath, 'utf8'))).toEqual({
      version: 1,
      portfolio: 'portfolio-main',
      deployment: 'work-pkm',
      project_ref: 'work-pkm',
      generation: 0,
      operation_id: null,
    });
  });

  it('dependency content drift in verification does not commit and restores target', () => {
    writeTarget('skill-a/SKILL.md', 'previous');
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    advanceActivationPhase(value, 'staged');
    writeTarget('skill-a/SKILL.md', 'candidate');
    advanceActivationPhase(value, 'activated');

    const journal = recordActivationBlockingFailure(
      value,
      'required-dependency-content-drift',
    );
    expect(journal.phase).toBe('rolled-back');
    expect(journal.phase).not.toBe('committed');
    expect(fs.readFileSync(path.join(targetRoot, 'skill-a', 'SKILL.md'), 'utf8'))
      .toBe('previous');
  });

  it('dependency executable-mode drift restores the exact previous mode', () => {
    const script = writeTarget('skill-a/run.sh', 'echo previous\n', 0o755);
    const value = lockedOperation();
    captureActivationSnapshot(value, ['skill-a']);
    advanceActivationPhase(value, 'staged');
    fs.chmodSync(script, 0o644);
    advanceActivationPhase(value, 'activated');

    const journal = recordActivationBlockingFailure(
      value,
      'required-dependency-mode-drift',
    );
    expect(journal.phase).toBe('rolled-back');
    expect(fs.statSync(script).mode & 0o777).toBe(0o755);
  });
});

describe('fixture and ownership guards', () => {
  it('rejects non-TMPDIR fixture roots and all implicit or overlapping paths', () => {
    expect(() => operation({ fixtureRoot: path.dirname(os.tmpdir()) }))
      .toThrowError(expect.objectContaining({ code: 'non-fixture-root' }));
    expect(() => operation({ stateRoot: targetRoot }))
      .toThrowError(expect.objectContaining({ code: 'state-root-overlap' }));
    expect(() => operation({ portableStatePath: path.join(stateRoot, 'portable.json') }))
      .toThrowError(expect.objectContaining({ code: 'state-root-overlap' }));
    expect(() => operation({ stateRoot: 'relative/state' }))
      .toThrowError(expect.objectContaining({ code: 'path-not-absolute' }));
  });

  it('rejects symlink escapes below an otherwise valid fixture', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-w6-outside-'));
    const alias = path.join(fixtureRoot, 'alias');
    fs.symlinkSync(outside, alias, 'dir');
    expect(() => operation({ stateRoot: path.join(alias, 'state') }))
      .toThrowError(expect.objectContaining({ code: 'fixture-path-escape' }));
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects operation-id collisions and tampered journal ownership', () => {
    const value = operation({ operationId: 'owned-operation' });
    expect(() => operation({ operationId: 'owned-operation' }))
      .toThrowError(expect.objectContaining({ code: 'operation-id-collision' }));
    const journal = JSON.parse(fs.readFileSync(value.journalPath, 'utf8'));
    journal.deployment = 'other';
    fs.writeFileSync(value.journalPath, `${JSON.stringify(journal)}\n`);
    expect(() => readActivationJournal(value)).toThrowError(
      expect.objectContaining({ code: 'journal-ownership-mismatch' }),
    );
  });
});
