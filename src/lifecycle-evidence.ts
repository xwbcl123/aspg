import type {
  AdoptionScope,
  AdoptionStage,
  Evidence,
  LearningLevel,
  LifecycleProfile,
} from './lifecycle-schema.js';

export type EvidenceResolutionStatus =
  | 'not-requested'
  | 'resolved'
  | 'unresolved'
  | 'missing';

export type EvidenceGateVerification = 'verified' | 'unverified' | 'failed';

export interface EvidenceGateResult {
  gate: string;
  scope?: {
    project: string;
    stage: AdoptionStage;
    devices: string[];
    workflows: string[];
  };
  satisfied: boolean;
  verification: EvidenceGateVerification;
  missing: string[];
  unverified: string[];
}

export type EvidenceResolutionLookup = (evidence: Evidence) => EvidenceResolutionStatus;

const LEARNING_LEVELS: LearningLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

const KIND_ALIASES: Record<string, string[]> = {
  reproduction: ['reproduction', 'reproduce', 'operated-case'],
  'structure-analysis': ['structure-analysis', 'architecture-analysis', 'architecture-review'],
  'limitations-analysis': ['limitations-analysis', 'architecture-analysis', 'architecture-review'],
  'failure-mode-analysis': ['failure-mode-analysis', 'architecture-analysis', 'architecture-review'],
  adaptation: ['adaptation', 'wrapper', 'fork', 'configuration', 'patch'],
  validation: ['validation', 'adaptation-validation', 'test'],
  'real-case': ['real-case', 'production-case'],
  'human-review': ['human-review'],
  fallback: ['fallback', 'fallback-policy'],
  'derived-asset': ['derived-asset', 'derived-skill', 'pattern', 'framework', 'tutorial'],
  'trust-screen': ['trust-screen', 'security-screen', 'source-review'],
  'baseline-case': ['baseline-case', 'reproduction'],
  'workflow-dependency': ['workflow-dependency'],
  'revalidation-policy': ['revalidation-policy'],
};

function aliases(required: string): string[] {
  return KIND_ALIASES[required] ?? [required];
}

function evidenceForKind(evidence: Evidence[], required: string): Evidence[] {
  const accepted = aliases(required);
  return evidence.filter((item) => accepted.includes(item.kind.toLowerCase()));
}

function evaluateRequirements(
  evidence: Evidence[],
  required: string[],
  resolution: EvidenceResolutionLookup,
): Pick<EvidenceGateResult, 'satisfied' | 'verification' | 'missing' | 'unverified'> {
  const missing: string[] = [];
  const unverified: string[] = [];

  for (const requirement of required) {
    const candidates = evidenceForKind(evidence, requirement);
    if (candidates.some((candidate) => resolution(candidate) === 'resolved')) continue;
    if (
      candidates.some((candidate) =>
        ['not-requested', 'unresolved'].includes(resolution(candidate)))
    ) {
      unverified.push(requirement);
    } else {
      missing.push(requirement);
    }
  }

  const verification: EvidenceGateVerification = missing.length > 0
    ? 'failed'
    : unverified.length > 0
      ? 'unverified'
      : 'verified';
  return {
    satisfied: verification === 'verified',
    verification,
    missing,
    unverified,
  };
}

function learningRequirements(level: LearningLevel): string[] {
  switch (level) {
    case 'L0':
      return [];
    case 'L1':
      return ['reproduction'];
    case 'L2':
      return ['structure-analysis', 'limitations-analysis', 'failure-mode-analysis'];
    case 'L3':
      return ['adaptation', 'validation'];
    case 'L4':
      return ['real-case', 'human-review', 'fallback'];
    case 'L5':
      return ['derived-asset'];
  }
}

function adoptionRequirements(stage: AdoptionStage): string[] {
  switch (stage) {
    case 'pilot':
      return ['trust-screen', 'baseline-case'];
    case 'production':
      return ['real-case', 'human-review', 'fallback'];
    case 'embedded':
      return [
        'real-case',
        'human-review',
        'fallback',
        'workflow-dependency',
        'revalidation-policy',
      ];
    default:
      return [];
  }
}

