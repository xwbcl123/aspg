/**
 * Frozen Wave 6 runtime interfaces.
 *
 * These types deliberately contain no filesystem mutation. Parallel Wave 6
 * modules share this contract; orchestration and CLI wiring remain owned by
 * the primary integration package.
 */

export const PORTFOLIO_HEALTH_STATES = [
  'in-sync',
  'refresh-available',
  'local-drift',
  'missing',
  'unmanaged-copy',
  'source-unavailable',
  'provider-offline',
  'provider-uncertain',
  'provider-conflict',
  'mode-drift',
  'transition-incomplete',
  'derived-content',
  'unmanaged-content',
] as const;

export type PortfolioHealth = (typeof PORTFOLIO_HEALTH_STATES)[number];

export type PortfolioDeploymentBackend = 'managed-link' | 'managed-materialized';

export type PortfolioMutationKind = 'apply' | 'refresh' | 'repair' | 'rollback';

export const ACTIVATION_PHASES = [
  'planned',
  'locked',
  'snapshotted',
  'staged',
  'activated',
  'verified',
  'committed',
  'rolled-back',
  'failed',
] as const;

export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];

export interface LockedContentIdentity {
  source: string;
  source_revision: string;
  path: string;
  tree_hash: string;
  executable_files: string[];
}

export interface ProjectedDataDependency extends LockedContentIdentity {
  id: string;
  privacy: 'work-private';
  target: string;
  required: boolean;
}

export interface DeploymentEntryState extends LockedContentIdentity {
  skill_id: string;
  exposure_name: string;
  target: string;
  backend: PortfolioDeploymentBackend;
  health: PortfolioHealth;
  dependencies: ProjectedDataDependency[];
}

/**
 * Portable state may be synchronized with a project. It contains identities,
 * hashes and device-neutral deployment intent, but never rollback payloads,
 * device locks or absolute source paths.
 */
export interface PortableDeploymentState {
  version: 1;
  portfolio: string;
  deployment: string;
  project_ref: string;
  lock_revision: string;
  generation: number;
  entries: DeploymentEntryState[];
  updated_at: string;
}

export interface ActivationJournalEntry {
  version: 1;
  operation_id: string;
  portfolio: string;
  deployment: string;
  project_ref: string;
  device_id: string;
  generation: number;
  mutation: PortfolioMutationKind;
  phase: ActivationPhase;
  target_root: string;
  portable_state_path: string;
  snapshot_path: string | null;
  rollback_payload_path: string | null;
  started_at: string;
  updated_at: string;
  error_code: string | null;
}

export interface ProviderPreflight {
  provider: 'local-filesystem' | 'google-drive-file-provider';
  runtime_root: string;
  status: 'ready' | 'offline' | 'uncertain' | 'conflict';
  hydrated: boolean;
  writable: boolean;
  reason: string | null;
}

export function isTerminalActivationPhase(phase: ActivationPhase): boolean {
  return phase === 'committed' || phase === 'rolled-back' || phase === 'failed';
}
