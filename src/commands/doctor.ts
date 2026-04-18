/**
 * aspg doctor — Topology & link health check
 * Only checks filesystem structure. Does NOT check env/deps (that's compat's job).
 */
import fs from 'node:fs';
import path from 'node:path';
import { COPY_MARKER, getLinkMethod, isValidLink, isCopyInSync, isStaleLink, hasCopyMarker } from '../platform.js';
import { SSOT_DIR, VENDOR_REGISTRY } from '../vendors.js';

export async function doctorCommand(): Promise<void> {
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);
  let hasIssues = false;

  console.log('ASPG Doctor — Topology Health Check\n');

  // 1. Check SSOT directory
  if (!fs.existsSync(ssotPath)) {
    console.error(`✗ ${SSOT_DIR}/ not found`);
    process.exitCode = 1;
    return;
  }
  const skills = fs.readdirSync(ssotPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  console.log(`✓ ${SSOT_DIR}/ exists (${skills.length} skill(s))`);

  const ssotMarkerPath = path.join(ssotPath, COPY_MARKER);
  const hasSsotMarker = hasCopyMarker(ssotPath);
  if (hasSsotMarker) {
    console.error(`✗ ${ssotMarkerPath} — SSOT polluted by copy-fallback marker`);
    console.error('  Run "aspg clean" to remove SSOT marker pollution');
    hasIssues = true;
  }

  // 2. Check vendor links (bridge vendors only for link health)
  for (const [vendor, def] of Object.entries(VENDOR_REGISTRY)) {
    const linkPath = path.join(root, def.linkDir);

    // Native vendors: check for redundant bridges (Stage 3 will enhance)
    if (def.mode === 'native') {
      if (!fs.existsSync(linkPath) && !isStaleLink(linkPath)) continue;

      const method = getLinkMethod(linkPath);
      if (method) {
        console.warn(`⚠ ${def.linkDir} — ${vendor} is native but has ASPG-generated bridge — duplicate discovery risk`);
        console.warn(`  Run "aspg clean" to remove`);
        hasIssues = true;
      } else if (fs.existsSync(linkPath)) {
        console.log(`· ${def.linkDir} exists but is not ASPG-managed (${vendor})`);
      }
      continue;
    }

    // Bridge vendors: existing link health check
    if (!fs.existsSync(linkPath) && !isStaleLink(linkPath)) {
      console.log(`· ${def.linkDir} — not created (${vendor})`);
      continue;
    }

    const method = getLinkMethod(linkPath);
    if (!method) {
      console.error(`✗ ${def.linkDir} — exists but not ASPG-managed (${vendor})`);
      hasIssues = true;
      continue;
    }

    if (method === 'copy') {
      if (isCopyInSync(linkPath, ssotPath)) {
        console.log(`✓ ${def.linkDir} — copy fallback, in sync (${vendor})`);
      } else {
        if (hasSsotMarker) {
          console.error(`✗ ${def.linkDir} — copy fallback check blocked by SSOT marker pollution (${vendor})`);
          console.error('  Clean SSOT marker pollution first, then rerun doctor/apply');
        } else {
          console.error(`✗ ${def.linkDir} — copy fallback, OUT OF SYNC (${vendor})`);
          console.error(`  Run "aspg apply" to refresh`);
        }
        hasIssues = true;
      }
      continue;
    }

    if (isValidLink(linkPath, ssotPath)) {
      console.log(`✓ ${def.linkDir} → valid [${method}] (${vendor})`);
    } else {
      console.error(`✗ ${def.linkDir} — broken link (${vendor})`);
      console.error(`  Run "aspg apply" to fix`);
      hasIssues = true;
    }
  }

  // 3. Vendor classification summary
  console.log('\nVendor Classification:');
  for (const [vendor, def] of Object.entries(VENDOR_REGISTRY)) {
    const label = def.mode === 'native'
      ? 'native  (reads .agents/skills directly)'
      : 'bridge  (needs vendor-local bridge)';
    console.log(`  ${vendor.padEnd(10)} ${label}`);
  }

  // 4. Check for orphan vendor skills (bridge vendors with copy fallback only)
  console.log('');
  for (const [vendor, def] of Object.entries(VENDOR_REGISTRY)) {
    if (def.mode === 'native') continue;
    const linkPath = path.join(root, def.linkDir);
    if (!fs.existsSync(linkPath)) continue;

    const method = getLinkMethod(linkPath);
    if (method === 'symlink') continue;

    if (method === 'copy') {
      const copyFiles = fs.readdirSync(linkPath)
        .filter((f) => f !== '.aspg-copy-fallback');
      const ssotSkills = new Set(skills);
      for (const item of copyFiles) {
        if (!ssotSkills.has(item)) {
          console.warn(`⚠ ${def.linkDir}/${item} — orphan (not in SSOT) [${vendor}]`);
          hasIssues = true;
        }
      }
    }
  }

  // Summary
  console.log('');
  if (hasIssues) {
    console.error('✗ Issues found — run "aspg apply" or "aspg clean" to fix');
    process.exitCode = 1;
  } else {
    console.log('✓ Topology is healthy');
  }
}
