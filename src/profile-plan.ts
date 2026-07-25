/**
 * profile-plan.ts — Deterministic, read-only Profile exposure planning.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  DeviceRegistrySchema,
  ProjectLockSchema,
  ProjectManifestSchema,
  type DeviceRegistry,
  type InstallBackend,
  type ProjectLock,
  type ProjectManifest,
  type RuntimeOwnershipMode,
} from './profile-schema.js';

export type PlanAction =
  | 'keep-project-local'
  | 'noop'
  | 'create'
  | 'change'
  | 'remove'
  | 'catalog'
  | 'runtime-native';

export interface ProfilePlanEntry {
  name: string;
  action: PlanAction;
  ownership: RuntimeOwnershipMode;
  backend: InstallBackend;
  source: string | null;
  target: string | null;
  expected_tree_hash: string | null;
  previous_tree_hash: string | null;
  replacement: string | null;
}

export interface ProfilePlan {
  version: 1;
  project: string;
  profile: string;
  device: string;
  runtime: string;
  command_maturity: 'current' | 'mvp' | 'future';
  concurrency: {
    mode: 'stable-core-catalog-on-demand';
    hot_switch_shared_runtime: false;
    activation_lock: string;
    lock_acquired: false;
  };
  budgets: {
    selected_skills: number;
    max_skills: number;
    description_chars: number;
    max_description_chars: number;
  };
  entries: ProfilePlanEntry[];
  errors: string[];
  warnings: string[];
  writes_performed: 0;
}

export interface BuildProfilePlanOptions {
  projectPath: string;
  profile: string;
  deviceId: string;
  runtime: string;
  manifestPath: string;
  lockPath: string;
  deviceRegistryPath: string;
}

const HASH_IGNORES = new Set(['.git', '.aspg-copy-fallback']);

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function hashDirectory(root: string): string {
  const hash = crypto.createHash('sha256');

  function visit(dir: string, prefix = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !HASH_IGNORES.has(entry.name))
      .sort((a, b) => compareText(a.name, b.name));

    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir\0${relative}\0`);
        visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${relative}\0${fs.readlinkSync(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(fs.readFileSync(absolute));
        hash.update('\0');
      }
    }
  }

  visit(path.resolve(root));
  return `sha256:${hash.digest('hex')}`;
}

function readYaml<T>(
  filePath: string,
  schema: { parse(value: unknown): T },
  label: string,
): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  const doc = parseDocument(fs.readFileSync(filePath, 'utf-8'));
  if (doc.errors.length > 0) {
    throw new Error(`${label} YAML error: ${doc.errors.map((error) => error.message).join(', ')}`);
  }
  return schema.parse(doc.toJSON());
}

function resolveProjectPath(projectPath: string, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(projectPath, candidate);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function currentTreeHash(candidate: string): string | null {
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(candidate);
      return fs.statSync(resolved).isDirectory() ? hashDirectory(resolved) : null;
    }
    return stat.isDirectory() ? hashDirectory(candidate) : null;
  } catch {
    return null;
  }
}

function resolveSkillSource(
  manifest: ProjectManifest,
  registry: DeviceRegistry,
  projectPath: string,
  deviceId: string,
  skillName: string,
  errors: string[],
): string | null {
  const skill = manifest.skills[skillName];
  const source = manifest.sources[skill.source];
  if (!source) {
    errors.push(`${skillName}: unknown source ${skill.source}`);
    return null;
  }

  if (source.kind === 'runtime-native') return null;
  if (source.kind === 'project-local') {
    const resolved = resolveProjectPath(projectPath, skill.path);
    if (!isWithin(projectPath, resolved)) {
      errors.push(`${skillName}: project-local path escapes project root`);
      return null;
    }
    return resolved;
  }

  const device = registry.devices[deviceId];
  const sourceRoot = device.source_roots[skill.source];
  if (!sourceRoot) {
    errors.push(`${skillName}: device ${deviceId} has no source root for ${skill.source}`);
    return null;
  }
  const resolved = path.resolve(sourceRoot, skill.path);
  if (!isWithin(sourceRoot, resolved)) {
    errors.push(`${skillName}: source path escapes ${skill.source} root`);
    return null;
  }
  return resolved;
}

function validateReferences(manifest: ProjectManifest, errors: string[]): void {
  for (const name of manifest.core) {
    if (!manifest.skills[name]) errors.push(`core references unknown skill ${name}`);
  }
  for (const [profileName, profile] of Object.entries(manifest.profiles)) {
    for (const name of [...profile.include, ...profile.exclude]) {
      if (!manifest.skills[name]) {
        errors.push(`profile ${profileName} references unknown skill ${name}`);
      }
    }
  }
  for (const [name, skill] of Object.entries(manifest.skills)) {
    const source = manifest.sources[skill.source];
    if (!source) {
      errors.push(`${name}: unknown source ${skill.source}`);
    } else if (skill.ownership === 'runtime-native' && source.kind !== 'runtime-native') {
      errors.push(`${name}: runtime-native ownership requires a runtime-native source`);
    } else if (source.kind === 'runtime-native' && skill.ownership !== 'runtime-native') {
      errors.push(`${name}: runtime-native source requires runtime-native ownership`);
    }
  }
}

function backendFor(
  ownership: RuntimeOwnershipMode,
  registry: DeviceRegistry,
  deviceId: string,
): InstallBackend {
  if (ownership === 'managed-link' || ownership === 'managed-materialized') {
    return registry.devices[deviceId].backends[ownership];
  }
  return 'none';
}

function actionForTarget(
  ownership: RuntimeOwnershipMode,
  sourcePath: string | null,
  targetPath: string,
): 'create' | 'change' | 'keep-project-local' | 'noop' {
  if (ownership === 'project-local') return 'keep-project-local';
  let targetStat: fs.Stats;
  try {
    targetStat = fs.lstatSync(targetPath);
  } catch {
    return 'create';
  }
  if (!sourcePath || !fs.existsSync(sourcePath)) return 'change';

  try {
    if (targetStat.isSymbolicLink()) {
      return fs.realpathSync(targetPath) === fs.realpathSync(sourcePath) ? 'noop' : 'change';
    }
    return hashDirectory(targetPath) === hashDirectory(sourcePath) ? 'noop' : 'change';
  } catch {
    return 'change';
  }
}

export function buildProfilePlan(options: BuildProfilePlanOptions): ProfilePlan {
  const projectPath = path.resolve(options.projectPath);
  const manifest = readYaml(options.manifestPath, ProjectManifestSchema, 'manifest');
  const lock = readYaml(options.lockPath, ProjectLockSchema, 'lock');
  const registry = readYaml(options.deviceRegistryPath, DeviceRegistrySchema, 'device registry');
  const errors: string[] = [];
  const warnings: string[] = [];

  validateReferences(manifest, errors);

  const profile = manifest.profiles[options.profile];
  if (!profile) errors.push(`unknown profile ${options.profile}`);
  const device = registry.devices[options.deviceId];
  if (!device) errors.push(`unknown device ${options.deviceId}`);
  const runtime = manifest.runtimes[options.runtime];
  if (!runtime) warnings.push(`runtime ${options.runtime} has no native replacement map`);

  const emptyBudgets = { max_skills: 0, max_description_chars: 0 };
  const budgets = profile?.budgets ?? emptyBudgets;
  const selectedNames = profile
    ? [...new Set([...manifest.core, ...profile.include])]
      .filter((name) => !profile.exclude.includes(name))
      .sort()
    : [];

  const entries: ProfilePlanEntry[] = [];
  const exposedCapabilities = new Map<string, string>();
  let selectedSkills = 0;
  let descriptionChars = 0;

  if (device && profile) {
    for (const name of selectedNames) {
      const skill = manifest.skills[name];
      if (!skill) continue;
      const replacementCapability = skill.capabilities
        .find((capability) => runtime?.replacements[capability]);
      const replacement = replacementCapability
        ? runtime?.replacements[replacementCapability] ?? null
        : null;

      if (skill.ownership === 'runtime-native') {
        if (!replacement) {
          errors.push(`${name}: runtime-native replacement missing for runtime ${options.runtime}`);
        }
        entries.push({
          name,
          action: 'runtime-native',
          ownership: skill.ownership,
          backend: 'none',
          source: null,
          target: null,
          expected_tree_hash: null,
          previous_tree_hash: null,
          replacement,
        });
        continue;
      }

      const sourcePath = replacement
        ? null
        : resolveSkillSource(
          manifest,
          registry,
          projectPath,
          options.deviceId,
          name,
          errors,
        );

      if (skill.ownership === 'catalog-only') {
        entries.push({
          name,
          action: 'catalog',
          ownership: skill.ownership,
          backend: 'none',
          source: sourcePath,
          target: null,
          expected_tree_hash: sourcePath && fs.existsSync(sourcePath) ? hashDirectory(sourcePath) : null,
          previous_tree_hash: null,
          replacement: null,
        });
        continue;
      }

      if (replacement) {
        entries.push({
          name,
          action: 'runtime-native',
          ownership: 'runtime-native',
          backend: 'none',
          source: null,
          target: null,
          expected_tree_hash: null,
          previous_tree_hash: null,
          replacement,
        });
        continue;
      }

      selectedSkills += 1;
      descriptionChars += skill.description_chars;
      for (const capability of skill.capabilities) {
        const owner = exposedCapabilities.get(capability);
        if (owner) {
          errors.push(`duplicate capability ${capability}: ${owner}, ${name}`);
        } else {
          exposedCapabilities.set(capability, name);
        }
      }

      if (!sourcePath || !fs.existsSync(sourcePath)) {
        errors.push(`${name}: source path missing${sourcePath ? `: ${sourcePath}` : ''}`);
      }

      const source = manifest.sources[skill.source];
      const lockedSource = lock.sources[skill.source];
      if (source?.kind === 'git') {
        if (!lockedSource) {
          errors.push(`${name}: git source ${skill.source} is not locked`);
        } else if (source.revision && source.revision !== lockedSource.revision) {
          errors.push(
            `${name}: source revision mismatch for ${skill.source}: `
            + `${source.revision} != ${lockedSource.revision}`,
          );
        } else if (sourcePath) {
          const sourceRoot = registry.devices[options.deviceId].source_roots[skill.source];
          if (sourceRoot && fs.existsSync(sourceRoot)) {
            const actualHash = hashDirectory(sourceRoot);
            if (actualHash !== lockedSource.tree_hash) {
              errors.push(`${name}: source hash drift for ${skill.source}`);
            }
          }
        }
      }

      const target = skill.ownership === 'project-local'
        ? sourcePath
        : path.join(projectPath, '.agents', 'skills', name);
      const action = target
        ? actionForTarget(skill.ownership, sourcePath, target)
        : 'change';
      entries.push({
        name,
        action,
        ownership: skill.ownership,
        backend: backendFor(skill.ownership, registry, options.deviceId),
        source: sourcePath,
        target,
        expected_tree_hash: sourcePath && fs.existsSync(sourcePath) ? hashDirectory(sourcePath) : null,
        previous_tree_hash: target ? currentTreeHash(target) : null,
        replacement: null,
      });
    }

    const selectedManaged = new Set(entries
      .filter((entry) => entry.ownership === 'managed-link' || entry.ownership === 'managed-materialized')
      .map((entry) => entry.name));
    const managedRoot = path.join(projectPath, '.agents', 'skills');
    for (const [name, previous] of Object.entries(lock.managed).sort(([a], [b]) => compareText(a, b))) {
      if (selectedManaged.has(name)) continue;
      const target = resolveProjectPath(projectPath, previous.target);
      if (!isWithin(managedRoot, target)) {
        errors.push(`${name}: managed removal target escapes ${managedRoot}`);
        continue;
      }
      entries.push({
        name,
        action: 'remove',
        ownership: previous.ownership,
        backend: backendFor(previous.ownership, registry, options.deviceId),
        source: null,
        target,
        expected_tree_hash: null,
        previous_tree_hash: previous.tree_hash ?? currentTreeHash(target),
        replacement: null,
      });
    }
  }

  if (profile && selectedSkills > budgets.max_skills) {
    errors.push(`profile skill budget exceeded: ${selectedSkills} > ${budgets.max_skills}`);
  }
  if (profile && descriptionChars > budgets.max_description_chars) {
    errors.push(
      `profile description budget exceeded: ${descriptionChars} > ${budgets.max_description_chars}`,
    );
  }

  return {
    version: 1,
    project: manifest.project,
    profile: options.profile,
    device: options.deviceId,
    runtime: options.runtime,
    command_maturity: manifest.command_maturity.profile_plan,
    concurrency: {
      ...manifest.concurrency,
      activation_lock: resolveProjectPath(projectPath, manifest.concurrency.activation_lock),
      lock_acquired: false,
    },
    budgets: {
      selected_skills: selectedSkills,
      max_skills: budgets.max_skills,
      description_chars: descriptionChars,
      max_description_chars: budgets.max_description_chars,
    },
    entries: entries.sort((a, b) => compareText(a.name, b.name) || compareText(a.action, b.action)),
    errors: [...new Set(errors)].sort(),
    warnings: [...new Set(warnings)].sort(),
    writes_performed: 0,
  };
}
