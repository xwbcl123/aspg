/**
 * aspg lint — Validate all SKILL.md contracts
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { SkillFrontmatterSchema } from '../schema.js';
import { SSOT_DIR } from '../vendors.js';

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

    console.log(`\n─── ${skill} ───`);

    // Check SKILL.md exists
    if (!fs.existsSync(skillMd)) {
      console.error(`  ✗ SKILL.md not found`);
      hasErrors = true;
      continue;
    }

    // Parse frontmatter
    const content = fs.readFileSync(skillMd, 'utf-8');
    const frontmatter = extractFrontmatter(content);

    if (!frontmatter) {
      console.error(`  ✗ No YAML frontmatter found`);
      hasErrors = true;
      continue;
    }

    // Parse YAML
    let data: unknown;
    try {
      const doc = parseDocument(frontmatter);
      if (doc.errors.length > 0) {
        console.error(`  ✗ YAML parse errors: ${doc.errors.map((e) => e.message).join(', ')}`);
        hasErrors = true;
        continue;
      }
      data = doc.toJSON();
    } catch (err) {
      console.error(`  ✗ YAML parse failed: ${(err as Error).message}`);
      hasErrors = true;
      continue;
    }

    // Validate against schema
    const result = SkillFrontmatterSchema.safeParse(data);
    if (!result.success) {
      for (const issue of result.error.issues) {
        console.error(`  ✗ ${issue.path.join('.')}: ${issue.message}`);
      }
      hasErrors = true;
      continue;
    }

    console.log(`  ✓ Frontmatter valid`);

    // Check scripts/ directory
    const scriptsDir = path.join(skillDir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const scripts = fs.readdirSync(scriptsDir);
      if (scripts.length === 0) {
        console.log(`  · scripts/ is empty`);
      } else {
        // On Unix, check executable permission
        if (process.platform !== 'win32') {
          for (const script of scripts) {
            const scriptPath = path.join(scriptsDir, script);
            try {
              fs.accessSync(scriptPath, fs.constants.X_OK);
              console.log(`  ✓ scripts/${script} (executable)`);
            } catch {
              console.error(`  ✗ scripts/${script} not executable`);
              hasErrors = true;
            }
          }
        } else {
          console.log(`  ✓ scripts/ (${scripts.length} file(s))`);
        }
      }
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
    console.log('\n✗ Lint failed with errors');
  } else {
    console.log('\n✓ All skills passed validation');
  }
}

function extractFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}
