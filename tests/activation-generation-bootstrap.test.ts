import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireActivationLock,
  advanceActivationPhase,
  bootstrapActivationGeneration,
  captureActivationSnapshot,
  commitActivation,
  createActivationOperation,
  readActivationJournal,
  recordActivationBlockingFailure,
  releaseActivationLock,
  rollbackActivation,
  type ActivationOperation,
} from '../src/activation-journal.js';

let fixtureRoot: string;
let projectRoot: string;
let targetRoot: string;
let portableStatePath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-generation-bootstrap-'));
  projectRoot = path.join(fixtureRoot, 'project');
  targetRoot = path.join(projectRoot, '.agents', 'skills');
  portableStatePath = path.join(
    projectRoot,
    '.aspg',
    'deployments',
    'work',
    'state.yaml',
  );
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.mkdirSync(path.dirname(portableStatePath), { recursive: true });
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // The child may already have exited.
      }
    }
  }
  children.length = 0;
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function portable(generation: number, projectRef = 'work-project') {
  return {
    portfolio: 'main',
    deployment: 'work',
    project_ref: projectRef,
    generation,
  };
}

function operation(
  stateRoot: string,
  operationId: string,
  expectedGeneration: number,
): ActivationOperation {
  return createActivationOperation({
    fixtureRoot,
    stateRoot,
    targetRoot: projectRoot,
    portableStatePath,
    portfolio: 'main',
    deployment: 'work',
    projectRef: 'work-project',
    deviceId: 'device-a',
    mutation: 'refresh',
    expectedGeneration,
    operationId,
    now: () => '2026-07-26T22:00:00.000Z',
  });
}

