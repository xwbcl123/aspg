/**
 * Deterministic Portfolio document migration boundary.
 *
 * Device Registry v2 is additive: the v1 schema remains the active Portfolio
 * reader until Wave 6. This module only transforms in-memory documents and
 * never touches project or runtime paths.
 */
import {
  PortfolioDeviceRegistrySchema,
  PortfolioDeviceRegistryV2Schema,
  type PortfolioDeviceRegistryV2,
} from './portfolio-schema.js';

export type PortfolioDocumentKind =
  | 'manifest'
  | 'lock'
  | 'project-binding'
  | 'device-registry';

function cloneDocument(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function assertDeclaredVersion(value: unknown, fromVersion: number): void {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (value as { version?: unknown }).version !== fromVersion
  ) {
    throw new Error(`document version does not match declared source version ${fromVersion}`);
  }
}

function sortedRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * v1 cannot identify storage provider or backend at runtime-root granularity.
 * Guessing from an absolute path would make a Google Drive root unsafe.
 * Therefore the pure migration retains the unambiguous device/source/state
 * data and emits no runtime roots. Operators must add explicit v2 runtime-root
 * policy before activation.
 */
export function migrateDeviceRegistryV1ToV2(value: unknown): PortfolioDeviceRegistryV2 {
  const registry = PortfolioDeviceRegistrySchema.parse(value);
  const devices = Object.fromEntries(
    Object.entries(registry.devices)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([deviceId, device]) => [
        deviceId,
        {
          platform: device.platform,
          state_root: device.state_root,
          source_roots: sortedRecord(device.source_roots),
          runtime_roots: {},
        },
      ]),
  );
  return PortfolioDeviceRegistryV2Schema.parse({
    version: 2,
    devices,
  });
}

export function migratePortfolioDocument(
  kind: PortfolioDocumentKind,
  value: unknown,
  fromVersion: number,
  toVersion: number,
): unknown {
  assertDeclaredVersion(value, fromVersion);

  if (fromVersion === 1 && toVersion === 1) {
    return cloneDocument(value);
  }
  if (kind === 'device-registry' && fromVersion === 1 && toVersion === 2) {
    return migrateDeviceRegistryV1ToV2(value);
  }
  if (kind === 'device-registry' && fromVersion === 2 && toVersion === 2) {
    return PortfolioDeviceRegistryV2Schema.parse(value);
  }

  throw new Error(
    `unsupported ${kind} migration ${fromVersion} -> ${toVersion}; `
    + 'an explicit tested migrator is required',
  );
}
