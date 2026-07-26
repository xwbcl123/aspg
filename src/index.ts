/**
 * ASPG — Agent Skills Protocol Guardian
 * CLI entry point
 */
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { applyCommand } from './commands/apply.js';
import { lintCommand } from './commands/lint.js';
import { compatCommand } from './commands/compat.js';
import { doctorCommand } from './commands/doctor.js';
import { importCommand } from './commands/import.js';
import { cleanCommand } from './commands/clean.js';
import { profilePlanCommand } from './commands/profile.js';
import {
  lifecycleListCommand,
  lifecycleNextCommand,
  lifecycleShowCommand,
  lifecycleStatusCommand,
  lifecycleValidateCommand,
} from './commands/lifecycle.js';
import {
  portfolioDeploymentViewCommand,
  portfolioPlanCommand,
  portfolioStatusCommand,
  portfolioValidateCommand,
} from './commands/portfolio.js';
import {
  portfolioRuntimeApplyCommand,
  portfolioRuntimeBootstrapCommand,
  portfolioRuntimeDoctorCommand,
  portfolioRuntimeRecoveryCommand,
} from './commands/portfolio-runtime.js';

const program = new Command();

function parseExplicitBoolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('expected true or false');
}

program
  .name('aspg')
  .description('Agent Skills Protocol Guardian — multi-AI skill governance CLI')
  .version('0.3.0');

program
  .command('init')
  .description('Initialize project infrastructure (.agents/skills/ + vendor bridges)')
  .action(async () => {
    await initCommand();
  });

program
  .command('apply')
  .description('Rescan SSOT and refresh all vendor bridges (idempotent)')
  .option('--dry-run', 'Preview changes without making them')
  .action(async (opts) => {
    await applyCommand({ dryRun: opts.dryRun });
  });

program
  .command('lint')
  .description('Validate all SKILL.md contracts')
  .option('--max-description-chars <count>', 'Maximum parsed description length', '1024')
  .action(async (opts) => {
    const maxDescriptionChars = Number.parseInt(opts.maxDescriptionChars, 10);
    if (!Number.isInteger(maxDescriptionChars) || maxDescriptionChars <= 0) {
      console.error('✗ --max-description-chars must be a positive integer');
      process.exitCode = 2;
      return;
    }
    await lintCommand({ maxDescriptionChars });
  });

program
  .command('compat [skill-name]')
  .description('Check environment & dependency requirements')
  .option('--strict', 'Treat warnings as errors (exit 1)')
  .action(async (skillName, opts) => {
    await compatCommand(skillName, { strict: opts.strict });
  });

program
  .command('doctor')
  .description('Topology & link health check')
  .action(async () => {
    await doctorCommand();
  });

program
  .command('import <skill-name>')
  .description('Import a skill from a vendor ecosystem to SSOT')
  .requiredOption('--from <vendor>', 'Source vendor (claude|codex|gemini)')
  .option('--path <dir>', 'Custom source path (skip auto-detection)')
  .option('--dry-run', 'Preview changes without making them')
  .action(async (skillName, opts) => {
    const vendor = opts.from as 'claude' | 'codex' | 'gemini';
    if (!['claude', 'codex', 'gemini'].includes(vendor)) {
      console.error(`✗ Unknown vendor: ${vendor}. Use claude|codex|gemini`);
      process.exitCode = 2;
      return;
    }
    await importCommand(skillName, {
      from: vendor,
      path: opts.path,
      dryRun: opts.dryRun,
    });
  });

program
  .command('clean')
  .description('Remove all ASPG-generated artifacts (preserves .agents/skills/)')
  .option('--dry-run', 'Preview changes without making them')
  .action(async (opts) => {
    await cleanCommand({ dryRun: opts.dryRun });
  });

const profile = program
  .command('profile')
  .description('Plan Profile exposure without mutating project runtimes');

profile
  .command('plan <profile>')
  .description('Resolve Core + Profile + runtime replacements (read-only)')
  .requiredOption('--project <path>', 'Project root')
  .requiredOption('--device <id>', 'Device identifier in the device registry')
  .requiredOption('--runtime <name>', 'Runtime capability map')
  .option('--manifest <path>', 'Manifest path (default: <project>/.aspg/manifest.yaml)')
  .option('--lock <path>', 'Lock path (default: <project>/.aspg/lock.yaml)')
  .option('--device-registry <path>', 'Machine-local device registry path')
  .option('--json', 'Emit deterministic JSON')
  .action(async (profileName, opts) => {
    await profilePlanCommand(profileName, opts);
  });

const lifecycle = program
  .command('lifecycle')
  .description('Inspect federated Skill lifecycle records without mutating them');

function lifecycleReadCommand(name: string, description: string): Command {
  return lifecycle
    .command(name)
    .description(description)
    .requiredOption('--registry <path...>', 'One or more lifecycle registry owner roots')
    .option('--lifeos-root <path>', 'Device-local 41.15 Knowledge Library entity root')
    .option('--json', 'Emit deterministic JSON');
}

lifecycleReadCommand('validate', 'Validate lifecycle schemas, references, paths and privacy')
  .action(async (opts) => {
    await lifecycleValidateCommand(opts);
  });

lifecycleReadCommand('list', 'List a deterministic lifecycle catalog view')
  .action(async (opts) => {
    await lifecycleListCommand(opts);
  });

lifecycle
  .command('show <skill-id>')
  .description('Show one lifecycle dossier')
  .requiredOption('--registry <path...>', 'One or more lifecycle registry owner roots')
  .option('--lifeos-root <path>', 'Device-local 41.15 Knowledge Library entity root')
  .option('--json', 'Emit deterministic JSON')
  .action(async (skillId, opts) => {
    await lifecycleShowCommand(skillId, opts);
  });

