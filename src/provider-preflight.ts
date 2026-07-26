/**
 * Read-only provider preflight for Wave 6 managed materialization.
 *
 * Provider identity comes exclusively from the Device Registry runtime-root
 * entry. Paths and provider names are never inferred from one another.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PortfolioDeploymentBackend,
  ProviderPreflight,
} from './portfolio-runtime-types.js';

export interface GoogleDriveProviderObservation {
  status: 'online' | 'offline' | 'uncertain' | 'conflict';
  hydrated: boolean;
  writable: boolean;
  reason?: string;
}

export interface ProviderPreflightRequest {
  fixture_root: string;
  runtime_root: string;
  storage_provider: ProviderPreflight['provider'];
  deployment_backend: PortfolioDeploymentBackend;
  google_drive?: GoogleDriveProviderObservation;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWithExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`path has no existing ancestor: ${candidate}`);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function fixturePathReason(fixtureRootInput: string, candidateInput: string): string | null {
  let fixtureRoot: string;
  let temporaryRoot: string;
  try {
    fixtureRoot = fs.realpathSync(fixtureRootInput);
    temporaryRoot = fs.realpathSync(os.tmpdir());
  } catch {
    return 'fixture root is unavailable';
  }
  if (!fs.statSync(fixtureRoot).isDirectory()) return 'fixture root is not a directory';
  if (fixtureRoot === temporaryRoot || !isWithin(temporaryRoot, fixtureRoot)) {
    return 'fixture root must be an explicit child of the system temporary directory';
  }
  try {
    const candidate = resolveWithExistingAncestor(candidateInput);
    if (!isWithin(fixtureRoot, candidate)) {
      return 'runtime root escapes the explicit fixture root';
    }
  } catch {
    return 'runtime root cannot be resolved safely';
  }
  return null;
}

function runtimeRootState(runtimeRoot: string): {
  exists: boolean;
  directory: boolean;
  writable: boolean;
} {
  try {
    const stat = fs.statSync(runtimeRoot);
    if (!stat.isDirectory()) {
      return { exists: true, directory: false, writable: false };
    }
    try {
      fs.accessSync(runtimeRoot, fs.constants.W_OK);
      return { exists: true, directory: true, writable: true };
    } catch {
      return { exists: true, directory: true, writable: false };
    }
  } catch {
    return { exists: false, directory: false, writable: false };
  }
}

function result(
  request: ProviderPreflightRequest,
  status: ProviderPreflight['status'],
  hydrated: boolean,
  writable: boolean,
  reason: string | null,
): ProviderPreflight {
  return {
    provider: request.storage_provider,
    runtime_root: path.resolve(request.runtime_root),
    status,
    hydrated,
    writable,
    reason,
  };
}

export function preflightProvider(
  request: ProviderPreflightRequest,
): ProviderPreflight {
  const unsafeReason = fixturePathReason(request.fixture_root, request.runtime_root);
  if (unsafeReason) return result(request, 'conflict', false, false, unsafeReason);

  if (request.deployment_backend !== 'managed-materialized') {
    return result(
      request,
      'conflict',
      false,
      false,
      'provider materialization requires managed-materialized backend',
    );
  }

  const runtime = runtimeRootState(request.runtime_root);
  if (!runtime.exists) {
    return result(request, 'offline', false, false, 'runtime root is unavailable');
  }
  if (!runtime.directory) {
    return result(request, 'conflict', false, false, 'runtime root is not a directory');
  }

  if (request.storage_provider === 'local-filesystem') {
    return runtime.writable
      ? result(request, 'ready', true, true, null)
      : result(request, 'conflict', true, false, 'runtime root is not writable');
  }

  const observation = request.google_drive;
  if (!observation) {
    return result(
      request,
      'uncertain',
      false,
      false,
      'google drive provider state was not supplied',
    );
  }
  if (observation.status === 'offline') {
    return result(
      request,
      'offline',
      observation.hydrated,
      false,
      observation.reason ?? 'google drive provider is offline',
    );
  }
  if (observation.status === 'uncertain') {
    return result(
      request,
      'uncertain',
      observation.hydrated,
      false,
      observation.reason ?? 'google drive provider state is uncertain',
    );
  }
  if (observation.status === 'conflict') {
    return result(
      request,
      'conflict',
      observation.hydrated,
      false,
      observation.reason ?? 'google drive provider reports a conflict',
    );
  }
  if (!observation.hydrated) {
    return result(
      request,
      'uncertain',
      false,
      false,
      observation.reason ?? 'google drive content is not hydrated',
    );
  }
  const writable = runtime.writable && observation.writable;
  return writable
    ? result(request, 'ready', true, true, null)
    : result(
      request,
      'conflict',
      true,
      false,
      observation.reason ?? 'google drive runtime root is not writable',
    );
}
