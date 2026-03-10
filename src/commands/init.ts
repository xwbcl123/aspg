/**
 * aspg init — Initialize project infrastructure
 * Creates .agents/skills/ SSOT and vendor bridges for bridge vendors only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLink } from '../platform.js';
import { SSOT_DIR, getBridgeVendors, getNativeVendors } from '../vendors.js';

export async function initCommand(): Promise<void> {
  const root = process.cwd();
  const ssotPath = path.join(root, SSOT_DIR);

  // 1. Create SSOT directory
  if (!fs.existsSync(ssotPath)) {
    fs.mkdirSync(ssotPath, { recursive: true });
    console.log(`✓ Created ${SSOT_DIR}/`);
  } else {
    console.log(`· ${SSOT_DIR}/ already exists`);
  }

  // 2. Create vendor bridges (bridge vendors only)
  for (const [vendor, linkDir] of Object.entries(getBridgeVendors())) {
    const linkPath = path.join(root, linkDir);

    if (fs.existsSync(linkPath)) {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        console.log(`· ${linkDir} already exists (${vendor})`);
        continue;
      }
    }

    try {
      const result = await createLink(ssotPath, linkPath);
      console.log(`✓ Created ${linkDir} → ${SSOT_DIR}/ [${result.method}] (${vendor})`);
    } catch (err) {
      console.error(`✗ Failed to create ${linkDir} (${vendor}): ${(err as Error).message}`);
      process.exitCode = 2;
      return;
    }
  }

  // 3. Log native vendors (skipped)
  for (const [vendor] of Object.entries(getNativeVendors())) {
    console.log(`· Skipping ${vendor} (native — reads ${SSOT_DIR} directly)`);
  }

  // 4. Gemini manual hint
  console.log('');
  console.log('💡 Gemini: Run manually → gemini skills link .agents/skills');
}
