import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import {
  LifecycleProfileSchema,
  PortableDateSchema,
  type AdoptionScope,
  type Evidence,
  type LifecycleProfile,
} from './lifecycle-schema.js';
import {
  deriveAggregateAdoption,
  evaluateEvidenceGates,
  missingEvidence,
  missingTargetEvidence,
  unverifiedEvidence,
  type EvidenceGateResult,
  type EvidenceResolutionStatus,
} from './lifecycle-evidence.js';

export type LifecycleDiagnosticSeverity = 'error' | 'warning';

export interface LifecycleDiagnostic {
  severity: LifecycleDiagnosticSeverity;
  code: string;
  message: string;
  registry_root: string;
  profile_path?: string;
  skill_id?: string;
  evidence_ref?: string;
  relation_target?: string;
  source_ref?: string;
}

export interface EvidenceResolution {
  location: string;
  kind: string;
  ref: string;
  resolution: EvidenceResolutionStatus;
  resolved_path?: string;
}

export interface SourceIntegrityCheck {
  check: string;
  status: 'verified' | 'failed' | 'not-applicable';
  message: string;
}

export interface SourceIntegrity {
  status: 'verified' | 'failed' | 'not-applicable';
  checks: SourceIntegrityCheck[];
}

export interface LifecycleDossier {
  skill_id: string;
  registry_root: string;
  profile_path: string;
  profile: LifecycleProfile;
  aggregate_adoption: LifecycleProfile['adoption']['scopes'][number]['stage'];
  evidence_resolution: EvidenceResolution[];
  evidence_gates: EvidenceGateResult[];
  missing_evidence: string[];
  unverified_evidence: string[];
  target_missing_evidence: string[];
  source_integrity: SourceIntegrity;
}

export interface LifecycleRegistrySnapshot {
  schema_version: 1;
  registry_roots: string[];
  evidence_resolution_mode: 'not-requested' | 'requested';
  lifeos_root?: string;
  skills: LifecycleDossier[];
  diagnostics: LifecycleDiagnostic[];
  writes_performed: 0;
}

export interface LoadLifecycleOptions {
  lifeosRoot?: string;
}

export interface LifecycleListEntry {
  skill_id: string;
  display_name: string;
  source_ref: string;
  owner_class: LifecycleProfile['owner_class'];
  learning: {
    current_level: LifecycleProfile['learning']['current_level'];
    target_level: LifecycleProfile['learning']['target_level'];
  };
  aggregate_adoption: LifecycleDossier['aggregate_adoption'];
  adoption_scopes: Array<{
    project: string;
    stage: AdoptionScope['stage'];
    devices: string[];
    workflows: string[];
  }>;
  freshness: LifecycleProfile['freshness']['status'];
  missing_evidence: string[];
  unverified_evidence: string[];
  registry_root: string;
  profile_path: string;
}

export interface LifecycleRecommendation {
  priority: number;
  code: string;
  skill_id: string;
  scope?: string;
  action: string;
  missing_evidence: string[];
}

interface SourceEntry {
  id: string;
  source_type?: string;
  path?: string;
  pinned_revision?: string;
  skill_paths?: Record<string, string>;
}

const PROFILE_NAMES = new Set(['profile.yaml', 'profile.yml']);
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const LIFEOS_REF = /^lifeos:\/\/41\.15\/(experiments|skills|patterns|decisions|comparisons)\/([a-z0-9][a-z0-9._-]*)$/;
const LIFEOS_DIRECTORIES: Record<string, string> = {
  skills: '10_skill-notes',
  experiments: '20_experiments',
  comparisons: '30_comparisons',
  patterns: '40_patterns',
  decisions: '50_decisions',
};
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SECRET = /\b(?:sk-[a-zA-Z0-9_-]{16,}|ghp_[a-zA-Z0-9]{20,}|api[_-]?key\s*[:=]|token\s*[:=])\b/i;
const USER_HOME = /(?:\/Users\/[^/\s]+(?:\/|$)|\/home\/[^/\s]+(?:\/|$)|[a-zA-Z]:\\Users\\[^\\\s]+(?:\\|$))/;
const DERIVATIVE_RELATIONS = new Set([
  'configure',
  'wrap',
  'fork',
  'localized-derivative',
  'absorb',
]);