const lifecycleStatus = lifecycleReadCommand(
  'status',
  'Summarize lifecycle maturity, adoption and freshness',
).option('--as-of <YYYY-MM-DD>', 'Effective date surfaced in deterministic output');

lifecycleStatus
  .action(async (opts) => {
    await lifecycleStatusCommand(opts);
  });

const lifecycleNext = lifecycleReadCommand(
  'next',
  'Recommend deterministic evidence-backed next actions',
).option('--as-of <YYYY-MM-DD>', 'Effective date for deterministic recommendations');

lifecycleNext
  .action(async (opts) => {
    await lifecycleNextCommand(opts);
  });

const portfolio = program
  .command('portfolio')
  .description(
    'Inspect Portfolio state and run explicitly fixture-scoped runtime transactions',
  );

function portfolioReadCommand(name: string, description: string): Command {
  return portfolio
    .command(name)
    .description(description)
    .requiredOption('--device <id>', 'Device identifier in the local Portfolio registry')
    .option('--manifest <path>', 'Portfolio Manifest (default: .aspg/portfolio.yaml)')
    .option('--lock <path>', 'Portfolio Lock (default: .aspg/portfolio-lock.yaml)')
    .option('--device-registry <path>', 'Machine-local Portfolio device registry')
    .option('--as-of <YYYY-MM-DD>', 'Effective date for deterministic exception checks')
    .option('--json', 'Emit deterministic JSON');
}

portfolioReadCommand('validate', 'Validate Portfolio contracts and all deployments')
  .action(async (opts) => {
    await portfolioValidateCommand(opts);
  });

portfolio
  .command('plan')
  .description('Plan one deployment without mutating its runtime')
  .requiredOption('--deployment <id>', 'Deployment identifier')
  .requiredOption('--device <id>', 'Device identifier in the local Portfolio registry')
  .option('--manifest <path>', 'Portfolio Manifest (default: .aspg/portfolio.yaml)')
  .option('--lock <path>', 'Portfolio Lock (default: .aspg/portfolio-lock.yaml)')
  .option('--device-registry <path>', 'Machine-local Portfolio device registry')
  .option('--as-of <YYYY-MM-DD>', 'Effective date for deterministic exception checks')
  .option('--json', 'Emit deterministic JSON')
  .action(async (opts) => {
    await portfolioPlanCommand(opts.deployment, opts);
  });

portfolioReadCommand('status', 'Summarize every Portfolio deployment')
  .requiredOption('--all', 'Inspect all deployments')
  .action(async (opts) => {
    await portfolioStatusCommand(opts);
  });

portfolioReadCommand('deployment-view', 'Show the flattened generated deployment view')
  .requiredOption('--all', 'Inspect all deployments')
  .action(async (opts) => {
    await portfolioDeploymentViewCommand(opts);
  });

function portfolioRuntimeCommand(name: string, description: string): Command {
  return portfolio
    .command(name)
    .description(description)
    .requiredOption('--deployment <id>', 'One explicit deployment')
    .requiredOption('--device <id>', 'Device identifier in Registry v2')
    .requiredOption('--manifest <path>', 'Portfolio Manifest path')
    .requiredOption('--lock <path>', 'Portfolio Lock path')
    .requiredOption('--device-registry <path>', 'Device Registry v2 path')
    .requiredOption('--fixture-root <path>', 'Explicit isolated child of $TMPDIR')
    .option('--operation-id <id>', 'Explicit operation identifier')
    .option(
      '--provider-status <status>',
      'Google Drive observation: online|offline|uncertain|conflict',
    )
    .option(
      '--provider-hydrated <boolean>',
      'Explicit Google Drive hydration observation',
      parseExplicitBoolean,
    )
    .option(
      '--provider-writable <boolean>',
      'Explicit Google Drive writability observation',
      parseExplicitBoolean,
    )
    .option('--provider-reason <text>', 'Provider observation detail')
    .option('--dry-run', 'Resolve and plan with zero writes')
    .option('--json', 'Emit deterministic JSON');
}

portfolioRuntimeCommand(
  'apply',
  'Apply one deployment inside an explicit temporary fixture only',
).action(async (opts) => {
  await portfolioRuntimeApplyCommand(opts, 'apply');
});

portfolioRuntimeCommand(
  'refresh',
  'Refresh one owned deployment inside an explicit temporary fixture only',
).action(async (opts) => {
  await portfolioRuntimeApplyCommand(opts, 'refresh');
});

portfolioRuntimeCommand(
  'doctor',
  'Inspect provider, state and target health without mutation',
).action(async (opts) => {
  await portfolioRuntimeDoctorCommand(opts);
});

portfolioRuntimeCommand(
  'bootstrap-device-state',
  'Explicitly adopt portable generation into a new fixture-only device state root',
).action(async (opts) => {
  await portfolioRuntimeBootstrapCommand(opts);
});

function portfolioRecoveryCommand(name: 'repair' | 'rollback'): void {
  portfolio
    .command(name)
    .description(`${name} one interrupted fixture-only operation`)
    .requiredOption('--device <id>', 'Device identifier in Registry v2')
    .requiredOption('--device-registry <path>', 'Device Registry v2 path')
    .requiredOption('--fixture-root <path>', 'Explicit isolated child of $TMPDIR')
    .requiredOption('--operation-id <id>', 'Explicit operation identifier')
    .option('--json', 'Emit deterministic JSON')
    .action(async (opts) => {
      await portfolioRuntimeRecoveryCommand(opts, name);
    });
}

portfolioRecoveryCommand('repair');
portfolioRecoveryCommand('rollback');

program.parse();
