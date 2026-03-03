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

const program = new Command();

program
  .name('aspg')
  .description('Agent Skills Protocol Guardian — multi-AI skill governance CLI')
  .version('0.2.0');

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
  .action(async () => {
    await lintCommand();
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

program.parse();