function diagnosticSort(a: LifecycleDiagnostic, b: LifecycleDiagnostic): number {
  return [
    a.registry_root,
    a.profile_path ?? '',
    a.skill_id ?? '',
    a.severity,
    a.code,
    a.evidence_ref ?? '',
    a.relation_target ?? '',
    a.message,
  ].join('\0').localeCompare([
    b.registry_root,
    b.profile_path ?? '',
    b.skill_id ?? '',
    b.severity,
    b.code,
    b.evidence_ref ?? '',
    b.relation_target ?? '',
    b.message,
  ].join('\0'));
}

function dedupeDiagnostics(diagnostics: LifecycleDiagnostic[]): LifecycleDiagnostic[] {
  const unique = new Map<string, LifecycleDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.registry_root,
      diagnostic.profile_path ?? '',
      diagnostic.skill_id ?? '',
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
      diagnostic.evidence_ref ?? '',
      diagnostic.relation_target ?? '',
      diagnostic.source_ref ?? '',
    ].join('\0');
    if (!unique.has(key)) unique.set(key, diagnostic);
  }
  return [...unique.values()].sort(diagnosticSort);
}

function walkProfiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkProfiles(fullPath));
    else if (entry.isFile() && PROFILE_NAMES.has(entry.name)) result.push(fullPath);
  }
  return result;
}

function lifecycleRoots(registryRoot: string): string[] {
  const candidates = [
    path.join(registryRoot, 'registry', 'lifecycle'),
    path.join(registryRoot, 'lifecycle'),
  ];
  if (path.basename(registryRoot) === 'lifecycle') candidates.unshift(registryRoot);
  return [...new Set(candidates.filter((candidate) => fs.existsSync(candidate)))].sort();
}

function sourceCatalogPath(registryRoot: string): string | undefined {
  return [
    path.join(registryRoot, 'registry', 'sources.yaml'),
    path.join(registryRoot, 'registry', 'sources.yml'),
    path.join(registryRoot, 'sources.yaml'),
    path.join(registryRoot, 'sources.yml'),
  ].find((candidate) => fs.existsSync(candidate));
}

function sourceEntries(raw: unknown): Map<string, SourceEntry> {
  const result = new Map<string, SourceEntry>();
  if (!raw || typeof raw !== 'object') return result;
  const record = raw as Record<string, unknown>;
  const sources = record.sources ?? record;
  if (Array.isArray(sources)) {
    for (const value of sources) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const id = item.id ?? item.source_id;
      if (typeof id === 'string') result.set(id, sourceEntry(id, item));
    }
  } else if (sources && typeof sources === 'object') {
    for (const [id, value] of Object.entries(sources as Record<string, unknown>).sort()) {
      if (['schema_version', 'version'].includes(id) || !value || typeof value !== 'object') {
        continue;
      }
      result.set(id, sourceEntry(id, value as Record<string, unknown>));
    }
  }
  return result;
}

function sourceEntry(id: string, value: Record<string, unknown>): SourceEntry {
  const skillPaths = value.skill_paths;
  return {
    id,
    source_type: typeof value.source_type === 'string' ? value.source_type : undefined,
    path: typeof value.path === 'string' ? value.path : undefined,
    pinned_revision: typeof value.pinned_revision === 'string'
      ? value.pinned_revision
      : undefined,
    skill_paths: skillPaths && typeof skillPaths === 'object' && !Array.isArray(skillPaths)
      ? Object.fromEntries(
        Object.entries(skillPaths as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
      : undefined,
  };
}

function parseSourceCatalog(
  registryRoot: string,
  diagnostics: LifecycleDiagnostic[],
): Map<string, SourceEntry> | undefined {
  const catalogPath = sourceCatalogPath(registryRoot);
  if (!catalogPath) {
    diagnostics.push({
      severity: 'error',
      code: 'source-catalog-missing',
      message: 'expected registry/sources.yaml (or sources.yaml) to validate source_ref',
      registry_root: registryRoot,
    });
    return undefined;
  }
  try {
    const entries = sourceEntries(parseYaml(fs.readFileSync(catalogPath, 'utf8')));
    if (entries.size === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'source-catalog-empty',
        message: `source catalog has no source identifiers: ${path.relative(registryRoot, catalogPath)}`,
        registry_root: registryRoot,
      });
    }
    return entries;
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'source-catalog-invalid',
      message: `cannot parse source catalog: ${(error as Error).message}`,
      registry_root: registryRoot,
    });
    return undefined;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function profileEvidence(profile: LifecycleProfile): Array<{
  location: string;
  evidence: Evidence;
}> {
  const result = profile.learning.evidence.map((evidence) => ({
    location: 'learning',
    evidence,
  }));
  for (const [index, scope] of profile.adoption.scopes.entries()) {
    for (const evidence of scope.evidence) {
      result.push({
        location: `adoption.scopes[${index}]:${scope.project}:${scope.stage}`,
        evidence,
      });
    }
  }
  return result;
}

