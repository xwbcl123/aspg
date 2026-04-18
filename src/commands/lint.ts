/**
 * aspg lint — Validate all SKILL.md contracts
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { SkillFrontmatterSchema } from '../schema.js';
import { SSOT_DIR } from '../vendors.js';

interface SkillValidationResult {
  ok: boolean;
  hadScriptsDir: boolean;
}

export async function lintCommand(): Promise<void> {
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);

  if (!fs.existsSync(ssotPath)) {
    console.error(`✗ ${SSOT_DIR}/ not found. Run "aspg init" first.`);
    process.exitCode = 2;
    return;
  }

  const skills = fs.readdirSync(ssotPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (skills.length === 0) {
    console.log('No skills found in SSOT.');
    return;
  }

  let hasErrors = false;

  for (const skill of skills) {
    const skillDir = path.join(ssotPath, skill);
    const skillMd = path.join(skillDir, 'SKILL.md');
    const pluginManifest = path.join(skillDir, '.claude-plugin', 'plugin.json');
    const nestedSkillsDir = path.join(skillDir, 'skills');

    console.log(`\n─── ${skill} ───`);

    if (skill.endsWith('-workspace') && !fs.existsSync(skillMd) && !fs.existsSync(pluginManifest)) {
      console.log('  · skipped workspace directory');
      continue;
    }

    // Check SKILL.md exists
    if (!fs.existsSync(skillMd)) {
      if (fs.existsSync(pluginManifest) && fs.existsSync(nestedSkillsDir)) {
        const nestedSkills = fs.readdirSync(nestedSkillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        if (nestedSkills.length === 0) {
          console.error('  ✗ plugin bundle detected, but skills/ is empty');
          hasErrors = true;
          continue;
        }

        console.log(`  · plugin bundle detected (${nestedSkills.length} nested skill(s))`);
        for (const nestedSkill of nestedSkills) {
          const nestedResult = validateSkillContract(path.join(nestedSkillsDir, nestedSkill), `  [plugin:${nestedSkill}] `);
          if (!nestedResult.ok) hasErrors = true;
        }
        continue;
      }

      if (fs.existsSync(nestedSkillsDir)) {
        const nestedSkillCandidates = fs.readdirSync(nestedSkillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && fs.existsSync(path.join(nestedSkillsDir, d.name, 'SKILL.md')))
          .map((d) => d.name);

        if (nestedSkillCandidates.length > 0) {
          console.error(`  ✗ SKILL.md not found at skill root; nested packaging detected in skills/: ${nestedSkillCandidates.join(', ')}`);
          console.error('  ✗ Either add a root SKILL.md or declare a supported plugin bundle structure');
          hasErrors = true;
          continue;
        }
      }

      console.error('  ✗ SKILL.md not found');
      hasErrors = true;
      continue;
    }

    const result = validateSkillContract(skillDir, '  ');
    if (!result.ok) hasErrors = true;
  }

  if (hasErrors) {
    process.exitCode = 1;
    console.log('\n✗ Lint failed with errors');
  } else {
    console.log('\n✓ All skills passed validation');
  }
}

function validateSkillContract(skillDir: string, prefix: string): SkillValidationResult {
  const skillMd = path.join(skillDir, 'SKILL.md');

  // Parse frontmatter
  const content = fs.readFileSync(skillMd, 'utf-8');
  const frontmatter = extractFrontmatter(content);

  if (!frontmatter) {
    console.error(`${prefix}✗ No YAML frontmatter found`);
    return { ok: false, hadScriptsDir: false };
  }

  // Parse YAML
  let data: unknown;
  try {
    const doc = parseDocument(frontmatter);
    if (doc.errors.length > 0) {
      console.error(`${prefix}✗ YAML parse errors: ${doc.errors.map((e) => e.message).join(', ')}`);
      return { ok: false, hadScriptsDir: false };
    }
    data = doc.toJSON();
  } catch (err) {
    console.error(`${prefix}✗ YAML parse failed: ${(err as Error).message}`);
    return { ok: false, hadScriptsDir: false };
  }

  // Validate against schema
  const result = SkillFrontmatterSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      console.error(`${prefix}✗ ${issue.path.join('.')}: ${issue.message}`);
    }
    return { ok: false, hadScriptsDir: false };
  }

  console.log(`${prefix}✓ Frontmatter valid`);

  // Check scripts/ directory
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs.readdirSync(scriptsDir);
    if (scripts.length === 0) {
      console.log(`${prefix}· scripts/ is empty`);
    } else {
      // On Unix, check executable permission
      if (process.platform !== 'win32') {
        for (const script of scripts) {
          const scriptPath = path.join(scriptsDir, script);
          try {
            fs.accessSync(scriptPath, fs.constants.X_OK);
            console.log(`${prefix}✓ scripts/${script} (executable)`);
          } catch {
            console.error(`${prefix}✗ scripts/${script} not executable`);
            return { ok: false, hadScriptsDir: true };
          }
        }
      } else {
        console.log(`${prefix}✓ scripts/ (${scripts.length} file(s))`);
      }
    }
  }

  return { ok: true, hadScriptsDir: fs.existsSync(scriptsDir) };
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}
