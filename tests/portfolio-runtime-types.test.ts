import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ACTIVATION_PHASES,
  PORTFOLIO_HEALTH_STATES,
  isTerminalActivationPhase,
  type ActivationJournalEntry,
  type DeploymentEntryState,
  type PortfolioDeploymentBackend,
  type PortfolioHealth,
  type PortfolioMutationKind,
  type PortableDeploymentState,
  type ProjectedDataDependency,
  type ProviderPreflight,
} from '../src/portfolio-runtime-types.js';

describe('frozen Portfolio runtime interfaces', () => {
  it('keeps the 13 health states in their exact contract order', () => {
    expect(PORTFOLIO_HEALTH_STATES).toEqual([
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
    ]);
    expect(PORTFOLIO_HEALTH_STATES).toHaveLength(13);
    expectTypeOf<(typeof PORTFOLIO_HEALTH_STATES)[number]>()
      .toEqualTypeOf<PortfolioHealth>();
  });

  it('keeps activation phases ordered and terminal phases explicit', () => {
    expect(ACTIVATION_PHASES).toEqual([
      'planned',
      'locked',
      'snapshotted',
      'staged',
      'activated',
      'verified',
      'committed',
      'rolled-back',
      'failed',
    ]);
    expect(
      ACTIVATION_PHASES.filter(isTerminalActivationPhase),
    ).toEqual(['committed', 'rolled-back', 'failed']);
  });

  it('preserves backend, mutation, privacy, provider and version invariants', () => {
    expectTypeOf<PortfolioDeploymentBackend>()
      .toEqualTypeOf<'managed-link' | 'managed-materialized'>();
    expectTypeOf<DeploymentEntryState['backend']>()
      .toEqualTypeOf<PortfolioDeploymentBackend>();
    expectTypeOf<PortfolioMutationKind>()
      .toEqualTypeOf<'apply' | 'refresh' | 'repair' | 'rollback'>();
    expectTypeOf<ProjectedDataDependency['privacy']>()
      .toEqualTypeOf<'work-private'>();
    expectTypeOf<ProviderPreflight['provider']>()
      .toEqualTypeOf<'local-filesystem' | 'google-drive-file-provider'>();
    expectTypeOf<ProviderPreflight['status']>()
      .toEqualTypeOf<'ready' | 'offline' | 'uncertain' | 'conflict'>();
    expectTypeOf<PortableDeploymentState['version']>().toEqualTypeOf<1>();
    expectTypeOf<ActivationJournalEntry['version']>().toEqualTypeOf<1>();
  });
});
