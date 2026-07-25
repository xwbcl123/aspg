/**
 * aspg profile plan — Read-only Profile exposure planner.
 */
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import { buildProfilePlan } from '../profile-plan.js';

export interface ProfilePlanOptions {
  project: string;
  device: string;
  runtime: string;
  manifest?: string;
  lock?: string;
  deviceRegistry?: string;
  json?: boolean;
}

export async function profilePlanCommand(
  profile: string,
  opts: ProfilePlanOptions,
): Promise<void> {
  const projectPath = path.resolve(opts.project);
  const manifestPath = path.resolve(opts.manifest ?? path.join(projectPath, '.aspg', 'manifest.yaml'));
  const lockPath = path.resolve(opts.lock ?? path.join(projectPath, '.aspg', 'lock.yaml'));
  const deviceRegistryPath = path.resolve(
    opts.deviceRegistry
      ?? process.env.ASPG_DEVICE_REGISTRY
      ?? path.join(os.homedir(), '.config', 'aspg', 'devices.yaml'),
  );

  try {
    const plan = buildProfilePlan({
      projectPath,
      profile,
      deviceId: opts.device,
      runtime: opts.runtime,
      manifestPath,
      lockPath,
      deviceRegistryPath,
    });

    if (opts.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`Profile: ${plan.profile}`);
      console.log(`Project: ${plan.project}`);
      console.log(`Device/runtime: ${plan.device} / ${plan.runtime}`);
      console.log(`Selected: ${plan.budgets.selected_skills}/${plan.budgets.max_skills}`);
      console.log(
        `Description chars: ${plan.budgets.description_chars}/${plan.budgets.max_description_chars}`,
      );
      for (const entry of plan.entries) {
        console.log(`- ${entry.name}: ${entry.action} [${entry.backend}]`);
      }
      for (const warning of plan.warnings) console.warn(`⚠ ${warning}`);
      for (const error of plan.errors) console.error(`✗ ${error}`);
      console.log('Writes performed: 0');
    }

    if (plan.errors.length > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof ZodError) {
      for (const issue of error.issues) {
        console.error(`✗ ${issue.path.join('.')}: ${issue.message}`);
      }
    } else {
      console.error(`✗ ${(error as Error).message}`);
    }
    process.exitCode = 2;
  }
}

