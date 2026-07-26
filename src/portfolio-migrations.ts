/**
 * Deterministic Portfolio document migration boundary.
 *
 * v1 has no predecessor. Identity migration is exposed so future upgrades have
 * one tested dispatch point instead of silently accepting a future schema.
 */
export type PortfolioDocumentKind =
  | 'manifest'
  | 'lock'
  | 'project-binding'
  | 'device-registry';

export function migratePortfolioDocument(
  kind: PortfolioDocumentKind,
  value: unknown,
  fromVersion: number,
  toVersion: number,
): unknown {
  if (fromVersion !== 1 || toVersion !== 1) {
    throw new Error(
      `unsupported ${kind} migration ${fromVersion} -> ${toVersion}; `
      + 'an explicit tested migrator is required',
    );
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}
