/**
 * Read-only Wave 6 runtime resolver.
 *
 * This module converts portable Portfolio intent and device-local Registry v2
 * roots into a deterministic operation model. It deliberately performs no
 * filesystem mutation and accepts only explicit fixtures below $TMPDIR.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PortfolioDeviceRegistryV2Schema,
  PortfolioLockSchema,
  PortfolioManifestSchema,
  ProjectBindingSchema,
  type PortfolioDeviceRegistryV2,
  type PortfolioLock,
  type PortfolioManifest,
  type ProjectBinding,
} from './portfolio-schema.js';
import type {
  LockedContentIdentity,
  PortfolioDeploymentBackend,
  ProjectedDataDependency,
  ProviderPreflight,
} from './portfolio-runtime-types.js';

const GENERATED_CONFIG_PATH = '.aspg/generated/private-skill-packs.json';
const D9_SKILL_ID = 'martin/artifact-template-cstc-eu-rspo-default-deck';
const D9_DEPENDENCY_ID = 'cstc-eu-rspo-employer-pack';
const D9_PACK_ID = 'work-private/cstc-eu-rspo-default-deck';

export class PortfolioRuntimeResolverError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'PortfolioRuntimeResolverError';
  }
}

export interface PortfolioRuntimeResolverRequest {
  fixture_root: string;
  manifest: PortfolioManifest;
  lock: PortfolioLock;
  device_registry: PortfolioDeviceRegistryV2;
  binding: ProjectBinding;
  device_id: string;
  deployment: string;
}

export interface ResolvedRuntimeDependency extends ProjectedDataDependency {
  repository_root: string;
  source_repository: string;
}

export interface ResolvedRuntimeSkill {
  skill_id: string;
  exposure_name: string;
  repository_root: string;
  source_repository: string;
  target: string;
  locked: LockedContentIdentity;
  dependencies: ResolvedRuntimeDependency[];
}

export interface GeneratedPrivateSkillPackConfig {
  path: typeof GENERATED_CONFIG_PATH;
  model: {
    schema_version: 1;
    packs: Array<{
      pack_id: string;
      root: string;
    }>;
  };
}

export interface ResolvedPortfolioRuntime {
  writes_performed: 0;
  fixture_root: string;
  portfolio: string;
  device_id: string;
  deployment: string;
  project_ref: string;
  project_root: string;
  runtime_root: string;
  state_root: string;
  provider: ProviderPreflight['provider'];
  backend: PortfolioDeploymentBackend;
  skills: ResolvedRuntimeSkill[];
  generated_private_skill_packs: GeneratedPrivateSkillPackConfig;
}

function fail(code: string, message: string, options?: ErrorOptions): never {
  throw new PortfolioRuntimeResolverError(code, message, options);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative));
}

function existingDirectory(candidate: string, label: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isDirectory()) {
      fail('ASPG_RUNTIME_ROOT_INVALID', `${label} is not a directory`);
    }
  } catch (error) {
    if (error instanceof PortfolioRuntimeResolverError) throw error;
    fail(
      'ASPG_RUNTIME_ROOT_INVALID',
      `${label} is unavailable: ${candidate}`,
      { cause: error },
    );
  }
  return resolved;
}

function fixtureRoot(input: string): string {
  const resolved = existingDirectory(input, 'fixture_root');
  const temporary = fs.realpathSync(os.tmpdir());
  if (resolved === temporary || !isWithin(temporary, resolved)) {
    fail(
      'ASPG_RUNTIME_REAL_PATH_REFUSED',
      'fixture_root must be an explicit child of the system temporary directory',
    );
  }
  return resolved;
}

function fixtureDirectory(
  fixture: string,
  candidate: string,
  label: string,
): string {
  if (!path.isAbsolute(candidate)) {
    fail('ASPG_RUNTIME_ROOT_INVALID', `${label} must be absolute`);
  }
  const resolved = existingDirectory(candidate, label);
  if (!isWithin(fixture, resolved)) {
    fail(
      'ASPG_RUNTIME_PATH_ESCAPE',
      `${label} escapes the explicit fixture_root`,
    );
  }
  return resolved;
}

function projectRootFromRuntime(runtimeRoot: string): string {
  if (
    path.basename(runtimeRoot) !== 'skills'
    || path.basename(path.dirname(runtimeRoot)) !== '.agents'
  ) {
    fail(
      'ASPG_RUNTIME_LAYOUT_INVALID',
      'runtime root must be the project .agents/skills directory',
    );
  }
  return path.dirname(path.dirname(runtimeRoot));
}

function parseInputs(request: PortfolioRuntimeResolverRequest): {
  manifest: PortfolioManifest;
  lock: PortfolioLock;
  registry: PortfolioDeviceRegistryV2;
  binding: ProjectBinding;
} {
  try {
    return {
      manifest: PortfolioManifestSchema.parse(request.manifest),
      lock: PortfolioLockSchema.parse(request.lock),
      registry: PortfolioDeviceRegistryV2Schema.parse(request.device_registry),
      binding: ProjectBindingSchema.parse(request.binding),
    };
  } catch (error) {
    fail(
      'ASPG_RUNTIME_INPUT_INVALID',
      'Manifest, Lock, Device Registry v2, or binding is invalid',
      { cause: error },
    );
  }
}

function resolvedSkillIds(
  manifest: PortfolioManifest,
  lock: PortfolioLock,
  deploymentId: string,
): string[] {
  const deployment = manifest.deployments[deploymentId];
  if (!deployment) {
    fail('ASPG_RUNTIME_DEPLOYMENT_UNKNOWN', `unknown deployment: ${deploymentId}`);
  }
  const selected = new Set<string>(deployment.include);
  const excluded = new Set<string>(deployment.exclude);
  for (const profileId of deployment.profiles) {
    const profile = manifest.profiles[profileId];
    if (!profile) {
      fail('ASPG_RUNTIME_PROFILE_UNKNOWN', `unknown profile: ${profileId}`);
    }
    profile.include.forEach((skillId) => selected.add(skillId));
    profile.exclude.forEach((skillId) => excluded.add(skillId));
  }
  excluded.forEach((skillId) => selected.delete(skillId));
  const resolved = [...selected].sort(compareText);
  for (const skillId of resolved) {
    if (!manifest.skills[skillId]) {
      fail('ASPG_RUNTIME_SKILL_UNKNOWN', `unknown selected Skill: ${skillId}`);
    }
  }
  const lockedDeployment = lock.deployments[deploymentId];
  if (!lockedDeployment) {
    fail(
      'ASPG_RUNTIME_DEPLOYMENT_LOCK_MISSING',
      `deployment has no Lock entry: ${deploymentId}`,
    );
  }
  if (!sameStrings(resolved, lockedDeployment.resolved_skills)) {
    fail(
      'ASPG_RUNTIME_DEPLOYMENT_LOCK_MISMATCH',
      `Manifest and Lock resolve different Skills for ${deploymentId}`,
    );
  }
  return resolved;
}

function lockedIdentity(
  manifest: PortfolioManifest,
  lock: PortfolioLock,
  skillId: string,
): LockedContentIdentity {
  const definition = manifest.skills[skillId];
  const locked = lock.skills[skillId];
  if (!locked) {
    fail('ASPG_RUNTIME_SKILL_LOCK_MISSING', `Skill has no Lock entry: ${skillId}`);
  }
  if (locked.source !== definition.source || locked.path !== definition.path) {
    fail(
      'ASPG_RUNTIME_SKILL_LOCK_MISMATCH',
      `Skill source/path differs between Manifest and Lock: ${skillId}`,
    );
  }
  const sourceLock = lock.sources[definition.source];
  if (
    !sourceLock
    || sourceLock.revision !== locked.source_revision
  ) {
    fail(
      'ASPG_RUNTIME_SOURCE_LOCK_MISMATCH',
      `Skill revision differs from its locked source: ${skillId}`,
    );
  }
  return {
    source: locked.source,
    source_revision: locked.source_revision,
    path: locked.path,
    tree_hash: locked.tree_hash,
    executable_files: [...locked.executable_files],
  };
}

function assertDependencyScope(
  manifest: PortfolioManifest,
  skillId: string,
): void {
  const definition = manifest.skills[skillId];
  for (const dependency of definition.data_dependencies) {
    if (dependency.source !== definition.source) {
      fail(
        'ASPG_RUNTIME_DEPENDENCY_SOURCE_MISMATCH',
        `${skillId}/${dependency.id} must use its Skill source`,
      );
    }
    if (manifest.sources[dependency.source]?.privacy !== 'private') {
      fail(
        'ASPG_RUNTIME_DEPENDENCY_PRIVACY_INVALID',
        `${skillId}/${dependency.id} must use a private source`,
      );
    }
    for (const deploymentId of dependency.deployments) {
      const dependencyDeployment = manifest.deployments[deploymentId];
      const project = dependencyDeployment
        ? manifest.projects[dependencyDeployment.project_ref]
        : undefined;
      if (!dependencyDeployment || project?.expected_vault !== 'work-pkm') {
        fail(
          'ASPG_RUNTIME_DEPENDENCY_SCOPE_INVALID',
          `${skillId}/${dependency.id} must be scoped only to Work deployments`,
        );
      }
    }
  }
}

function resolvedDependencies(
  manifest: PortfolioManifest,
  lock: PortfolioLock,
  skillId: string,
  deployment: string,
  sourceRoot: string,
): ResolvedRuntimeDependency[] {
  const definition = manifest.skills[skillId];
  const skillLock = lock.skills[skillId];
  if (!skillLock) {
    fail('ASPG_RUNTIME_SKILL_LOCK_MISSING', `Skill has no Lock entry: ${skillId}`);
  }
  assertDependencyScope(manifest, skillId);
  const manifestIds = definition.data_dependencies
    .map((dependency) => dependency.id)
    .sort(compareText);
  const lockIds = Object.keys(skillLock.data_dependencies).sort(compareText);
  if (!sameStrings(manifestIds, lockIds)) {
    fail(
      'ASPG_RUNTIME_DEPENDENCY_LOCK_MISMATCH',
      `Manifest and Lock dependencies differ for ${skillId}`,
    );
  }

  const dependencies = definition.data_dependencies
    .filter((dependency) => (
      dependency.required && dependency.deployments.includes(deployment)
    ))
    .sort((left, right) => compareText(left.id, right.id))
    .map((dependency): ResolvedRuntimeDependency => {
      const locked = skillLock.data_dependencies[dependency.id];
      if (
        !locked
        || locked.path !== dependency.path
        || locked.source_revision !== skillLock.source_revision
      ) {
        fail(
          'ASPG_RUNTIME_DEPENDENCY_LOCK_MISMATCH',
          `Manifest and Lock identity differs for ${skillId}/${dependency.id}`,
        );
      }
      const target = `.aspg/dependencies/${dependency.id}`;
      return {
        id: dependency.id,
        privacy: dependency.privacy,
        target,
        required: dependency.required,
        source: dependency.source,
        source_revision: locked.source_revision,
        path: locked.path,
        tree_hash: locked.tree_hash,
        executable_files: [...locked.executable_files],
        repository_root: sourceRoot,
        source_repository: manifest.sources[dependency.source].repository,
      };
    });

  if (
    skillId === D9_SKILL_ID
    && !dependencies.some((dependency) => dependency.id === D9_DEPENDENCY_ID)
  ) {
    fail(
      'ASPG_RUNTIME_D9_SCOPE_INVALID',
      'D9 is selectable only where its required Work-private pack is deployed',
    );
  }
  return dependencies;
}

function packId(dependency: ResolvedRuntimeDependency): string {
  if (dependency.id === D9_DEPENDENCY_ID) return D9_PACK_ID;
  return `work-private/${dependency.id}`;
}

export function resolvePortfolioRuntime(
  request: PortfolioRuntimeResolverRequest,
): ResolvedPortfolioRuntime {
  const parsed = parseInputs(request);
  const manifest = parsed.manifest;
  const lock = parsed.lock;
  const registry = parsed.registry;
  const binding = parsed.binding;
  const fixture = fixtureRoot(request.fixture_root);

  if (binding.portfolio.deployment !== request.deployment) {
    fail(
      'ASPG_RUNTIME_BINDING_MISMATCH',
      `binding selects ${binding.portfolio.deployment}, not ${request.deployment}`,
    );
  }
  const deployment = manifest.deployments[request.deployment];
  if (!deployment) {
    fail('ASPG_RUNTIME_DEPLOYMENT_UNKNOWN', `unknown deployment: ${request.deployment}`);
  }
  const project = manifest.projects[deployment.project_ref];
  if (!project) {
    fail(
      'ASPG_RUNTIME_PROJECT_UNKNOWN',
      `unknown project_ref: ${deployment.project_ref}`,
    );
  }
  const device = registry.devices[request.device_id];
  if (!device) {
    fail('ASPG_RUNTIME_DEVICE_UNKNOWN', `unknown device: ${request.device_id}`);
  }
  const runtimeEntries = Object.entries(device.runtime_roots)
    .filter(([, entry]) => entry.project_ref === deployment.project_ref);
  if (runtimeEntries.length !== 1) {
    fail(
      'ASPG_RUNTIME_ROOT_AMBIGUOUS',
      `expected exactly one runtime root for ${deployment.project_ref}`,
    );
  }
  const [, runtimeDefinition] = runtimeEntries[0];
  const stateRoot = fixtureDirectory(fixture, device.state_root, 'state_root');
  const runtimeRoot = fixtureDirectory(fixture, runtimeDefinition.path, 'runtime_root');
  const projectRoot = fixtureDirectory(
    fixture,
    projectRootFromRuntime(runtimeRoot),
    'project_root',
  );
  if (isWithin(projectRoot, stateRoot) || isWithin(stateRoot, projectRoot)) {
    fail(
      'ASPG_RUNTIME_LAYOUT_INVALID',
      'device-local state_root must be separate from project_root',
    );
  }

  const selected = resolvedSkillIds(manifest, lock, request.deployment);
  const skills = selected.map((skillId): ResolvedRuntimeSkill => {
    const definition = manifest.skills[skillId];
    if (
      definition.ownership !== 'managed-link'
      && definition.ownership !== 'managed-materialized'
    ) {
      fail(
        'ASPG_RUNTIME_SKILL_NOT_DEPLOYABLE',
        `selected Skill is not centrally deployable: ${skillId}`,
      );
    }
    const sourceDefinition = manifest.sources[definition.source];
    if (!sourceDefinition) {
      fail(
        'ASPG_RUNTIME_SOURCE_UNKNOWN',
        `unknown source for ${skillId}: ${definition.source}`,
      );
    }
    const sourceRootInput = device.source_roots[definition.source];
    if (!sourceRootInput) {
      fail(
        'ASPG_RUNTIME_SOURCE_ROOT_MISSING',
        `device has no source root for ${definition.source}`,
      );
    }
    const sourceRoot = fixtureDirectory(
      fixture,
      sourceRootInput,
      `source_roots.${definition.source}`,
    );
    const target = path.join(runtimeRoot, definition.exposure_name);
    if (!isWithin(runtimeRoot, target) || target === runtimeRoot) {
      fail('ASPG_RUNTIME_TARGET_ESCAPE', `unsafe Skill target for ${skillId}`);
    }
    return {
      skill_id: skillId,
      exposure_name: definition.exposure_name,
      repository_root: sourceRoot,
      source_repository: sourceDefinition.repository,
      target,
      locked: lockedIdentity(manifest, lock, skillId),
      dependencies: resolvedDependencies(
        manifest,
        lock,
        skillId,
        request.deployment,
        sourceRoot,
      ),
    };
  });

  const packEntries = skills
    .flatMap((skill) => skill.dependencies)
    .map((dependency) => ({
      pack_id: packId(dependency),
      root: dependency.target,
    }))
    .sort((left, right) => (
      compareText(left.pack_id, right.pack_id)
      || compareText(left.root, right.root)
    ));
  if (new Set(packEntries.map((entry) => entry.pack_id)).size !== packEntries.length) {
    fail('ASPG_RUNTIME_PACK_ID_COLLISION', 'generated private pack IDs must be unique');
  }

  return {
    writes_performed: 0,
    fixture_root: fixture,
    portfolio: manifest.portfolio,
    device_id: request.device_id,
    deployment: request.deployment,
    project_ref: deployment.project_ref,
    project_root: projectRoot,
    runtime_root: runtimeRoot,
    state_root: stateRoot,
    provider: runtimeDefinition.storage_provider,
    backend: runtimeDefinition.deployment_backend,
    skills,
    generated_private_skill_packs: {
      path: GENERATED_CONFIG_PATH,
      model: {
        schema_version: 1,
        packs: packEntries,
      },
    },
  };
}