function replaceOwnerPid(value: ActivationOperation, pid: number): void {
  const owner = JSON.parse(fs.readFileSync(value.ownerPath, 'utf8'));
  owner.created_by_pid = pid;
  fs.writeFileSync(value.ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
}

function writeClaimedGeneration(value: ActivationOperation): void {
  fs.writeFileSync(value.generationPath, `${JSON.stringify({
    version: 1,
    portfolio: value.portfolio,
    deployment: value.deployment,
    project_ref: value.projectRef,
    generation: value.expectedGeneration + 1,
    operation_id: value.operationId,
  }, null, 2)}\n`);
}

function writeDeadTerminalLock(value: ActivationOperation): void {
  fs.mkdirSync(path.dirname(value.lockPath), { recursive: true });
  fs.writeFileSync(value.lockPath, `${JSON.stringify({
    version: 1,
    operation_id: value.operationId,
    portfolio: value.portfolio,
    deployment: value.deployment,
    generation: value.expectedGeneration + 1,
    pid: 999_999_999,
    acquired_at: '2026-07-26T22:00:00.000Z',
  }, null, 2)}\n`);
}

describe('device generation bootstrap and reconciliation', () => {
  it('bootstraps portable generation on an empty device and permits the next CAS', () => {
    const stateRoot = path.join(fixtureRoot, 'device-a');
    const result = bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(7),
    });

    expect(result).toMatchObject({
      status: 'bootstrapped',
      generation: 7,
      portfolio: 'main',
      deployment: 'work',
      project_ref: 'work-project',
    });
    expect(JSON.parse(fs.readFileSync(result.path, 'utf8'))).toEqual({
      version: 1,
      portfolio: 'main',
      deployment: 'work',
      project_ref: 'work-project',
      generation: 7,
      operation_id: null,
    });

    const next = operation(stateRoot, 'after-bootstrap', 7);
    expect(acquireActivationLock(next)).toMatchObject({
      phase: 'locked',
      generation: 8,
    });
    recordActivationBlockingFailure(next, 'fixture-stop');
  });

  it('bootstraps the same portable identity independently on multiple devices', () => {
    const first = bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot: path.join(fixtureRoot, 'device-a'),
      portable: portable(4),
    });
    const second = bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot: path.join(fixtureRoot, 'device-b'),
      portable: portable(4),
    });

    expect(first.status).toBe('bootstrapped');
    expect(second.status).toBe('bootstrapped');
    expect(first.path).not.toBe(second.path);
    expect(bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot: path.join(fixtureRoot, 'device-a'),
      portable: portable(4),
    }).status).toBe('in-sync');
  });

  it('refuses downgrade, forward conflict and portable identity conflict', () => {
    const stateRoot = path.join(fixtureRoot, 'device-a');
    bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(5),
    });

    expect(() => bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(4),
    })).toThrowError(expect.objectContaining({
      code: 'generation-bootstrap-downgrade',
    }));
    expect(() => bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(6),
    })).toThrowError(expect.objectContaining({
      code: 'generation-bootstrap-conflict',
    }));
    expect(() => bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(5, 'other-project'),
    })).toThrowError(expect.objectContaining({
      code: 'generation-bootstrap-identity-conflict',
    }));
  });

  it('refuses an active lock and an unlocked nonterminal operation', () => {
    const stateRoot = path.join(fixtureRoot, 'device-a');
    const value = operation(stateRoot, 'active-operation', 0);
    acquireActivationLock(value);

    expect(() => bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(1),
    })).toThrowError(expect.objectContaining({
      code: 'generation-bootstrap-active-lock',
    }));

    releaseActivationLock(value);
    expect(() => bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(1),
    })).toThrowError(expect.objectContaining({
      code: 'generation-bootstrap-nonterminal',
    }));
  });

  it('reconciles a committed crash claim and removes its dead terminal lock', () => {
    const stateRoot = path.join(fixtureRoot, 'device-a');
    const value = operation(stateRoot, 'committed-crash', 0);
    acquireActivationLock(value);
    captureActivationSnapshot(value, ['.agents/skills']);
    advanceActivationPhase(value, 'staged');
    advanceActivationPhase(value, 'activated');
    advanceActivationPhase(value, 'verified');
    commitActivation(value);
    writeClaimedGeneration(value);
    writeDeadTerminalLock(value);

    expect(bootstrapActivationGeneration({
      fixtureRoot,
      stateRoot,
      portable: portable(1),
    })).toMatchObject({
      status: 'bootstrapped',
      generation: 1,
    });
    expect(JSON.parse(fs.readFileSync(value.generationPath, 'utf8'))).toMatchObject({
      generation: 1,
      operation_id: null,
    });
    expect(fs.existsSync(value.lockPath)).toBe(false);
  });

  it('reconciles rolled-back and failed crash claims to the prior generation', () => {
    for (const terminal of ['rolled-back', 'failed'] as const) {
      const stateRoot = path.join(fixtureRoot, `device-${terminal}`);
      bootstrapActivationGeneration({
        fixtureRoot,
        stateRoot,
        portable: portable(3),
      });
      const value = operation(stateRoot, `${terminal}-crash`, 3);
      acquireActivationLock(value);
      if (terminal === 'rolled-back') {
        captureActivationSnapshot(value, ['.agents/skills']);
        advanceActivationPhase(value, 'staged');
        rollbackActivation(value, 'fixture-rollback');
      } else {
        recordActivationBlockingFailure(value, 'fixture-failure');
      }
      writeClaimedGeneration(value);

      expect(bootstrapActivationGeneration({
        fixtureRoot,
        stateRoot,
        portable: portable(3),
      })).toMatchObject({
        status: 'bootstrapped',
        generation: 3,
      });
      expect(JSON.parse(fs.readFileSync(value.generationPath, 'utf8'))).toMatchObject({
        generation: 3,
        operation_id: null,
      });
      expect(fs.existsSync(value.lockPath)).toBe(false);
    }
  });
});

describe('planned recovery claim', () => {
  it('refuses to fail a planned operation whose owner process is alive', () => {
    const stateRoot = path.join(fixtureRoot, 'device-a');
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { stdio: 'ignore' });
    children.push(child);
    expect(child.pid).toBeTypeOf('number');
    const value = operation(stateRoot, 'live-planned', 0);
    replaceOwnerPid(value, child.pid!);

    expect(() => recordActivationBlockingFailure(value, 'recovery-request'))
      .toThrowError(expect.objectContaining({ code: 'activation-owner-live' }));
    expect(readActivationJournal(value).phase).toBe('planned');
    expect(fs.existsSync(value.lockPath)).toBe(false);
  });

  it('claims and terminates an orphaned planned operation without advancing generation', () => {
    const stateRoot = path.join(fixtureRoot, 'device-a');
    const value = operation(stateRoot, 'orphaned-planned', 0);
    replaceOwnerPid(value, 999_999_999);

    expect(recordActivationBlockingFailure(value, 'recovery-request')).toMatchObject({
      phase: 'failed',
      error_code: 'recovery-request',
    });
    expect(fs.existsSync(value.lockPath)).toBe(false);
    expect(fs.existsSync(value.generationPath)).toBe(false);
  });
});
