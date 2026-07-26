/**
 * Wave 6 fixture-only Portfolio mutation commands.
 *
 * No command in this module has a cwd/default-project or all-projects mode.
 * The resolver and executor independently require every path to live below an
 * explicit child of the operating-system temporary directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  PortfolioDeviceRegistryV2Schema,
  PortfolioLockSchema,
  PortfolioManifestSchema,
  ProjectBindingSchema,
  type PortfolioDeviceRegistryV2,
  type PortfolioLock,
  type PortfolioManifest,
  type ProjectBinding,
} from '../portfolio-schema.js';
import {
  resolvePortfolioRuntime,
  type ResolvedPortfolioRuntime,
} from '../portfolio-runtime-resolver.js';
import {
  executePortfolioRuntimeMutation,
  inspectPortfolioRuntime,
  repairPortfolioRuntimeOperation,
  rollbackPortfolioRuntimeOperation,
  type ExecutePortfolioRuntimeRequest,
  type ResolvedPortfolioRuntimeDeployment,
} from '../portfolio-runtime.js';
import type { GoogleDriveProviderObservation } from '../provider-preflight.js';
import { bootstrapActivationGeneration } from '../activation-journal.js';

export interface PortfolioRuntimeCommandOptions {
  manifest: string;
  lock: string;
  deviceRegistry: string;
  device: string;
  deployment: string;
  fixtureRoot: string;
  operationId?: string;
  providerStatus?: GoogleDriveProviderObservation['status'];
  providerHydrated?: boolean;
  providerWritable?: boolean;
  providerReason?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface PortfolioRecoveryCommandOptions {
  deviceRegistry: string;
  device: string;
  fixtureRoot: string;
  operationId: string;
  json?: boolean;
}

interface ResolvedCommand {
  model: ResolvedPortfolioRuntime;
  input: ResolvedPortfolioRuntimeDeployment;
}

function readYaml<T>(
  filePath: string,
  schema: { parse(value: unknown): T },
  label: string,
): T {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new Error(`${label} not found: ${absolute}`);
  const document = parseDocument(fs.readFileSync(absolute, 'utf8'));
  if (document.errors.length > 0) {
    throw new Error(
      `${label} YAML error: ${document.errors.map((error) => error.message).join(', ')}`,
    );
  }
  return schema.parse(document.toJSON());
}

function projectRootFor(
  manifest: PortfolioManifest,
  registry: PortfolioDeviceRegistryV2,
  deviceId: string,
  deploymentId: string,
  optionsFixtureRoot: string,
): string {
  const deployment = manifest.deployments[deploymentId];
  if (!deployment) throw new Error(`unknown deployment: ${deploymentId}`);
  const device = registry.devices[deviceId];
  if (!device) throw new Error(`unknown device: ${deviceId}`);
  const roots = Object.values(device.runtime_roots)
    .filter((runtimeRoot) => runtimeRoot.project_ref === deployment.project_ref);
  if (roots.length !== 1) {
    throw new Error(`expected one runtime root for ${deployment.project_ref}`);
  }
  const fixtureRoot = fs.realpathSync(optionsFixtureRoot);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const runtimeRoot = fs.realpathSync(roots[0].path);
  const relativeFixture = path.relative(fixtureRoot, runtimeRoot);
  const relativeTemporary = path.relative(temporaryRoot, fixtureRoot);
  if (
    fixtureRoot === temporaryRoot
    || relativeTemporary === '..'
    || relativeTemporary.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTemporary)
    || relativeFixture === ''
    || relativeFixture === '..'
    || relativeFixture.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeFixture)
  ) {
    throw new Error(
      'ASPG_RUNTIME_REAL_PATH_REFUSED: runtime root must resolve below the explicit TMPDIR fixture root',
    );
  }
  if (
    path.basename(runtimeRoot) !== 'skills'
    || path.basename(path.dirname(runtimeRoot)) !== '.agents'
  ) {
    throw new Error('runtime root must be the project .agents/skills directory');
  }
  return fs.realpathSync(path.dirname(path.dirname(runtimeRoot)));
}

function currentGeneration(projectRoot: string, deployment: string): number {
  const statePath = path.join(
    projectRoot,
    '.aspg',
    'deployments',
    deployment,
    'state.yaml',
  );
  if (!fs.existsSync(statePath)) return 0;
  const stat = fs.lstatSync(statePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`portable state is not a regular file: ${statePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    generation?: unknown;
  };
  if (!Number.isSafeInteger(parsed.generation) || (parsed.generation as number) < 1) {
    throw new Error(`portable state has invalid generation: ${statePath}`);
  }
  return parsed.generation as number;
}

function readProjectBinding(projectRoot: string): ProjectBinding {
  const metadataRoot = path.join(projectRoot, '.aspg');
  const bindingPath = path.join(metadataRoot, 'portfolio.yaml');
  const metadataStat = fs.lstatSync(metadataRoot);
  if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory()) {
    throw new Error(`project .aspg must be a real directory: ${metadataRoot}`);
  }
  const bindingStat = fs.lstatSync(bindingPath);
  if (bindingStat.isSymbolicLink() || !bindingStat.isFile()) {
    throw new Error(`Project binding must be a regular file: ${bindingPath}`);
  }
  const bindingRealpath = fs.realpathSync(bindingPath);
  const relative = path.relative(projectRoot, bindingRealpath);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('Project binding escapes the canonical project root');
  }
  return readYaml(bindingRealpath, ProjectBindingSchema, 'Project binding');
}

function googleObservation(
  model: ResolvedPortfolioRuntime,
  options: PortfolioRuntimeCommandOptions,
): GoogleDriveProviderObservation | undefined {
  if (model.provider !== 'google-drive-file-provider') return undefined;
  if (
    !options.providerStatus
    || options.providerHydrated === undefined
    || options.providerWritable === undefined
  ) {
    return {
      status: 'uncertain',
      hydrated: false,
      writable: false,
      reason: 'Google Drive status/hydration/writability must be explicit',
    };
  }
  if (!['online', 'offline', 'uncertain', 'conflict'].includes(options.providerStatus)) {
    throw new Error(`invalid Google Drive provider status: ${options.providerStatus}`);
  }
  return {
    status: options.providerStatus,
    hydrated: options.providerHydrated,
    writable: options.providerWritable,
    reason: options.providerReason,
  };
}

function portableTarget(projectRoot: string, target: string): string {
  return path.relative(projectRoot, target).split(path.sep).join('/');
}

function generatedFiles(model: ResolvedPortfolioRuntime): Array<{
  target: string;
  bytes: string;
}> {
  if (model.generated_private_skill_packs.model.packs.length === 0) return [];
  return [{
    target: model.generated_private_skill_packs.path,
    bytes: `${JSON.stringify(
      model.generated_private_skill_packs.model,
      null,
      2,
    )}\n`,
  }];
}

export function resolvePortfolioRuntimeCommand(
  options: PortfolioRuntimeCommandOptions,
): ResolvedCommand {
  const manifest = readYaml(
    options.manifest,
    PortfolioManifestSchema,
    'Portfolio Manifest',
  );
  const lock = readYaml(options.lock, PortfolioLockSchema, 'Portfolio Lock');
  const registry = readYaml(
    options.deviceRegistry,
    PortfolioDeviceRegistryV2Schema,
    'Portfolio Device Registry v2',
  );
  const projectRoot = projectRootFor(
    manifest,
    registry,
    options.device,
    options.deployment,
    options.fixtureRoot,
  );
  const binding = readProjectBinding(projectRoot);
  const model = resolvePortfolioRuntime({
    fixture_root: options.fixtureRoot,
    manifest,
    lock,
    device_registry: registry,
    binding,
    device_id: options.device,
    deployment: options.deployment,
  });
  const generation = currentGeneration(model.project_root, model.deployment);
  return {
    model,
    input: {
      fixture_root: model.fixture_root,
      project_root: model.project_root,
      runtime_root: model.runtime_root,
      state_root: model.state_root,
      storage_provider: model.provider,
      deployment_backend: model.backend,
      google_drive: googleObservation(model, options),
      portfolio: model.portfolio,
      deployment: model.deployment,
      project_ref: model.project_ref,
      device_id: model.device_id,
      lock_revision: binding.portfolio.revision,
      current_generation: generation,
      next_generation: generation + 1,
      entries: model.skills.map((skill) => ({
        ...skill.locked,
        skill_id: skill.skill_id,
        exposure_name: skill.exposure_name,
        repository_root: skill.repository_root,
        target: portableTarget(model.project_root, skill.target),
        dependencies: skill.dependencies.map((dependency) => ({
          source: dependency.source,
          source_revision: dependency.source_revision,
          path: dependency.path,
          tree_hash: dependency.tree_hash,
          executable_files: [...dependency.executable_files],
          id: dependency.id,
          privacy: dependency.privacy,
          target: dependency.target,
          required: dependency.required,
          repository_root: dependency.repository_root,
        })),
      })),
      generated_files: generatedFiles(model),
    },
  };
}

function print(result: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify(result));
}

export async function portfolioRuntimeApplyCommand(
  options: PortfolioRuntimeCommandOptions,
  mutation: 'apply' | 'refresh',
): Promise<void> {
  try {
    const resolved = resolvePortfolioRuntimeCommand(options);
    if (options.dryRun) {
      const inspection = inspectPortfolioRuntime(resolved.input);
      print({
        mode: 'dry-run',
        mutation,
        deployment: resolved.model.deployment,
        backend: resolved.model.backend,
        provider: resolved.model.provider,
        generation: resolved.input.next_generation,
        skills: resolved.model.skills.map((skill) => skill.skill_id),
        dependencies: resolved.model.skills.flatMap((skill) =>
          skill.dependencies.map((dependency) => dependency.id)),
        generated_files: resolved.input.generated_files?.map((file) => file.target) ?? [],
        health: inspection.health,
        blocking: inspection.blocking,
        writes_performed: 0,
      }, options.json);
      return;
    }
    if (!options.operationId) {
      throw new Error('--operation-id is required for a mutating command');
    }
    if (mutation === 'apply' && resolved.input.current_generation !== 0) {
      throw new Error('apply requires no existing portable deployment state');
    }
    if (mutation === 'refresh' && resolved.input.current_generation === 0) {
      throw new Error('refresh requires existing portable deployment state');
    }
    const request: ExecutePortfolioRuntimeRequest = {
      ...resolved.input,
      mutation,
      operation_id: options.operationId,
    };
    print(executePortfolioRuntimeMutation(request), options.json);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

export async function portfolioRuntimeDoctorCommand(
  options: PortfolioRuntimeCommandOptions,
): Promise<void> {
  try {
    const resolved = resolvePortfolioRuntimeCommand(options);
    const result = inspectPortfolioRuntime(resolved.input);
    print(result, options.json);
    if (result.blocking) process.exitCode = 1;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

/**
 * Explicitly adopts a portable deployment generation into an empty/new
 * device-local state root. This is intentionally separate from apply/refresh:
 * runtime mutation must never bootstrap device CAS state implicitly.
 */
