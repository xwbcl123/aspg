/**
 * aspg compat — Environment & dependency contract validation
 * Only checks aspg.requirements declarations. Does NOT touch topology.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { SkillFrontmatterSchema, type SkillFrontmatter } from '../schema.js';
import { SSOT_DIR } from '../vendors.js';

interface CompatOptions {
  strict?: boolean;
}

export async function compatCommand(
  skillName?: string,
  opts: CompatOptions = {},
): Promise<void> {
  const { strict = false } = opts;
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);

  if (!fs.existsSync(ssotPath)) {
    console.error(`✗ ${SSOT_DIR}/ not found. Run "aspg init" first.`);
    process.exitCode = 2;
    return;
  }

  // System info
  console.log(`Platform: ${process.platform} (${process.arch})`);
  if (process.platform === 'win32') {
    const hasWSL = commandExists('wsl');
    console.log(`WSL: ${hasWSL ? 'available' : 'not found'}`);
  }
  console.log('');

  // Get skills to check
  let skills: string[];
  if (skillName) {
    if (!fs.existsSync(path.join(ssotPath, skillName))) {
      console.error(`✗ Skill "${skillName}" not found in SSOT`);
      process.exitCode = 1;
      return;
    }
    skills = [skillName];
  } else {
    skills = fs.readdirSync(ssotPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  if (skills.length === 0) {
    console.log('No skills found in SSOT.');
    return;
  }

  let hasWarnings = false;

  for (const skill of skills) {
    console.log(`─── ${skill} ───`);
    const fm = loadFrontmatter(path.join(ssotPath, skill, 'SKILL.md'));
    if (!fm) {
      console.error(`  ✗ Cannot read SKILL.md`);
      hasWarnings = true;
      continue;
    }

    const reqs = fm.aspg?.requirements;
    if (!reqs) {
      console.log(`  · No requirements declared`);
      continue;
    }

    // Check tools
    if (reqs.tools) {
      for (const tool of reqs.tools) {
        if (commandExists(tool)) {
          console.log(`  ✓ tool: ${tool}`);
        } else {
          console.warn(`  ⚠ tool: ${tool} — not found in PATH`);
          hasWarnings = true;
        }
      }
    }

    // Check env vars
    if (reqs.env) {
      for (const envVar of reqs.env) {
        if (process.env[envVar]) {
          console.log(`  ✓ env: ${envVar}`);
        } else {
          console.warn(`  ⚠ env: ${envVar} — not set`);
          hasWarnings = true;
        }
      }
    }
  }

  console.log('');
  if (hasWarnings) {
    if (strict) {
      console.error('✗ Compatibility check failed (strict mode)');
      process.exitCode = 1;
    } else {
      console.log('⚠ Some warnings found (use --strict to fail on warnings)');
    }
  } else {
    console.log('✓ All requirements satisfied');
  }
}

function commandExists(cmd: string): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${which} ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function loadFrontmatter(skillMdPath: string): SkillFrontmatter | null {
  if (!fs.existsSync(skillMdPath)) return null;
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    const doc = parseDocument(match[1]);
    const data = doc.toJSON();
    const result = SkillFrontmatterSchema.safeParse(data);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