function privacyDiagnostics(
  value: unknown,
  registryRoot: string,
  profilePath: string,
  skillId: string,
  currentPath = '<root>',
): LifecycleDiagnostic[] {
  if (typeof value === 'string') {
    if (USER_HOME.test(value) || value.startsWith('~/') || value.startsWith('~\\')) {
      return [{
        severity: 'error',
        code: 'absolute-home-path',
        message: `${currentPath} contains an absolute user-home path`,
        registry_root: registryRoot,
        profile_path: path.relative(registryRoot, profilePath),
        skill_id: skillId,
      }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      privacyDiagnostics(item, registryRoot, profilePath, skillId, `${currentPath}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      privacyDiagnostics(item, registryRoot, profilePath, skillId, `${currentPath}.${key}`));
  }
  return [];
}

function resolveEvidence(
  profile: LifecycleProfile,
  registryRoot: string,
  profilePath: string,
  lifeosRoot: string | undefined,
): { diagnostics: LifecycleDiagnostic[]; resolutions: EvidenceResolution[]; lookup: Map<Evidence, EvidenceResolutionStatus> } {
  const diagnostics: LifecycleDiagnostic[] = [];
  const resolutions: EvidenceResolution[] = [];
  const lookup = new Map<Evidence, EvidenceResolutionStatus>();
  const relativeProfilePath = path.relative(registryRoot, profilePath);
  const common = {
    registry_root: registryRoot,
    profile_path: relativeProfilePath,
    skill_id: profile.skill_id,
  };

  for (const { location, evidence } of profileEvidence(profile)) {
    let resolution: EvidenceResolutionStatus = 'missing';
    let resolvedPath: string | undefined;
    const lifeos = LIFEOS_REF.exec(evidence.ref);

    if (evidence.ref.startsWith('lifeos://')) {
      if (!lifeos || evidence.ref.includes('..')) {
        diagnostics.push({
          ...common,
          severity: 'error',
          code: 'invalid-lifeos-reference',
          message: `invalid portable Life-OS evidence reference: ${evidence.ref}`,
          evidence_ref: evidence.ref,
        });
      } else if (!lifeosRoot) {
        resolution = 'not-requested';
        diagnostics.push({
          ...common,
          severity: 'warning',
          code: 'evidence-unresolved',
          message: 'Life-OS resolution was not requested; evidence gate remains unverified',
          evidence_ref: evidence.ref,
        });
      } else if (!fs.existsSync(lifeosRoot) || !fs.statSync(lifeosRoot).isDirectory()) {
        resolution = 'unresolved';
        diagnostics.push({
          ...common,
          severity: 'warning',
          code: 'evidence-unresolved',
          message: `Life-OS entity root is unavailable: ${lifeosRoot}`,
          evidence_ref: evidence.ref,
        });
      } else {
        const [, namespace, stem] = lifeos;
        const candidate = path.join(lifeosRoot, LIFEOS_DIRECTORIES[namespace], `${stem}.md`);
        if (!fs.existsSync(candidate)) {
          diagnostics.push({
            ...common,
            severity: 'error',
            code: 'evidence-reference-missing',
            message: `mapped Life-OS evidence note is missing: ${namespace}/${stem}.md`,
            evidence_ref: evidence.ref,
          });
        } else {
          const realRoot = fs.realpathSync(lifeosRoot);
          const realCandidate = fs.realpathSync(candidate);
          if (!isWithin(realRoot, realCandidate)) {
            diagnostics.push({
              ...common,
              severity: 'error',
              code: 'evidence-symlink-escape',
              message: `mapped Life-OS evidence resolves outside its entity root: ${evidence.ref}`,
              evidence_ref: evidence.ref,
            });
          } else {
            resolution = 'resolved';
            resolvedPath = path.relative(realRoot, realCandidate);
          }
        }
      }
    } else if (
      path.isAbsolute(evidence.ref)
      || WINDOWS_ABSOLUTE.test(evidence.ref)
      || evidence.ref.startsWith('~')
    ) {
      diagnostics.push({
        ...common,
        severity: 'error',
        code: 'absolute-evidence-path',
        message: `evidence ref must be owner-root-relative: ${evidence.ref}`,
        evidence_ref: evidence.ref,
      });
    } else if (URI_SCHEME.test(evidence.ref)) {
      diagnostics.push({
        ...common,
        severity: 'error',
        code: 'unapproved-evidence-scheme',
        message: `evidence ref uses an unapproved opaque scheme: ${evidence.ref}`,
        evidence_ref: evidence.ref,
      });
    } else if (evidence.ref.includes('\\')) {
      diagnostics.push({
        ...common,
        severity: 'error',
        code: 'nonportable-evidence-path',
        message: `evidence ref must use portable forward slashes: ${evidence.ref}`,
        evidence_ref: evidence.ref,
      });
    } else {
      const refWithoutFragment = evidence.ref.split('#', 1)[0];
      const candidate = path.resolve(registryRoot, refWithoutFragment);
      if (!isWithin(registryRoot, candidate)) {
        diagnostics.push({
          ...common,
          severity: 'error',
          code: 'evidence-path-traversal',
          message: `evidence ref escapes its owner root: ${evidence.ref}`,
          evidence_ref: evidence.ref,
        });
      } else if (!fs.existsSync(candidate)) {
        diagnostics.push({
          ...common,
          severity: 'error',
          code: 'evidence-reference-missing',
          message: `evidence ref does not exist under its owner root: ${evidence.ref}`,
          evidence_ref: evidence.ref,
        });
      } else {
        const realRoot = fs.realpathSync(registryRoot);
        const realCandidate = fs.realpathSync(candidate);
        if (!isWithin(realRoot, realCandidate)) {
          diagnostics.push({
            ...common,
            severity: 'error',
            code: 'evidence-symlink-escape',
            message: `evidence ref resolves outside its owner root: ${evidence.ref}`,
            evidence_ref: evidence.ref,
          });
        } else {
          resolution = 'resolved';
          resolvedPath = path.relative(realRoot, realCandidate);
        }
      }
    }

    if (evidence.summary && (EMAIL.test(evidence.summary) || USER_HOME.test(evidence.summary))) {
      diagnostics.push({
        ...common,
        severity: 'error',
        code: 'private-evidence-summary',
        message: 'evidence summary contains an email address or absolute user-home path',
        evidence_ref: evidence.ref,
      });
    }
    if (evidence.summary && SECRET.test(evidence.summary)) {
      diagnostics.push({
        ...common,
        severity: 'error',
        code: 'secret-like-evidence-summary',
        message: 'evidence summary contains secret-like material',
        evidence_ref: evidence.ref,
      });
    }

    lookup.set(evidence, resolution);
    resolutions.push({
      location,
      kind: evidence.kind,
      ref: evidence.ref,
      resolution,
      ...(resolvedPath ? { resolved_path: resolvedPath } : {}),
    });
  }

  return {
    diagnostics,
    lookup,
    resolutions: resolutions.sort((a, b) =>
      [a.location, a.kind, a.ref].join('\0').localeCompare([b.location, b.kind, b.ref].join('\0'))),
  };
}

function sourceIntegrity(
  profile: LifecycleProfile,
  registryRoot: string,
  source: SourceEntry | undefined,
  diagnostics: LifecycleDiagnostic[],
  profilePath: string,
): SourceIntegrity {
  const checks: SourceIntegrityCheck[] = [];
  const common = {
    registry_root: registryRoot,
    profile_path: path.relative(registryRoot, profilePath),
    skill_id: profile.skill_id,
    source_ref: profile.source_ref,
  };
  const fail = (check: string, code: string, message: string) => {
    checks.push({ check, status: 'failed' as const, message });
    diagnostics.push({ ...common, severity: 'error', code, message });
  };
  const pass = (check: string, message: string) =>
    checks.push({ check, status: 'verified', message });

  if (!source) {
    fail('catalog', 'source-reference-missing',
      `source_ref is not declared by the owner source catalog: ${profile.source_ref}`);
  } else if (source.source_type !== 'git-submodule') {
    checks.push({
      check: 'git-submodule',
      status: 'not-applicable',
      message: `source_type ${source.source_type ?? 'unspecified'} is not a git-submodule`,
    });
  } else {
    if (!source.path || path.isAbsolute(source.path) || WINDOWS_ABSOLUTE.test(source.path)) {
      fail('source-path', 'source-path-invalid', 'git-submodule source requires a portable relative path');
    }
    if (!source.pinned_revision || !/^[0-9a-f]{40}$/.test(source.pinned_revision)) {
      fail('source-pin', 'source-pin-invalid',
        'git-submodule source requires a lowercase 40-character pinned_revision');
    }
    if (source.path && source.pinned_revision) {
      const sourcePath = path.resolve(registryRoot, source.path);
      if (!isWithin(registryRoot, sourcePath)) {
        fail('source-path', 'source-path-traversal', `source path escapes owner root: ${source.path}`);
      } else if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
        fail('submodule-checkout', 'source-submodule-missing',
          `pinned submodule is not initialized: ${source.path}`);
      } else {
        const realOwner = fs.realpathSync(registryRoot);
        const realSource = fs.realpathSync(sourcePath);
        if (!isWithin(realOwner, realSource)) {
          fail('submodule-checkout', 'source-symlink-escape',
            `source checkout resolves outside owner root: ${source.path}`);
        } else {
          pass('submodule-checkout', `submodule checkout exists: ${source.path}`);
        }
        try {
          const head = execFileSync('git', ['-C', sourcePath, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          if (head !== source.pinned_revision) {
            fail('checkout-pin', 'source-checkout-pin-mismatch',
              `submodule HEAD ${head} does not match pinned_revision ${source.pinned_revision}`);
          } else {
            pass('checkout-pin', `submodule HEAD matches ${source.pinned_revision}`);
          }
        } catch {
          fail('checkout-pin', 'source-checkout-invalid',
            `cannot read Git HEAD for submodule: ${source.path}`);
        }
      }
      try {
        const stage = execFileSync(
          'git',
          ['-C', registryRoot, 'ls-files', '--stage', '--', source.path],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim();
        const match = /^160000 ([0-9a-f]{40}) \d+\t/.exec(stage);
        if (!match) {
          fail('gitlink', 'source-gitlink-missing',
            `parent Git index has no submodule gitlink for ${source.path}`);
        } else if (match[1] !== source.pinned_revision) {
          fail('gitlink', 'source-gitlink-pin-mismatch',
            `gitlink ${match[1]} does not match pinned_revision ${source.pinned_revision}`);
        } else {
          pass('gitlink', `parent gitlink matches ${source.pinned_revision}`);
        }
      } catch {
        fail('gitlink', 'source-gitlink-unavailable',
          `cannot inspect parent Git index for ${source.path}`);
      }

      const skillPath = source.skill_paths?.[profile.skill_id];
      if (!skillPath) {
        fail('skill-path', 'source-skill-path-missing',
          `source catalog has no skill_paths entry for ${profile.skill_id}`);
      } else {
        const sourcePath = path.resolve(registryRoot, source.path);
        const candidate = path.resolve(sourcePath, skillPath);
        if (!isWithin(sourcePath, candidate)) {
          fail('skill-path', 'source-skill-path-traversal',
            `Skill path escapes its source root: ${skillPath}`);
        } else if (!fs.existsSync(candidate)) {
          fail('skill-path', 'source-skill-path-not-found',
            `pinned source does not contain Skill path: ${skillPath}`);
        } else if (!isWithin(fs.realpathSync(sourcePath), fs.realpathSync(candidate))) {
          fail('skill-path', 'source-skill-path-symlink-escape',
            `Skill path resolves outside its source root: ${skillPath}`);
        } else {
          pass('skill-path', `pinned source contains ${skillPath}`);
        }
      }
    }
  }

  const status = checks.some((check) => check.status === 'failed')
    ? 'failed'
    : checks.some((check) => check.status === 'verified')
      ? 'verified'
      : 'not-applicable';
  return { status, checks };
}

function zodDiagnostics(
  error: ZodError,
  registryRoot: string,
  profilePath: string,
): LifecycleDiagnostic[] {
  return error.issues.map((issue) => ({
    severity: 'error',
    code: 'schema-invalid',
    message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    registry_root: registryRoot,
    profile_path: path.relative(registryRoot, profilePath),
  }));
}

function validateLineage(
  skills: LifecycleDossier[],
  catalogs: Map<string, Map<string, SourceEntry>>,
  diagnostics: LifecycleDiagnostic[],
): void {
  const byId = new Map(skills.map((dossier) => [dossier.skill_id, dossier]));
  for (const dossier of skills) {
    for (const relation of dossier.profile.disposition.relations) {
      if (!relation.target || !DERIVATIVE_RELATIONS.has(relation.type)) continue;
      const common = {
        registry_root: dossier.registry_root,
        profile_path: dossier.profile_path,
        skill_id: dossier.skill_id,
        relation_target: relation.target,
      };
      const target = byId.get(relation.target);
      if (!target) {
        diagnostics.push({
          ...common,
          severity: 'error',
          code: 'lineage-target-missing',
          message: `relation direction is "current profile is ${relation.type} of target"; target not found: ${relation.target}`,
        });
        continue;
      }
      if (relation.base_revision) {
        const targetSource = catalogs.get(target.registry_root)?.get(target.profile.source_ref);
        if (!targetSource?.pinned_revision) {
          diagnostics.push({
            ...common,
            severity: 'error',
            code: 'lineage-target-pin-missing',
            message: `target source has no pinned_revision: ${target.profile.source_ref}`,
          });
        } else if (targetSource.pinned_revision !== relation.base_revision) {
          diagnostics.push({
            ...common,
            severity: 'error',
            code: 'lineage-revision-mismatch',
            message: `base_revision ${relation.base_revision} does not match target source pin ${targetSource.pinned_revision}`,
          });
        }
      }
    }
  }
}

export function loadLifecycleRegistries(
  registries: string[],
  options: LoadLifecycleOptions = {},
): LifecycleRegistrySnapshot {
  const roots = [...new Set(registries.map((registry) => path.resolve(registry)))].sort();
  const lifeosRoot = options.lifeosRoot ? path.resolve(options.lifeosRoot) : undefined;
  const skills: LifecycleDossier[] = [];
  const diagnostics: LifecycleDiagnostic[] = [];
  const seen = new Map<string, LifecycleDossier>();
  const catalogs = new Map<string, Map<string, SourceEntry>>();

  for (const registryRoot of roots) {
    if (!fs.existsSync(registryRoot) || !fs.statSync(registryRoot).isDirectory()) {
      diagnostics.push({
        severity: 'error',
        code: 'registry-root-missing',
        message: 'registry root does not exist or is not a directory',
        registry_root: registryRoot,
      });
      continue;
    }
    const rootsToScan = lifecycleRoots(registryRoot);
    if (rootsToScan.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'lifecycle-root-missing',
        message: 'expected registry/lifecycle/ or lifecycle/ under registry root',
        registry_root: registryRoot,
      });
      continue;
    }
    const catalog = parseSourceCatalog(registryRoot, diagnostics);
    if (catalog) catalogs.set(registryRoot, catalog);
    const profilePaths = [...new Set(rootsToScan.flatMap(walkProfiles))].sort();
    if (profilePaths.length === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'lifecycle-empty',
        message: 'no lifecycle profile.yaml files found',
        registry_root: registryRoot,
      });
    }

    for (const profilePath of profilePaths) {
      const relativeProfilePath = path.relative(registryRoot, profilePath);
      let raw: unknown;
      try {
        raw = parseYaml(fs.readFileSync(profilePath, 'utf8'));
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: 'profile-yaml-invalid',
          message: `cannot parse lifecycle profile: ${(error as Error).message}`,
          registry_root: registryRoot,
          profile_path: relativeProfilePath,
        });
        continue;
      }
      const parsed = LifecycleProfileSchema.safeParse(raw);
      if (!parsed.success) {
        diagnostics.push(...zodDiagnostics(parsed.error, registryRoot, profilePath));
        continue;
      }
      const profile = parsed.data;
      diagnostics.push(...privacyDiagnostics(profile, registryRoot, profilePath, profile.skill_id));
      const evidence = resolveEvidence(
        profile,
        registryRoot,
        profilePath,
        lifeosRoot,
      );
      diagnostics.push(...evidence.diagnostics);
      const gates = evaluateEvidenceGates(
        profile,
        (item) => evidence.lookup.get(item) ?? 'missing',
      );
      const integrity = sourceIntegrity(
        profile,
        registryRoot,
        catalog?.get(profile.source_ref),
        diagnostics,
        profilePath,
      );
      const dossier: LifecycleDossier = {
        skill_id: profile.skill_id,
        registry_root: registryRoot,
        profile_path: relativeProfilePath,
        profile,
        aggregate_adoption: deriveAggregateAdoption(profile.adoption.scopes),
        evidence_resolution: evidence.resolutions,
        evidence_gates: gates,
        missing_evidence: missingEvidence(gates),
        unverified_evidence: unverifiedEvidence(gates),
        target_missing_evidence: missingTargetEvidence(
          profile,
          (item) => evidence.lookup.get(item) ?? 'missing',
        ),
        source_integrity: integrity,
      };
      const duplicate = seen.get(profile.skill_id);
      if (duplicate) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate-skill-id',
          message: `duplicate skill_id; derived records require a distinct ID and explicit relation (first: ${duplicate.profile_path})`,
          registry_root: registryRoot,
          profile_path: relativeProfilePath,
          skill_id: profile.skill_id,
        });
      } else {
        seen.set(profile.skill_id, dossier);
        skills.push(dossier);
      }
    }
  }

  validateLineage(skills, catalogs, diagnostics);
  return {
    schema_version: 1,
    registry_roots: roots,
    evidence_resolution_mode: lifeosRoot ? 'requested' : 'not-requested',
    ...(lifeosRoot ? { lifeos_root: lifeosRoot } : {}),
    skills: skills.sort((a, b) => a.skill_id.localeCompare(b.skill_id)),
    diagnostics: dedupeDiagnostics(diagnostics),
    writes_performed: 0,
  };
}

function scopeSummary(scope: AdoptionScope) {
  return {
    project: scope.project,
    stage: scope.stage,
    devices: [...scope.devices].sort(),
    workflows: [...scope.workflows].sort(),
  };
}

export function lifecycleList(snapshot: LifecycleRegistrySnapshot): LifecycleListEntry[] {
  return snapshot.skills.map((dossier) => ({
    skill_id: dossier.skill_id,
    display_name: dossier.profile.display_name,
    source_ref: dossier.profile.source_ref,
    owner_class: dossier.profile.owner_class,
    learning: {
      current_level: dossier.profile.learning.current_level,
      target_level: dossier.profile.learning.target_level,
    },
    aggregate_adoption: dossier.aggregate_adoption,
    adoption_scopes: dossier.profile.adoption.scopes.map(scopeSummary)
      .sort((a, b) => [a.project, a.stage].join('\0').localeCompare([b.project, b.stage].join('\0'))),
    freshness: dossier.profile.freshness.status,
    missing_evidence: dossier.missing_evidence,
    unverified_evidence: dossier.unverified_evidence,
    registry_root: dossier.registry_root,
    profile_path: dossier.profile_path,
  }));
}

function count(values: string[]) {
  return Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length,
    ]),
  );
}

export function lifecycleStatus(snapshot: LifecycleRegistrySnapshot, asOf: string) {
  PortableDateSchema.parse(asOf);
  const scopes = snapshot.skills.flatMap((dossier) => dossier.profile.adoption.scopes);
  return {
    schema_version: 1,
    as_of: asOf,
    total_skills: snapshot.skills.length,
    valid: !snapshot.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    errors: snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warnings: snapshot.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
    evidence_resolution_mode: snapshot.evidence_resolution_mode,
    learning: count(snapshot.skills.map((dossier) => dossier.profile.learning.current_level)),
    aggregate_adoption: count(snapshot.skills.map((dossier) => dossier.aggregate_adoption)),
    freshness: count(snapshot.skills.map((dossier) => dossier.profile.freshness.status)),
    scoped_adoption: {
      projects: count(scopes.map((scope) => `${scope.project}:${scope.stage}`)),
      devices: count(scopes.flatMap((scope) =>
        scope.devices.map((device) => `${device}:${scope.stage}`))),
      workflows: count(scopes.flatMap((scope) =>
        scope.workflows.map((workflow) => `${workflow}:${scope.stage}`))),
    },
    evidence_gaps: snapshot.skills.filter((dossier) => dossier.missing_evidence.length > 0).length,
    evidence_unverified: snapshot.skills
      .filter((dossier) => dossier.unverified_evidence.length > 0).length,
    writes_performed: 0,
  } as const;
}

function missingProductionEvidence(scope: AdoptionScope): string[] {
  const aliases: Record<string, string[]> = {
    'real-case': ['real-case', 'production-case'],
    'human-review': ['human-review'],
    fallback: ['fallback', 'fallback-policy'],
  };
  const actual = new Set(scope.evidence.map((item) => item.kind.toLowerCase()));
  return Object.entries(aliases)
    .filter(([, kinds]) => !kinds.some((kind) => actual.has(kind)))
    .map(([required]) => required)
    .sort();
}

export function lifecycleRecommendations(
  snapshot: LifecycleRegistrySnapshot,
  asOf: string,
): LifecycleRecommendation[] {
  PortableDateSchema.parse(asOf);
  const result: LifecycleRecommendation[] = [];
  for (const dossier of snapshot.skills) {
    const profile = dossier.profile;
    const productionScopes = profile.adoption.scopes
      .filter((scope) => ['production', 'embedded'].includes(scope.stage));
    if (productionScopes.length > 0 && profile.freshness.status === 'needs-revalidation') {
      for (const scope of productionScopes) {
        result.push({
          priority: 1,
          code: 'revalidate-production',
          skill_id: profile.skill_id,
          scope: scope.project,
          action: `Revalidate the ${scope.stage} Skill in ${scope.project}.`,
          missing_evidence: [],
        });
      }
    }
    for (const scope of profile.adoption.scopes.filter((candidate) => candidate.stage === 'pilot')) {
      const missing = missingProductionEvidence(scope);
      if (missing.length > 0) {
        result.push({
          priority: 2,
          code: 'complete-production-gate',
          skill_id: profile.skill_id,
          scope: scope.project,
          action: `Add reviewed production-gate evidence for ${scope.project}.`,
          missing_evidence: missing,
        });
      }
    }
    if (
      ['L0', 'L1'].includes(profile.learning.current_level)
      && profile.learning.target_level !== profile.learning.current_level
    ) {
      result.push({
        priority: 3,
        code: 'advance-learning',
        skill_id: profile.skill_id,
        action: `Collect verified evidence toward ${profile.learning.target_level}.`,
        missing_evidence: dossier.target_missing_evidence,
      });
    }
    if (
      profile.freshness.status === 'stale'
      && profile.next_review_at
      && profile.next_review_at < asOf
    ) {
      result.push({
        priority: 4,
        code: 'review-stale',
        skill_id: profile.skill_id,
        action: `Review stale lifecycle record (due ${profile.next_review_at}).`,
        missing_evidence: [],
      });
    }
    if (
      (dossier.aggregate_adoption === 'retired'
        || ['superseded', 'archived'].includes(profile.freshness.status))
      && profile.adoption.scopes.some((scope) => scope.workflows.length > 0)
    ) {
      result.push({
        priority: 5,
        code: 'remove-retired-workflow-reference',
        skill_id: profile.skill_id,
        action: 'Remove or replace remaining Workflow references.',
        missing_evidence: [],
      });
    }
  }
  return result.sort((a, b) =>
    a.priority - b.priority
    || a.skill_id.localeCompare(b.skill_id)
    || (a.scope ?? '').localeCompare(b.scope ?? '')
    || a.code.localeCompare(b.code));
}
