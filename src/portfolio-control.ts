/**
 * Deterministic, read-only Portfolio resolution and planning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  PortfolioDateSchema,
  PortfolioDeviceRegistrySchema,
  PortfolioLockSchema,
  PortfolioManifestSchema,
  ProjectBindingSchema,
  type PortfolioDeviceRegistry,
  type PortfolioLock,
  type PortfolioManifest,
  type ProjectBinding,
} from './portfolio-schema.js';
import { hashSkillSubtree, type SkillSubtreeDigest } from './portfolio-hash.js';
import type { InstallBackend, RuntimeOwnershipMode } from './profile-schema.js';
import { forbiddenCanonicalSuffix } from './canonical-identity.js';

export type PortfolioDiagnosticSeverity = 'error' | 'warning';

export interface PortfolioDiagnostic {
  severity: PortfolioDiagnosticSeverity;
  code: string;
  message: string;
  deployment?: string;
  project_ref?: string;
  skill_id?: string;
}

export interface PortfolioControlOptions {
  manifestPath: string;
  lockPath: string;
  deviceRegistryPath: string;
  deviceId: string;
  asOf?: string;
}

export interface PortfolioResolvedProject {
  project_ref: string;
  expected_vault: string;
  configured_root: string;
  realpath: string | null;
  binding_path: string | null;
  binding: ProjectBinding | null;
}

export interface PortfolioResolvedSkill {
  skill_id: string;
  source: string;
  source_revision: string | null;
  path: string;
  source_path: string | null;
  tree_hash: string | null;
  executable_files: string[];
  locked_tree_hash: string | null;
  locked_executable_files: string[];
  ownership: RuntimeOwnershipMode;
  exposure_name: string;
}

export interface PortfolioResolvedDeployment {
  deployment: string;
  project_ref: string;
  project_realpath: string | null;
  selected_profiles: string[];
  selected_skills: string[];
  locked_skills: string[];
  budgets: {
    selected_skills: number;
    max_skills: number;
    description_chars: number;
    max_description_chars: number;
  };
}

interface PortfolioState {
  manifest: PortfolioManifest;
  lock: PortfolioLock;
  registry: PortfolioDeviceRegistry;
  deviceId: string;
  deviceStateRoot: string | null;
  asOf: string;
  projects: Map<string, PortfolioResolvedProject>;
  skills: Map<string, PortfolioResolvedSkill>;
  deployments: Map<string, PortfolioResolvedDeployment>;
  diagnostics: PortfolioDiagnostic[];
}

export interface PortfolioValidation {
  version: 1;
  portfolio: string;
  device: string;
  as_of: string;
  valid: boolean;
  projects: PortfolioResolvedProject[];
  deployments: PortfolioResolvedDeployment[];
  diagnostics: PortfolioDiagnostic[];
  writes_performed: 0;
}

export type PortfolioPlanAction = 'noop' | 'create' | 'blocked' | 'catalog';

export interface PortfolioPlanEntry {
  skill_id: string;
  action: PortfolioPlanAction;
  exposure_name: string;
  ownership: RuntimeOwnershipMode;
  backend: InstallBackend;
  source: string;
  source_revision: string | null;
  source_path: string | null;
  tree_hash: string | null;
  executable_files: string[];
  target: string | null;
  health: string;
  migration_exception: {
    pinned_revision: string;
    owner: string;
    reason: string;
    expires_at: string;
  } | null;
}

export interface PortfolioPlan {
  version: 1;
  portfolio: string;
  device: string;
  as_of: string;
  deployment: string;
  project_ref: string | null;
  project_realpath: string | null;
  selected_profiles: string[];
  command_maturity: 'current' | 'mvp' | 'future';
  activation_lock: string | null;
  lock_acquired: false;
  budgets: PortfolioResolvedDeployment['budgets'];
  entries: PortfolioPlanEntry[];
  errors: PortfolioDiagnostic[];
  warnings: PortfolioDiagnostic[];
  writes_performed: 0;
}

export interface PortfolioStatus {
  version: 1;
  portfolio: string;
  device: string;
  as_of: string;
  all: true;
  valid: boolean;
  deployments: Array<{
    deployment: string;
    project_ref: string;
    project_realpath: string | null;
    selected_profiles: string[];
    selected_skills: number;
    locked_skills: number;
    healthy: number;
    pending: number;
    blocked: number;
    active_exceptions: number;
    errors: number;
    warnings: number;
  }>;
  diagnostics: PortfolioDiagnostic[];
  writes_performed: 0;
}

export interface PortfolioDeploymentView {
  version: 1;
  portfolio: string;
  device: string;
  as_of: string;
  all: true;
  rows: Array<{
    deployment: string;
    project_ref: string;
    project_realpath: string | null;
    selected_profiles: string[];
    canonical_skill_id: string;
    exposure_name: string;
    source_revision: string | null;
    subtree_hash: string | null;
    target: string | null;
    health: string;
  }>;
  diagnostics: PortfolioDiagnostic[];
  writes_performed: 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function diagnosticKey(diagnostic: PortfolioDiagnostic): string {
  return [
    diagnostic.severity === 'error' ? '0' : '1',
    diagnostic.code,
    diagnostic.deployment ?? '',
    diagnostic.project_ref ?? '',
    diagnostic.skill_id ?? '',
    diagnostic.message,
  ].join('\0');
}

function sortDiagnostics(diagnostics: PortfolioDiagnostic[]): PortfolioDiagnostic[] {
  const unique = new Map<string, PortfolioDiagnostic>();
  for (const diagnostic of diagnostics) unique.set(diagnosticKey(diagnostic), diagnostic);
  return [...unique.values()].sort((a, b) => compareText(diagnosticKey(a), diagnosticKey(b)));
}

function addDiagnostic(
  diagnostics: PortfolioDiagnostic[],
  severity: PortfolioDiagnosticSeverity,
  code: string,
  message: string,
  context: Partial<Pick<PortfolioDiagnostic, 'deployment' | 'project_ref' | 'skill_id'>> = {},
): void {
  diagnostics.push({ severity, code, message, ...context });
}

function readYaml<T>(
  filePath: string,
  schema: { parse(value: unknown): T },
  label: string,
): T {
  if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  const document = parseDocument(fs.readFileSync(filePath, 'utf-8'));
  if (document.errors.length > 0) {
    throw new Error(
      `${label} YAML error: ${document.errors.map((error) => error.message).join(', ')}`,
    );
  }
  return schema.parse(document.toJSON());
}

function effectiveDate(value?: string): string {
  const candidate = value ?? new Date().toISOString().slice(0, 10);
  return PortfolioDateSchema.parse(candidate);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRealpath(candidate: string): string | null {
  try {
    return path.normalize(fs.realpathSync(candidate));
  } catch {
    return null;
  }
}

function resolveWithExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  const suffix: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`no existing ancestor for device-local path: ${candidate}`);
    }
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function pathsOverlap(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

function equalSets(first: string[], second: string[]): boolean {
  const left = sortedUnique(first);
  const right = sortedUnique(second);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function resolveSelectedSkills(
  manifest: PortfolioManifest,
  deploymentName: string,
  diagnostics: PortfolioDiagnostic[],
): PortfolioResolvedDeployment {
  const deployment = manifest.deployments[deploymentName];
  const include: string[] = [...deployment.include];
  const exclude: string[] = [...deployment.exclude];
  let maxSkills = 0;
  let maxDescriptionChars = 0;

  for (const profileName of deployment.profiles) {
    const profile = manifest.profiles[profileName];
    if (!profile) {
      addDiagnostic(
        diagnostics,
        'error',
        'profile-reference-unresolved',
        `deployment references unknown Profile ${profileName}`,
        { deployment: deploymentName },
      );
      continue;
    }
    include.push(...profile.include);
    exclude.push(...profile.exclude);
    maxSkills += profile.budgets.max_skills;
    maxDescriptionChars += profile.budgets.max_description_chars;

    const profileSkills = profile.include.filter((skill) => !profile.exclude.includes(skill));
    const profileDescriptionChars = profileSkills.reduce(
      (total, skillId) => total + (manifest.skills[skillId]?.description_chars ?? 0),
      0,
    );
    if (profileSkills.length > profile.budgets.max_skills) {
      addDiagnostic(
        diagnostics,
        'error',
        'profile-skill-budget-overflow',
        `${profileName}: ${profileSkills.length} > ${profile.budgets.max_skills}`,
        { deployment: deploymentName },
      );
    }
    if (profileDescriptionChars > profile.budgets.max_description_chars) {
      addDiagnostic(
        diagnostics,
        'error',
        'profile-description-budget-overflow',
        `${profileName}: ${profileDescriptionChars} > ${profile.budgets.max_description_chars}`,
        { deployment: deploymentName },
      );
    }
  }

  const excluded = new Set(exclude);
  const selectedSkills = sortedUnique(include).filter((skill) => !excluded.has(skill));
  const descriptionChars = selectedSkills.reduce(
    (total, skillId) => total + (manifest.skills[skillId]?.description_chars ?? 0),
    0,
  );

  if (selectedSkills.length > maxSkills) {
    addDiagnostic(
      diagnostics,
      'error',
      'deployment-skill-budget-overflow',
      `${selectedSkills.length} > aggregate Profile budget ${maxSkills}`,
      { deployment: deploymentName },
    );
  }
  if (descriptionChars > maxDescriptionChars) {
    addDiagnostic(
      diagnostics,
      'error',
      'deployment-description-budget-overflow',
      `${descriptionChars} > aggregate Profile budget ${maxDescriptionChars}`,
      { deployment: deploymentName },
    );
  }

  for (const skillId of [...include, ...exclude]) {
    if (!manifest.skills[skillId]) {
      addDiagnostic(
        diagnostics,
        'error',
        'skill-reference-unresolved',
        `unknown canonical Skill ${skillId}`,
        { deployment: deploymentName, skill_id: skillId },
      );
    }
  }

  return {
    deployment: deploymentName,
    project_ref: deployment.project_ref,
    project_realpath: null,
    selected_profiles: sortedUnique(deployment.profiles),
    selected_skills: selectedSkills,
    locked_skills: [],
    budgets: {
      selected_skills: selectedSkills.length,
      max_skills: maxSkills,
      description_chars: descriptionChars,
      max_description_chars: maxDescriptionChars,
    },
  };
}

function resolveTargetHealth(
  ownership: RuntimeOwnershipMode,
  sourcePath: string | null,
  expectedDigest: SkillSubtreeDigest | null,
  target: string | null,
): { action: PortfolioPlanAction; health: string } {
  if (ownership === 'catalog-only') return { action: 'catalog', health: 'catalog-only' };
  if (!sourcePath || !expectedDigest || !target) {
    return { action: 'blocked', health: 'unresolved' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { action: 'create', health: 'not-deployed' };
  }

  if (ownership === 'managed-link') {
    if (!stat.isSymbolicLink()) return { action: 'blocked', health: 'exposure-collision' };
    try {
      return fs.realpathSync(target) === fs.realpathSync(sourcePath)
        ? { action: 'noop', health: 'healthy' }
        : { action: 'blocked', health: 'foreign-link' };
    } catch {
      return { action: 'blocked', health: 'broken-link' };
    }
  }

  if (ownership === 'managed-materialized') {
    if (!stat.isDirectory()) return { action: 'blocked', health: 'exposure-collision' };
    try {
      const actual = hashSkillSubtree(target);
      return actual.tree_hash === expectedDigest.tree_hash
        && equalSets(actual.executable_files, expectedDigest.executable_files)
        ? { action: 'noop', health: 'healthy' }
        : { action: 'blocked', health: 'materialized-drift' };
    } catch {
      return { action: 'blocked', health: 'materialized-unreadable' };
    }
  }

  return { action: 'blocked', health: 'unsupported-ownership' };
}

function backendFor(
  state: PortfolioState,
  ownership: RuntimeOwnershipMode,
): InstallBackend {
  const device = state.registry.devices[state.deviceId];
  if (!device) return 'none';
  if (ownership === 'managed-link' || ownership === 'managed-materialized') {
    return device.backends[ownership];
  }
  return 'none';
}

function buildState(options: PortfolioControlOptions): PortfolioState {
  const manifest = readYaml(
    path.resolve(options.manifestPath),
    PortfolioManifestSchema,
    'Portfolio Manifest',
  );
  const lock = readYaml(
    path.resolve(options.lockPath),
    PortfolioLockSchema,
    'Portfolio Lock',
  );
  const registry = readYaml(
    path.resolve(options.deviceRegistryPath),
    PortfolioDeviceRegistrySchema,
    'Portfolio device registry',
  );
  const asOf = effectiveDate(options.asOf);
  const diagnostics: PortfolioDiagnostic[] = [];
  const projects = new Map<string, PortfolioResolvedProject>();
  const skills = new Map<string, PortfolioResolvedSkill>();
  const deployments = new Map<string, PortfolioResolvedDeployment>();
  const device = registry.devices[options.deviceId];
  let deviceStateRoot: string | null = null;

  if (!device) {
    addDiagnostic(
      diagnostics,
      'error',
      'device-reference-unresolved',
      `unknown device ${options.deviceId}`,
    );
  }

  for (const sourceId of Object.keys(manifest.sources).sort(compareText)) {
    if (!lock.sources[sourceId]) {
      addDiagnostic(
        diagnostics,
        'error',
        'source-lock-missing',
        `source ${sourceId} has no Portfolio Lock entry`,
      );
    }
    if (device && !device.source_roots[sourceId]) {
      addDiagnostic(
        diagnostics,
        'error',
        'source-root-unresolved',
        `device ${options.deviceId} has no source root for ${sourceId}`,
      );
    }
  }
  for (const sourceId of Object.keys(lock.sources).sort(compareText)) {
    if (!manifest.sources[sourceId]) {
      addDiagnostic(
        diagnostics,
        'error',
        'source-lock-orphan',
        `lock references unknown source ${sourceId}`,
      );
    }
  }

  const realpathOwners = new Map<string, string>();
  if (device) {
    for (const [projectRef, projectDefinition] of Object.entries(manifest.projects)
      .sort(([a], [b]) => compareText(a, b))) {
      const configuredRoot = device.project_roots[projectRef];
      const realpath = configuredRoot ? safeRealpath(configuredRoot) : null;
      const resolved: PortfolioResolvedProject = {
        project_ref: projectRef,
        expected_vault: projectDefinition.expected_vault,
        configured_root: configuredRoot ?? '',
        realpath,
        binding_path: realpath ? path.join(realpath, '.aspg', 'portfolio.yaml') : null,
        binding: null,
      };
      projects.set(projectRef, resolved);

      if (!configuredRoot) {
        addDiagnostic(
          diagnostics,
          'error',
          'project-root-unresolved',
          `device ${options.deviceId} has no project root for ${projectRef}`,
          { project_ref: projectRef },
        );
        continue;
      }
      if (!realpath) {
        addDiagnostic(
          diagnostics,
          'error',
          'project-root-unavailable',
          `project root is unavailable: ${configuredRoot}`,
          { project_ref: projectRef },
        );
        continue;
      }
      const owner = realpathOwners.get(realpath);
      if (owner) {
        addDiagnostic(
          diagnostics,
          'error',
          'project-realpath-collision',
          `${projectRef} and ${owner} resolve to the same project root`,
          { project_ref: projectRef },
        );
      } else {
        realpathOwners.set(realpath, projectRef);
      }
    }

    try {
      const candidateStateRoot = resolveWithExistingAncestor(device.state_root);
      const protectedRoots = [
        ...[...projects.values()].flatMap((project) =>
          project.realpath ? [project.realpath] : []),
        ...Object.values(device.source_roots).flatMap((sourceRoot) => {
          const realpath = safeRealpath(sourceRoot);
          return realpath ? [realpath] : [];
        }),
      ];
      if (protectedRoots.some((protectedRoot) =>
        pathsOverlap(protectedRoot, candidateStateRoot))) {
        addDiagnostic(
          diagnostics,
          'error',
          'device-state-root-overlap',
          'device-local state_root resolves inside or above a source/project root',
        );
      } else {
        deviceStateRoot = candidateStateRoot;
      }
    } catch (error) {
      addDiagnostic(
        diagnostics,
        'error',
        'device-state-root-unavailable',
        (error as Error).message,
      );
    }
  }

  const manifestSkillIds = Object.keys(manifest.skills).sort(compareText);
  const lockSkillIds = Object.keys(lock.skills).sort(compareText);
  for (const skillId of manifestSkillIds) {
    const definition = manifest.skills[skillId];
    const locked = lock.skills[skillId];
    if (forbiddenCanonicalSuffix(skillId)) {
      addDiagnostic(
        diagnostics,
        'error',
        'canonical-suffix-forbidden',
        `canonical Skill ID has a project/device suffix: ${skillId}`,
        { skill_id: skillId },
      );
    }
    if (!manifest.sources[definition.source]) {
      addDiagnostic(
        diagnostics,
        'error',
        'skill-source-unresolved',
        `unknown source ${definition.source}`,
        { skill_id: skillId },
      );
    }
    if (!locked) {
      addDiagnostic(
        diagnostics,
        'error',
        'skill-lock-missing',
        'canonical Skill has no lock resolution',
        { skill_id: skillId },
      );
    }

    let sourcePath: string | null = null;
    let digest: SkillSubtreeDigest | null = null;
    if (device) {
      const configuredSourceRoot = device.source_roots[definition.source];
      const sourceRoot = configuredSourceRoot ? safeRealpath(configuredSourceRoot) : null;
      if (configuredSourceRoot && !sourceRoot) {
        addDiagnostic(
          diagnostics,
          'error',
          'source-root-unavailable',
          `source root is unavailable: ${configuredSourceRoot}`,
          { skill_id: skillId },
        );
      } else if (sourceRoot) {
        const candidate = path.resolve(sourceRoot, definition.path);
        const candidateRealpath = safeRealpath(candidate);
        if (!candidateRealpath) {
          addDiagnostic(
            diagnostics,
            'error',
            'skill-subtree-unavailable',
            `Skill subtree is unavailable: ${definition.path}`,
            { skill_id: skillId },
          );
        } else if (!isWithin(sourceRoot, candidateRealpath)) {
          addDiagnostic(
            diagnostics,
            'error',
            'skill-subtree-escape',
            `Skill subtree escapes source ${definition.source}`,
            { skill_id: skillId },
          );
        } else {
          sourcePath = candidateRealpath;
          try {
            digest = hashSkillSubtree(
              candidateRealpath,
              definition.path === '.'
                ? { rootSkill: true, revision: locked?.source_revision }
                : undefined,
            );
          } catch (error) {
            addDiagnostic(
              diagnostics,
              'error',
              'skill-subtree-unreadable',
              (error as Error).message,
              { skill_id: skillId },
            );
          }
        }
      }
    }

    if (locked) {
      if (locked.source !== definition.source || locked.path !== definition.path) {
        addDiagnostic(
          diagnostics,
          'error',
          'skill-lock-resolution-divergent',
          'lock source/path differs from the canonical Portfolio Manifest',
          { skill_id: skillId },
        );
      }
      const lockedSource = lock.sources[definition.source];
      if (!lockedSource || locked.source_revision !== lockedSource.revision) {
        addDiagnostic(
          diagnostics,
          'error',
          'skill-source-revision-divergent',
          'Skill source_revision differs from the single source lock revision',
          { skill_id: skillId },
        );
      }
      if (digest && digest.tree_hash !== locked.tree_hash) {
        addDiagnostic(
          diagnostics,
          'error',
          'skill-subtree-drift',
          `${digest.tree_hash} != ${locked.tree_hash}`,
          { skill_id: skillId },
        );
      }
      if (digest && !equalSets(digest.executable_files, locked.executable_files)) {
        addDiagnostic(
          diagnostics,
          'error',
          'skill-executable-manifest-drift',
          'executable file manifest differs from the Portfolio Lock',
          { skill_id: skillId },
        );
      }
    }

    skills.set(skillId, {
      skill_id: skillId,
      source: definition.source,
      source_revision: locked?.source_revision ?? null,
      path: definition.path,
      source_path: sourcePath,
      tree_hash: digest?.tree_hash ?? null,
      executable_files: digest?.executable_files ?? [],
      locked_tree_hash: locked?.tree_hash ?? null,
      locked_executable_files: locked?.executable_files ?? [],
      ownership: definition.ownership,
      exposure_name: definition.exposure_name,
    });
  }

  for (const skillId of lockSkillIds) {
    if (!manifest.skills[skillId]) {
      addDiagnostic(
        diagnostics,
        'error',
        'skill-lock-orphan',
        'Portfolio Lock contains an unknown canonical Skill',
        { skill_id: skillId },
      );
    }
  }

  for (const deploymentName of Object.keys(manifest.deployments).sort(compareText)) {
    const definition = manifest.deployments[deploymentName];
    if (!manifest.projects[definition.project_ref]) {
      addDiagnostic(
        diagnostics,
        'error',
        'project-reference-unresolved',
        `unknown project ${definition.project_ref}`,
        { deployment: deploymentName, project_ref: definition.project_ref },
      );
    }

    const resolved = resolveSelectedSkills(manifest, deploymentName, diagnostics);
    const lockedDeployment = lock.deployments[deploymentName];
    resolved.locked_skills = lockedDeployment?.resolved_skills ?? [];
    resolved.project_realpath = projects.get(definition.project_ref)?.realpath ?? null;
    deployments.set(deploymentName, resolved);

    if (!lockedDeployment) {
      addDiagnostic(
        diagnostics,
        'error',
        'deployment-lock-missing',
        'deployment has no Portfolio Lock resolution',
        { deployment: deploymentName },
      );
    } else if (!equalSets(resolved.selected_skills, lockedDeployment.resolved_skills)) {
      addDiagnostic(
        diagnostics,
        'error',
        'deployment-resolution-divergent',
        'locked resolved_skills differ from deterministic Manifest resolution',
        { deployment: deploymentName },
      );
    }

    const exposureOwners = new Map<string, string>();
    for (const skillId of resolved.selected_skills) {
      const skill = manifest.skills[skillId];
      if (!skill) continue;
      const owner = exposureOwners.get(skill.exposure_name);
      if (owner) {
        addDiagnostic(
          diagnostics,
          'error',
          'deployment-exposure-collision',
          `${owner} and ${skillId} expose ${skill.exposure_name}`,
          { deployment: deploymentName, skill_id: skillId },
        );
      } else {
        exposureOwners.set(skill.exposure_name, skillId);
      }
    }

    const project = projects.get(definition.project_ref);
    if (project?.binding_path) {
      try {
        project.binding = readYaml(
          project.binding_path,
          ProjectBindingSchema,
          `Project Binding for ${definition.project_ref}`,
        );
        if (project.binding.portfolio.deployment !== deploymentName) {
          addDiagnostic(
            diagnostics,
            'error',
            'project-binding-deployment-mismatch',
            `${project.binding.portfolio.deployment} != ${deploymentName}`,
            { deployment: deploymentName, project_ref: definition.project_ref },
          );
        }
      } catch (error) {
        addDiagnostic(
          diagnostics,
          'error',
          'project-binding-invalid',
          (error as Error).message,
          { deployment: deploymentName, project_ref: definition.project_ref },
        );
      }
    }
  }

  for (const deploymentName of Object.keys(lock.deployments).sort(compareText)) {
    if (!manifest.deployments[deploymentName]) {
      addDiagnostic(
        diagnostics,
        'error',
        'deployment-lock-orphan',
        'Portfolio Lock contains an unknown deployment',
        { deployment: deploymentName },
      );
    }
  }

  const bindingIdentities = [...projects.values()]
    .filter((project) => project.binding)
    .map((project) => ({
      project_ref: project.project_ref,
      repository: project.binding!.portfolio.repository,
      revision: project.binding!.portfolio.revision,
    }));
  if (bindingIdentities.length > 1) {
    const expected = bindingIdentities[0];
    for (const identity of bindingIdentities.slice(1)) {
      if (
        identity.repository !== expected.repository
        || identity.revision !== expected.revision
      ) {
        addDiagnostic(
          diagnostics,
          'error',
          'portfolio-binding-divergent',
          `${identity.project_ref} does not bind to the same Portfolio repository/revision`,
          { project_ref: identity.project_ref },
        );
      }
    }
  }

  for (const exception of lock.exceptions) {
    const deployment = deployments.get(exception.deployment);
    const lockedSkill = lock.skills[exception.skill];
    if (!deployment) {
      addDiagnostic(
        diagnostics,
        'error',
        'exception-deployment-unresolved',
        `unknown deployment ${exception.deployment}`,
        { deployment: exception.deployment, skill_id: exception.skill },
      );
    }
    if (!lockedSkill) {
      addDiagnostic(
        diagnostics,
        'error',
        'exception-skill-unresolved',
        `unknown canonical Skill ${exception.skill}`,
        { deployment: exception.deployment, skill_id: exception.skill },
      );
    }
    if (deployment && !deployment.selected_skills.includes(exception.skill)) {
      addDiagnostic(
        diagnostics,
        'error',
        'exception-skill-not-selected',
        'migration exception targets a Skill not selected by the deployment',
        { deployment: exception.deployment, skill_id: exception.skill },
      );
    }
    if (exception.expires_at <= asOf) {
      addDiagnostic(
        diagnostics,
        'error',
        'migration-exception-expired',
        `exception expired at ${exception.expires_at}`,
        { deployment: exception.deployment, skill_id: exception.skill },
      );
    } else {
      addDiagnostic(
        diagnostics,
        'warning',
        'migration-exception-active',
        `temporary exception owned by ${exception.owner} expires ${exception.expires_at}`,
        { deployment: exception.deployment, skill_id: exception.skill },
      );
    }
  }

  return {
    manifest,
    lock,
    registry,
    deviceId: options.deviceId,
    deviceStateRoot,
    asOf,
    projects,
    skills,
    deployments,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function planFromState(state: PortfolioState, deploymentName: string): PortfolioPlan {
  const deployment = state.deployments.get(deploymentName);
  const definition = state.manifest.deployments[deploymentName];
  const project = deployment ? state.projects.get(deployment.project_ref) : undefined;
  const errors = state.diagnostics.filter((diagnostic) => (
    diagnostic.severity === 'error'
    && (!diagnostic.deployment || diagnostic.deployment === deploymentName)
  ));
  const warnings = state.diagnostics.filter((diagnostic) => (
    diagnostic.severity === 'warning'
    && (!diagnostic.deployment || diagnostic.deployment === deploymentName)
  ));
  const entries: PortfolioPlanEntry[] = [];

  if (deployment && definition) {
    for (const skillId of deployment.selected_skills) {
      const skill = state.skills.get(skillId);
      const locked = state.lock.skills[skillId];
      const manifestSkill = state.manifest.skills[skillId];
      if (!skill || !manifestSkill) continue;
      const target = skill.ownership === 'catalog-only' || !project?.realpath
        ? null
        : path.join(project.realpath, '.agents', 'skills', skill.exposure_name);
      const expectedDigest = skill.tree_hash
        ? { tree_hash: skill.tree_hash, executable_files: skill.executable_files }
        : null;
      const health = resolveTargetHealth(
        skill.ownership,
        skill.source_path,
        expectedDigest,
        target,
      );
      if (health.health === 'exposure-collision' || health.health === 'foreign-link') {
        errors.push({
          severity: 'error',
          code: 'deployment-target-collision',
          message: `${skillId}: ${health.health}`,
          deployment: deploymentName,
          project_ref: deployment.project_ref,
          skill_id: skillId,
        });
      }
      const exception = state.lock.exceptions.find(
        (candidate) => candidate.deployment === deploymentName
          && candidate.skill === skillId
          && candidate.expires_at > state.asOf,
      );
      entries.push({
        skill_id: skillId,
        action: health.action,
        exposure_name: skill.exposure_name,
        ownership: skill.ownership,
        backend: backendFor(state, skill.ownership),
        source: skill.source,
        source_revision: locked?.source_revision ?? null,
        source_path: skill.source_path,
        tree_hash: locked?.tree_hash ?? null,
        executable_files: locked?.executable_files ?? [],
        target,
        health: health.health,
        migration_exception: exception
          ? {
            pinned_revision: exception.pinned_revision,
            owner: exception.owner,
            reason: exception.reason,
            expires_at: exception.expires_at,
          }
          : null,
      });
    }
  } else {
    errors.push({
      severity: 'error',
      code: 'deployment-reference-unresolved',
      message: `unknown deployment ${deploymentName}`,
      deployment: deploymentName,
    });
  }

  return {
    version: 1,
    portfolio: state.manifest.portfolio,
    device: state.deviceId,
    as_of: state.asOf,
    deployment: deploymentName,
    project_ref: deployment?.project_ref ?? null,
    project_realpath: deployment?.project_realpath ?? null,
    selected_profiles: deployment?.selected_profiles ?? [],
    command_maturity: state.manifest.command_maturity.portfolio_plan,
    activation_lock: state.deviceStateRoot
      ? path.join(
        state.deviceStateRoot,
        'locks',
        `${state.manifest.portfolio}-${deploymentName}.lock`,
      )
      : null,
    lock_acquired: false,
    budgets: deployment?.budgets ?? {
      selected_skills: 0,
      max_skills: 0,
      description_chars: 0,
      max_description_chars: 0,
    },
    entries: entries.sort((a, b) => compareText(a.skill_id, b.skill_id)),
    errors: sortDiagnostics(errors),
    warnings: sortDiagnostics(warnings),
    writes_performed: 0,
  };
}

export function validatePortfolio(options: PortfolioControlOptions): PortfolioValidation {
  const state = buildState(options);
  return {
    version: 1,
    portfolio: state.manifest.portfolio,
    device: state.deviceId,
    as_of: state.asOf,
    valid: !state.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    projects: [...state.projects.values()].sort(
      (a, b) => compareText(a.project_ref, b.project_ref),
    ),
    deployments: [...state.deployments.values()].sort(
      (a, b) => compareText(a.deployment, b.deployment),
    ),
    diagnostics: state.diagnostics,
    writes_performed: 0,
  };
}

export function buildPortfolioPlan(
  options: PortfolioControlOptions & { deployment: string },
): PortfolioPlan {
  return planFromState(buildState(options), options.deployment);
}

export function buildPortfolioStatus(options: PortfolioControlOptions): PortfolioStatus {
  const state = buildState(options);
  const plans = [...state.deployments.keys()]
    .sort(compareText)
    .map((deployment) => planFromState(state, deployment));
  const diagnostics = sortDiagnostics([
    ...state.diagnostics,
    ...plans.flatMap((plan) => [...plan.errors, ...plan.warnings]),
  ]);
  return {
    version: 1,
    portfolio: state.manifest.portfolio,
    device: state.deviceId,
    as_of: state.asOf,
    all: true,
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    deployments: plans.map((plan) => ({
      deployment: plan.deployment,
      project_ref: plan.project_ref ?? '',
      project_realpath: plan.project_realpath,
      selected_profiles: plan.selected_profiles,
      selected_skills: plan.entries.length,
      locked_skills: state.deployments.get(plan.deployment)?.locked_skills.length ?? 0,
      healthy: plan.entries.filter((entry) => entry.health === 'healthy').length,
      pending: plan.entries.filter((entry) => (
        entry.health === 'not-deployed' || entry.health === 'catalog-only'
      )).length,
      blocked: plan.entries.filter((entry) => entry.action === 'blocked').length,
      active_exceptions: plan.entries.filter((entry) => entry.migration_exception).length,
      errors: plan.errors.length,
      warnings: plan.warnings.length,
    })),
    diagnostics,
    writes_performed: 0,
  };
}

export function buildPortfolioDeploymentView(
  options: PortfolioControlOptions,
): PortfolioDeploymentView {
  const state = buildState(options);
  const plans = [...state.deployments.keys()]
    .sort(compareText)
    .map((deployment) => planFromState(state, deployment));
  const diagnostics = sortDiagnostics([
    ...state.diagnostics,
    ...plans.flatMap((plan) => [...plan.errors, ...plan.warnings]),
  ]);
  return {
    version: 1,
    portfolio: state.manifest.portfolio,
    device: state.deviceId,
    as_of: state.asOf,
    all: true,
    rows: plans.flatMap((plan) => plan.entries.map((entry) => ({
      deployment: plan.deployment,
      project_ref: plan.project_ref ?? '',
      project_realpath: plan.project_realpath,
      selected_profiles: plan.selected_profiles,
      canonical_skill_id: entry.skill_id,
      exposure_name: entry.exposure_name,
      source_revision: entry.source_revision,
      subtree_hash: entry.tree_hash,
      target: entry.target,
      health: entry.health,
    }))).sort(
      (a, b) => compareText(a.deployment, b.deployment)
        || compareText(a.canonical_skill_id, b.canonical_skill_id),
    ),
    diagnostics,
    writes_performed: 0,
  };
}