function scopeGate(
  scope: AdoptionScope,
  resolution: EvidenceResolutionLookup,
): EvidenceGateResult | undefined {
  const required = adoptionRequirements(scope.stage);
  if (required.length === 0) return undefined;
  const result = evaluateRequirements(scope.evidence, required, resolution);
  if (scope.stage === 'embedded' && scope.workflows.length === 0) {
    result.missing.push('named-workflow');
    result.satisfied = false;
    result.verification = 'failed';
  }
  return {
    gate: scope.stage,
    scope: {
      project: scope.project,
      stage: scope.stage,
      devices: [...scope.devices].sort(),
      workflows: [...scope.workflows].sort(),
    },
    ...result,
  };
}

export function evaluateEvidenceGates(
  profile: LifecycleProfile,
  resolution: EvidenceResolutionLookup = () => 'resolved',
): EvidenceGateResult[] {
  const gates: EvidenceGateResult[] = [];
  const currentIndex = LEARNING_LEVELS.indexOf(profile.learning.current_level);

  for (let index = 1; index <= currentIndex; index += 1) {
    const level = LEARNING_LEVELS[index];
    const result = evaluateRequirements(
      profile.learning.evidence,
      learningRequirements(level),
      resolution,
    );
    if (
      level === 'L4'
      && !profile.adoption.scopes.some((scope) => scope.workflows.length > 0)
    ) {
      result.missing.push('named-workflow');
      result.satisfied = false;
      result.verification = 'failed';
    }
    gates.push({ gate: level, ...result });
  }

  for (const scope of [...profile.adoption.scopes].sort(scopeSort)) {
    const gate = scopeGate(scope, resolution);
    if (gate) gates.push(gate);
  }
  return gates;
}

function scopeSort(a: AdoptionScope, b: AdoptionScope): number {
  return [
    a.project,
    a.stage,
    [...a.devices].sort().join(','),
    [...a.workflows].sort().join(','),
  ].join('\0').localeCompare([
    b.project,
    b.stage,
    [...b.devices].sort().join(','),
    [...b.workflows].sort().join(','),
  ].join('\0'));
}

export function missingEvidence(gates: EvidenceGateResult[]): string[] {
  return gates
    .flatMap((gate) => gate.missing.map((item) => {
      const scope = gate.scope ? `:${gate.scope.project}` : '';
      return `${gate.gate}${scope}:${item}`;
    }))
    .sort();
}

export function unverifiedEvidence(gates: EvidenceGateResult[]): string[] {
  return gates
    .flatMap((gate) => gate.unverified.map((item) => {
      const scope = gate.scope ? `:${gate.scope.project}` : '';
      return `${gate.gate}${scope}:${item}`;
    }))
    .sort();
}

export function missingTargetEvidence(
  profile: LifecycleProfile,
  resolution: EvidenceResolutionLookup = () => 'resolved',
): string[] {
  const currentIndex = LEARNING_LEVELS.indexOf(profile.learning.current_level);
  const targetIndex = LEARNING_LEVELS.indexOf(profile.learning.target_level);
  if (targetIndex <= currentIndex) return [];

  const missing: string[] = [];
  for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
    const level = LEARNING_LEVELS[index];
    const result = evaluateRequirements(
      profile.learning.evidence,
      learningRequirements(level),
      resolution,
    );
    missing.push(
      ...result.missing.map((item) => `${level}:${item}`),
      ...result.unverified.map((item) => `${level}:${item}:unverified`),
    );
    if (
      level === 'L4'
      && !profile.adoption.scopes.some((scope) => scope.workflows.length > 0)
    ) {
      missing.push('L4:named-workflow');
    }
  }
  return missing.sort();
}

export function deriveAggregateAdoption(scopes: AdoptionScope[]): AdoptionStage {
  const active: AdoptionStage[] = ['embedded', 'production', 'pilot', 'sandbox'];
  for (const stage of active) {
    if (scopes.some((scope) => scope.stage === stage)) return stage;
  }
  if (scopes.some((scope) => scope.stage === 'suspended')) return 'suspended';
  if (scopes.some((scope) => scope.stage === 'retired')) return 'retired';
  return 'none';
}
