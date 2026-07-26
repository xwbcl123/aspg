/**
 * Read-only Portfolio v1 command surface.
 */
import os from 'node:os';
import path from 'node:path';
import { ZodError } from 'zod';
import {
  buildPortfolioDeploymentView,
  buildPortfolioPlan,
  buildPortfolioStatus,
  validatePortfolio,
  type PortfolioControlOptions,
  type PortfolioDeploymentView,
  type PortfolioPlan,
  type PortfolioStatus,
  type PortfolioValidation,
} from '../portfolio-control.js';

export interface PortfolioCommandOptions {
  manifest?: string;
  lock?: string;
  deviceRegistry?: string;
  device: string;
  asOf?: string;
  json?: boolean;
  all?: boolean;
}

function resolveOptions(opts: PortfolioCommandOptions): PortfolioControlOptions {
  const cwd = process.cwd();
  return {
    manifestPath: path.resolve(opts.manifest ?? path.join(cwd, '.aspg', 'portfolio.yaml')),
    lockPath: path.resolve(opts.lock ?? path.join(cwd, '.aspg', 'portfolio-lock.yaml')),
    deviceRegistryPath: path.resolve(
      opts.deviceRegistry
        ?? process.env.ASPG_PORTFOLIO_DEVICE_REGISTRY
        ?? path.join(os.homedir(), '.config', 'aspg', 'portfolio-devices.yaml'),
    ),
    deviceId: opts.device,
    asOf: opts.asOf,
  };
}

async function runReadCommand<T>(
  opts: PortfolioCommandOptions,
  build: (options: PortfolioControlOptions) => T,
  hasErrors: (result: T) => boolean,
  printHuman: (result: T) => void,
): Promise<void> {
  try {
    const result = build(resolveOptions(opts));
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (hasErrors(result)) process.exitCode = 1;
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

function printDiagnostics(result: {
  diagnostics?: Array<{ severity: string; code: string; message: string }>;
}): void {
  for (const diagnostic of result.diagnostics ?? []) {
    const marker = diagnostic.severity === 'error' ? '✗' : '⚠';
    console.log(`${marker} ${diagnostic.code}: ${diagnostic.message}`);
  }
}

export async function portfolioValidateCommand(
  opts: PortfolioCommandOptions,
): Promise<void> {
  await runReadCommand<PortfolioValidation>(
    opts,
    validatePortfolio,
    (result) => !result.valid,
    (result) => {
      console.log(`Portfolio: ${result.portfolio}`);
      console.log(`Device/as-of: ${result.device} / ${result.as_of}`);
      console.log(`Projects/deployments: ${result.projects.length}/${result.deployments.length}`);
      console.log(`Valid: ${result.valid}`);
      printDiagnostics(result);
      console.log('Writes performed: 0');
    },
  );
}

export async function portfolioPlanCommand(
  deployment: string,
  opts: PortfolioCommandOptions,
): Promise<void> {
  await runReadCommand<PortfolioPlan>(
    opts,
    (options) => buildPortfolioPlan({ ...options, deployment }),
    (result) => result.errors.length > 0,
    (result) => {
      console.log(`Portfolio/deployment: ${result.portfolio} / ${result.deployment}`);
      console.log(`Project: ${result.project_ref} -> ${result.project_realpath}`);
      console.log(
        `Selected: ${result.budgets.selected_skills}/${result.budgets.max_skills}`,
      );
      for (const entry of result.entries) {
        console.log(`- ${entry.skill_id}: ${entry.action} [${entry.health}]`);
      }
      for (const warning of result.warnings) {
        console.log(`⚠ ${warning.code}: ${warning.message}`);
      }
      for (const error of result.errors) {
        console.log(`✗ ${error.code}: ${error.message}`);
      }
      console.log('Writes performed: 0');
    },
  );
}

export async function portfolioStatusCommand(
  opts: PortfolioCommandOptions,
): Promise<void> {
  if (!opts.all) {
    console.error('✗ portfolio status v1 requires --all');
    process.exitCode = 2;
    return;
  }
  await runReadCommand<PortfolioStatus>(
    opts,
    buildPortfolioStatus,
    (result) => !result.valid,
    (result) => {
      console.log(`Portfolio: ${result.portfolio}`);
      for (const deployment of result.deployments) {
        console.log(
          `- ${deployment.deployment}: healthy=${deployment.healthy} `
          + `pending=${deployment.pending} blocked=${deployment.blocked}`,
        );
      }
      printDiagnostics(result);
      console.log('Writes performed: 0');
    },
  );
}

export async function portfolioDeploymentViewCommand(
  opts: PortfolioCommandOptions,
): Promise<void> {
  if (!opts.all) {
    console.error('✗ portfolio deployment-view v1 requires --all');
    process.exitCode = 2;
    return;
  }
  await runReadCommand<PortfolioDeploymentView>(
    opts,
    buildPortfolioDeploymentView,
    (result) => result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    (result) => {
      console.log(`Portfolio: ${result.portfolio}`);
      for (const row of result.rows) {
        console.log(
          `- ${row.deployment} ${row.canonical_skill_id} -> `
          + `${row.target ?? '(catalog)'} [${row.health}]`,
        );
      }
      printDiagnostics(result);
      console.log('Writes performed: 0');
    },
  );
}
