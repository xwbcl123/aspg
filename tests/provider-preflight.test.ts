import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightProvider } from '../src/provider-preflight.js';

let fixtureRoot: string;
let runtimeRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-provider-preflight-'));
  runtimeRoot = path.join(fixtureRoot, 'looks-like-GoogleDrive', '.agents', 'skills');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'sentinel.txt'), 'unchanged\n');
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function local() {
  return preflightProvider({
    fixture_root: fixtureRoot,
    runtime_root: runtimeRoot,
    storage_provider: 'local-filesystem',
    deployment_backend: 'managed-materialized',
  });
}

function google(
  status: 'online' | 'offline' | 'uncertain' | 'conflict',
  hydrated = true,
  writable = true,
) {
  return preflightProvider({
    fixture_root: fixtureRoot,
    runtime_root: runtimeRoot,
    storage_provider: 'google-drive-file-provider',
    deployment_backend: 'managed-materialized',
    google_drive: { status, hydrated, writable },
  });
}

describe('Wave 6 provider preflight', () => {
  it('uses the explicit runtime-root provider instead of guessing from path names', () => {
    expect(local()).toEqual({
      provider: 'local-filesystem',
      runtime_root: path.resolve(runtimeRoot),
      status: 'ready',
      hydrated: true,
      writable: true,
      reason: null,
    });
    expect(google('online')).toEqual({
      provider: 'google-drive-file-provider',
      runtime_root: path.resolve(runtimeRoot),
      status: 'ready',
      hydrated: true,
      writable: true,
      reason: null,
    });
  });

  it('maps provider observations to stable offline, uncertain and conflict states', () => {
    expect(google('offline')).toMatchObject({
      status: 'offline',
      hydrated: true,
      writable: false,
    });
    expect(google('uncertain')).toMatchObject({
      status: 'uncertain',
      writable: false,
    });
    expect(google('conflict')).toMatchObject({
      status: 'conflict',
      writable: false,
    });
    expect(google('online', false)).toMatchObject({
      status: 'uncertain',
      hydrated: false,
      writable: false,
    });
    expect(google('online', true, false)).toMatchObject({
      status: 'conflict',
      hydrated: true,
      writable: false,
    });
    expect(preflightProvider({
      fixture_root: fixtureRoot,
      runtime_root: runtimeRoot,
      storage_provider: 'google-drive-file-provider',
      deployment_backend: 'managed-materialized',
    })).toMatchObject({
      status: 'uncertain',
      hydrated: false,
      writable: false,
    });
  });

  it('fails closed for unavailable roots, backend conflicts and real-runtime paths', () => {
    expect(preflightProvider({
      fixture_root: fixtureRoot,
      runtime_root: path.join(fixtureRoot, 'missing'),
      storage_provider: 'local-filesystem',
      deployment_backend: 'managed-materialized',
    })).toMatchObject({
      status: 'offline',
      hydrated: false,
      writable: false,
    });
    expect(preflightProvider({
      fixture_root: fixtureRoot,
      runtime_root: runtimeRoot,
      storage_provider: 'google-drive-file-provider',
      deployment_backend: 'managed-link',
      google_drive: { status: 'online', hydrated: true, writable: true },
    })).toMatchObject({
      status: 'conflict',
      hydrated: false,
      writable: false,
    });
    expect(preflightProvider({
      fixture_root: fixtureRoot,
      runtime_root: os.homedir(),
      storage_provider: 'local-filesystem',
      deployment_backend: 'managed-materialized',
    })).toMatchObject({
      status: 'conflict',
      hydrated: false,
      writable: false,
    });
  });

  it('performs zero writes for every non-ready provider state', () => {
    const before = fs.readFileSync(path.join(runtimeRoot, 'sentinel.txt'), 'utf8');
    const beforeEntries = fs.readdirSync(runtimeRoot);
    for (const result of [
      google('offline'),
      google('uncertain'),
      google('conflict'),
      google('online', false),
      google('online', true, false),
    ]) {
      expect(result.status).not.toBe('ready');
    }
    expect(fs.readFileSync(path.join(runtimeRoot, 'sentinel.txt'), 'utf8')).toBe(before);
    expect(fs.readdirSync(runtimeRoot)).toEqual(beforeEntries);
  });
});