export async function portfolioRuntimeBootstrapCommand(
  options: PortfolioRuntimeCommandOptions,
): Promise<void> {
  try {
    const resolved = resolvePortfolioRuntimeCommand(options);
    if (resolved.input.current_generation === 0) {
      throw new Error(
        'bootstrap-device-state requires an existing portable deployment state',
      );
    }
    if (options.dryRun) {
      print({
        mode: 'dry-run',
        action: 'bootstrap-device-state',
        portfolio: resolved.input.portfolio,
        deployment: resolved.input.deployment,
        project_ref: resolved.input.project_ref,
        generation: resolved.input.current_generation,
        state_root: resolved.input.state_root,
        writes_performed: 0,
      }, options.json);
      return;
    }
    print(bootstrapActivationGeneration({
      fixtureRoot: resolved.input.fixture_root,
      stateRoot: resolved.input.state_root,
      portable: {
        portfolio: resolved.input.portfolio,
        deployment: resolved.input.deployment,
        project_ref: resolved.input.project_ref,
        generation: resolved.input.current_generation,
      },
    }), options.json);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 2;
  }
}

function recoveryStateRoot(options: PortfolioRecoveryCommandOptions): string {
  const registry = readYaml(
    options.deviceRegistry,
    PortfolioDeviceRegistryV2Schema,
    'Portfolio Device Registry v2',
  );
  const device = registry.devices[options.device];
  if (!device) throw new Error(`unknown device: ${options.device}`);
  return device.state_root;
}

export async function portfolioRuntimeRecoveryCommand(
  options: PortfolioRecoveryCommandOptions,
  mutation: 'repair' | 'rollback',
): Promise<void> {
  try {
    const request = {
      fixture_root: options.fixtureRoot,
      state_root: recoveryStateRoot(options),
      operation_id: options.operationId,
    };
    const result = mutation === 'repair'
      ? repairPortfolioRuntimeOperation(request)
      : rollbackPortfolioRuntimeOperation(request);
    print(result, options.json);
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
