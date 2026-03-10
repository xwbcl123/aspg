/**
 * aspg import — Import skills from vendor ecosystems to SSOT
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseDocument, stringify } from 'yaml';
import { SkillFrontmatterSchema, isVendorField, STANDARD_FIELDS } from '../schema.js';
import { SSOT_DIR } from '../vendors.js';

type Vendor = 'claude' | 'codex' | 'gemini';

interface ImportOptions {
  from: Vendor;
  path?: string;
  dryRun?: boolean;
}

/** Source path probe priorities per vendor */
const VENDOR_PATHS: Record<Vendor, (() => string)[]> = {
  claude: [
    () => process.env.CLAUDE_HOME ? path.join(process.env.CLAUDE_HOME, 'skills') : '',
    () => path.join(os.homedir(), '.claude', 'skills'),
    () => process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'claude', 'skills')
      : '',
  ],
  codex: [
    () => process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'skills') : '',
    () => path.join(os.homedir(), '.codex', 'skills'),
    () => path.join(os.homedir(), '.openai', 'skills'),
    () => process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'openai', 'skills')
      : '',
  ],
  gemini: [
    () => process.env.GEMINI_HOME ? path.join(process.env.GEMINI_HOME, 'skills') : '',
    () => path.join(os.homedir(), '.gemini', 'skills'),
    () => process.platform === 'win32'
      ? path.join(process.env.APPDATA || '', 'gemini', 'skills')
      : '',
  ],
};

export async function importCommand(
  skillName: string,
  opts: ImportOptions,
): Promise<void> {
  const { from: vendor, dryRun = false } = opts;
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);

  if (dryRun) console.log('[dry-run] No changes will be made.\n');

  if (!fs.existsSync(ssotPath)) {
    console.error(`✗ ${SSOT_DIR}/ not found. Run "aspg init" first.`);
    process.exitCode = 2;
    return;
  }

  // 1. Locate source
  const sourcePath = opts.path
    ? path.resolve(opts.path, skillName)
    : findVendorSkill(vendor, skillName);

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    console.error(`✗ Skill "${skillName}" not found for vendor "${vendor}"`);
    if (!opts.path) {
      console.error('Searched paths:');
      for (const probe of VENDOR_PATHS[vendor]) {
        const p = probe();
        if (p) console.error(`  - ${path.join(p, skillName)}`);
      }
    }
    process.exitCode = 2;
    return;
  }

  console.log(`Source: ${sourcePath}`);

  // 2. Check target doesn't exist
  const targetPath = path.join(ssotPath, skillName);
  if (fs.existsSync(targetPath)) {
    console.error(`✗ Skill "${skillName}" already exists in SSOT`);
    console.error('  Remove it manually before re-importing.');
    process.exitCode = 1;
    return;
  }

  // 3. Copy to SSOT
  if (dryRun) {
    console.log(`[dry-run] Would copy to ${SSOT_DIR}/${skillName}/`);
  } else {
    copyDirSync(sourcePath, targetPath);
    console.log(`✓ Copied to ${SSOT_DIR}/${skillName}/`);
  }

  // 4. Standardize SKILL.md
  const skillMd = path.join(dryRun ? sourcePath : targetPath, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    const result = standardize(skillMd, vendor, dryRun);
    if (result.stripped.length > 0) {
      console.log(`\nField changes:`);
      for (const field of result.stripped) {
        console.log(`  - Removed vendor field: ${field}`);
      }
    }
    if (result.injected.length > 0) {
      for (const field of result.injected) {
        console.log(`  + Injected: ${field}`);
      }
    }
  } else {
    console.warn(`⚠ No SKILL.md found — you'll need to create one`);
  }

  // 5. Auto lint + compat
  if (!dryRun) {
    console.log('\nRunning post-import validation...');
    // Inline lint check
    const lintOk = quickLint(targetPath);
    if (lintOk) {
      console.log('  ✓ Lint passed');
    } else {
      console.warn('  ⚠ Lint issues — run "aspg lint" for details');
    }
  }

  console.log('\n💡 Review the imported skill, then commit.');
}

function findVendorSkill(vendor: Vendor, skillName: string): string | null {
  const probes = VENDOR_PATHS[vendor];
  for (const probe of probes) {
    const base = probe();
    if (!base) continue;
    const full = path.join(base, skillName);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

interface StandardizeResult {
  stripped: string[];
  injected: string[];
}

function standardize(
  skillMdPath: string,
  vendor: string,
  dryRun: boolean,
): StandardizeResult {
  const content = fs.readFileSync(skillMdPath, 'utf-8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return { stripped: [], injected: [] };

  const doc = parseDocument(fmMatch[1]);
  const data = doc.toJSON() as Record<string, unknown>;
  const stripped: string[] = [];
  const injected: string[] = [];

  // Strip vendor-specific fields
  for (const key of Object.keys(data)) {
    if (!STANDARD_FIELDS.has(key) && isVendorField(key)) {
      delete data[key];
      stripped.push(key);
    }
  }

  // Inject aspg.origin
  if (!data.aspg || typeof data.aspg !== 'object') {
    data.aspg = {};
  }
  const aspg = data.aspg as Record<string, unknown>;
  aspg.origin = {
    vendor,
    imported_at: new Date().toISOString().split('T')[0],
    source_version: (data.version as string) || undefined,
  };
  injected.push('aspg.origin');

  if (!dryRun) {
    const newFm = stringify(data, { lineWidth: 0 });
    const body = content.slice(fmMatch[0].length);
    fs.writeFileSync(skillMdPath, `---\n${newFm}---${body}`, 'utf-8');
  }

  return { stripped, injected };
}

function quickLint(skillDir: string): boolean {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return false;

  const content = fs.readFileSync(skillMd, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;

  try {
    const doc = parseDocument(match[1]);
    const data = doc.toJSON();
    const result = SkillFrontmatterSchema.safeParse(data);
    return result.success;
  } catch {
    return false;
  }
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
