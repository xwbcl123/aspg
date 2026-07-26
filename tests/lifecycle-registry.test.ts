import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { hashDirectory } from '../src/profile-plan.js';
import {
  lifecycleList,
  lifecycleRecommendations,
  lifecycleStatus,
  loadLifecycleRegistries,
} from '../src/lifecycle-registry.js';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'lifecycle-valid',
);
const invalidFixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'lifecycle-invalid',
);

let tmpDir: string;
let registryRoot: string;

function writeRegistry(
  root: string,
  sources: Record<string, Record<string, unknown>>,
  profiles: Array<Record<string, unknown>>,
): void {
  fs.mkdirSync(path.join(root, 'registry', 'lifecycle'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry', 'sources.yaml'),
    stringifyYaml({ schema_version: 1, sources }),
  );
  for (const profile of profiles) {
    const skillId = profile.skill_id as string;
    const [namespace, name] = skillId.split('/');
    const directory = path.join(root, 'registry', 'lifecycle', namespace, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'profile.yaml'), stringifyYaml(profile));
  }
}

function addFixtureIdentityDeclarations(root: string): void {
  const declarations = [
    ['registry/lifecycle/kepano/defuddle/profile.yaml', 'skills/defuddle'],
    [
      'registry/lifecycle/mattpocock/grill-with-docs/profile.yaml',
      'skills/grill-with-docs',
    ],
  ] as const;
  for (const [relativePath, sourcePath] of declarations) {
    const profilePath = path.join(root, relativePath);
    const profile = parseYaml(fs.readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    profile.source_path = sourcePath;
    fs.writeFileSync(profilePath, stringifyYaml(profile));
  }
}

function minimalProfile(
  skillId: string,
  sourceRef: string,
  relation: Record<string, unknown> = { type: 'reference' },
): Record<string, unknown> {
  return {
    schema_version: 1,
    skill_id: skillId,
    display_name: skillId,
    source_ref: sourceRef,
    source_path: `skills/${skillId.split('/')[1]}`,
    owner_class: sourceRef === 'private-source' ? 'private-canonical' : 'third-party',
    learning: { current_level: 'L0', target_level: 'L0', evidence: [] },
    adoption: { scopes: [] },
    disposition: { relations: [relation] },
    freshness: { status: 'current', reviewed_at: '2026-07-25', triggers: [] },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspg-lifecycle-'));
  registryRoot = path.join(tmpDir, 'registry-one');
  fs.cpSync(fixtureRoot, registryRoot, { recursive: true });
  addFixtureIdentityDeclarations(registryRoot);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('federated lifecycle registry', () => {
  it('loads external, derivative and project-local profiles in stable ID order', () => {
    const snapshot = loadLifecycleRegistries([registryRoot]);
    expect(snapshot.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    expect(snapshot.skills.map((item) => item.skill_id)).toEqual([
      'kepano/defuddle',
      'martin/visual-mail',
      'mattpocock/grill-with-docs',
    ]);
    expect(lifecycleList(snapshot)[2]).toMatchObject({
      skill_id: 'mattpocock/grill-with-docs',
      owner_class: 'third-party',
      aggregate_adoption: 'pilot',
    });
  });

  it('is byte-deterministic and performs no writes', () => {
    const before = hashDirectory(registryRoot);
    const first = JSON.stringify(loadLifecycleRegistries([registryRoot]));
    const second = JSON.stringify(loadLifecycleRegistries([registryRoot]));
    const after = hashDirectory(registryRoot);
    expect(first).toBe(second);
    expect(after).toBe(before);
    expect(JSON.parse(first).writes_performed).toBe(0);
  });

  it('marks lifeos://41.15 refs unverified when resolution is not requested', () => {
    const snapshot = loadLifecycleRegistries([registryRoot]);
    expect(snapshot.evidence_resolution_mode).toBe('not-requested');
    expect(snapshot.diagnostics.some((item) => item.code === 'evidence-unresolved')).toBe(true);
    const grill = snapshot.skills.find((item) => item.skill_id === 'mattpocock/grill-with-docs');
    expect(grill?.evidence_gates.some((gate) => gate.verification === 'unverified')).toBe(true);
    expect(grill?.evidence_resolution.some((item) => item.resolution === 'not-requested')).toBe(true);
  });

  it('summarizes scoped adoption without flattening project/device differences', () => {
    const status = lifecycleStatus(loadLifecycleRegistries([registryRoot]), '2026-09-01');
    expect(status).toMatchObject({
      total_skills: 3,
      valid: true,
      learning: { L1: 1, L3: 1, L4: 1 },
      aggregate_adoption: { pilot: 1, production: 1, sandbox: 1 },
    });
    expect(status.scoped_adoption.devices).toMatchObject({
      'linux-server:pilot': 1,
      'linux-server:production': 1,
      'mac-mini:none': 1,
      'mac-mini:sandbox': 1,
      'macbook-pro:pilot': 1,
      'macbook-pro:production': 1,
    });
    const visualMail = lifecycleList(loadLifecycleRegistries([registryRoot]))
      .find((entry) => entry.skill_id === 'martin/visual-mail');
    expect(visualMail?.aggregate_adoption).toBe('production');
    expect(visualMail?.adoption_scopes).toEqual([
      {
        project: 'life-os',
        stage: 'none',
        devices: ['mac-mini'],
        workflows: [],
      },
      {
        project: 'work-pkm',
        stage: 'production',
        devices: ['linux-server', 'macbook-pro'],
        workflows: ['visual-email-production'],
      },
    ]);
  });

  it('ranks deterministic next actions by policy priority and skill ID', () => {
    const recommendations = lifecycleRecommendations(
      loadLifecycleRegistries([registryRoot]),
      '2026-09-01',
    );
    expect(recommendations.map((item) => `${item.priority}:${item.skill_id}:${item.code}`)).toEqual([
      '1:martin/visual-mail:revalidate-production',
      '2:mattpocock/grill-with-docs:complete-production-gate',
      '3:kepano/defuddle:advance-learning',
    ]);
  });

  it('fails duplicate skill IDs across roots with a distinct-ID remediation', () => {
    const secondRoot = path.join(tmpDir, 'registry-two');
    fs.cpSync(fixtureRoot, secondRoot, { recursive: true });
    const snapshot = loadLifecycleRegistries([secondRoot, registryRoot]);
    const duplicates = snapshot.diagnostics.filter((item) => item.code === 'duplicate-skill-id');
    expect(duplicates).toHaveLength(3);
    expect(duplicates[0].message).toContain('distinct ID');
    expect(snapshot.skills).toHaveLength(3);
  });

  it('rejects duplicate source_ref/source_path identity across the combined registry', () => {
    const firstRoot = path.join(tmpDir, 'identity-one');
    const secondRoot = path.join(tmpDir, 'identity-two');
    writeRegistry(
      firstRoot,
      { shared: { source_type: 'git' } },
      [{
        ...minimalProfile('alpha/tool-one', 'shared'),
        source_path: 'skills/shared-tool',
      }],
    );
    writeRegistry(
      secondRoot,
      { shared: { source_type: 'git' } },
      [{
        ...minimalProfile('beta/tool-two', 'shared'),
        source_path: 'skills/shared-tool',
      }],
    );

    const snapshot = loadLifecycleRegistries([secondRoot, firstRoot]);
    const diagnostic = snapshot.diagnostics.find((item) =>
      item.code === 'unique-source-ref-source-path');
    expect(diagnostic).toMatchObject({
      severity: 'error',
      skill_id: 'beta/tool-two',
      source_ref: 'shared',
      source_path: 'skills/shared-tool',
      profile_path: 'registry/lifecycle/beta/tool-two/profile.yaml',
    });
    expect(diagnostic?.message).toContain('alpha/tool-one');
  });

  it('rejects forbidden canonical project and device suffixes with stable profile paths', () => {
    const root = path.join(tmpDir, 'suffixes');
    writeRegistry(
      root,
      { shared: { source_type: 'git' } },
      [
        minimalProfile('martin/tool-life-os', 'shared'),
        minimalProfile('martin/tool-linux', 'shared'),
        minimalProfile('martin/tool-mac-mini', 'shared'),
        minimalProfile('martin/tool-macbook-pro', 'shared'),
        minimalProfile('martin/tool-work-pkm', 'shared'),
      ],
    );

    const diagnostics = loadLifecycleRegistries([root]).diagnostics
      .filter((item) => item.code === 'forbidden-canonical-suffix');
    expect(diagnostics.map((item) => [item.skill_id, item.profile_path])).toEqual([
      ['martin/tool-life-os', 'registry/lifecycle/martin/tool-life-os/profile.yaml'],
      ['martin/tool-linux', 'registry/lifecycle/martin/tool-linux/profile.yaml'],
      ['martin/tool-mac-mini', 'registry/lifecycle/martin/tool-mac-mini/profile.yaml'],
      ['martin/tool-macbook-pro', 'registry/lifecycle/martin/tool-macbook-pro/profile.yaml'],
      ['martin/tool-work-pkm', 'registry/lifecycle/martin/tool-work-pkm/profile.yaml'],
    ]);
  });

  it('rejects cross-namespace basenames unless direct lineage resolves the collision', () => {
    const unresolvedRoot = path.join(tmpDir, 'basename-unresolved');
    writeRegistry(
      unresolvedRoot,
      { shared: { source_type: 'git', pinned_revision: 'a'.repeat(40) } },
      [
        {
          ...minimalProfile('anthropic/brand-guidelines', 'shared'),
          source_path: 'upstream/brand-guidelines',
        },
        {
          ...minimalProfile('martin/brand-guidelines', 'shared'),
          source_path: 'skills/brand-guidelines',
        },
      ],
    );
    const collision = loadLifecycleRegistries([unresolvedRoot]).diagnostics.find((item) =>
      item.code === 'cross-namespace-exposure-basename');
    expect(collision).toMatchObject({
      severity: 'error',
      skill_id: 'martin/brand-guidelines',
      profile_path: 'registry/lifecycle/martin/brand-guidelines/profile.yaml',
    });

    const resolvedRoot = path.join(tmpDir, 'basename-resolved');
    writeRegistry(
      resolvedRoot,
      {
        upstream: { source_type: 'git', pinned_revision: 'a'.repeat(40) },
        private: { source_type: 'private-canonical', path: '.' },
      },
      [
        minimalProfile('anthropic/brand-guidelines', 'upstream'),
        {
          ...minimalProfile('martin/brand-guidelines', 'private'),
          owner_class: 'private-canonical',
          disposition: {
            relations: [{
              type: 'localized-derivative',
              target: 'anthropic/brand-guidelines',
              base_revision: 'a'.repeat(40),
            }],
          },
        },
      ],
    );
    expect(loadLifecycleRegistries([resolvedRoot]).diagnostics
      .some((item) => item.code === 'cross-namespace-exposure-basename')).toBe(false);
  });

  it('requires source_path for Git-backed third-party profiles but stages existence checks', () => {
    const externalRoot = path.join(tmpDir, 'external-path');
    const external = minimalProfile('upstream/tool', 'external');
    delete external.source_path;
    writeRegistry(
      externalRoot,
      { external: { source_type: 'git' } },
      [external],
    );
    expect(loadLifecycleRegistries([externalRoot]).diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'source-path-required',
        profile_path: 'registry/lifecycle/upstream/tool/profile.yaml',
      }),
    );

    const privateRoot = path.join(tmpDir, 'private-path');
    writeRegistry(
      privateRoot,
      { 'private-source': { source_type: 'private-canonical', path: '.' } },
      [minimalProfile('martin/not-yet-imported', 'private-source')],
    );
    const privateSnapshot = loadLifecycleRegistries([privateRoot]);
    expect(privateSnapshot.diagnostics.some((item) =>
      item.code === 'source-skill-path-not-found')).toBe(false);
    expect(privateSnapshot.skills[0].source_integrity.status).toBe('verified');
    expect(privateSnapshot.skills[0].source_integrity.checks).toContainEqual({
      check: 'source-path-declaration',
      status: 'verified',
      message: 'portable source_path is declared: skills/not-yet-imported',
    });
  });

  it('rejects missing source refs, traversal and private summaries', () => {
    const invalidRoot = path.join(tmpDir, 'invalid');
    fs.cpSync(invalidFixtureRoot, invalidRoot, { recursive: true });
    const snapshot = loadLifecycleRegistries([invalidRoot]);
    const codes = snapshot.diagnostics.map((item) => item.code);
    expect(codes).toContain('source-reference-missing');
    expect(codes).toContain('evidence-path-traversal');
    expect(codes).toContain('private-evidence-summary');
    expect(codes).toContain('secret-like-evidence-summary');
  });

  it('rejects absolute paths, unknown opaque schemes and invalid Life-OS refs', () => {
    const profilePath = path.join(
      registryRoot,
      'registry/lifecycle/kepano/defuddle/profile.yaml',
    );
    const original = fs.readFileSync(profilePath, 'utf8');
    const cases = [
      ['/tmp/private.md', 'absolute-evidence-path'],
      ['https://example.invalid/evidence', 'unapproved-evidence-scheme'],
      ['lifeos://41.15/unknown/item', 'invalid-lifeos-reference'],
      ['lifeos://41.15/skills/mattpocock/grill-me', 'invalid-lifeos-reference'],
    ] as const;
    for (const [replacement, expectedCode] of cases) {
      fs.writeFileSync(
        profilePath,
        original.replace('evidence/defuddle-reproduction.md', replacement),
      );
      const codes = loadLifecycleRegistries([registryRoot]).diagnostics.map((item) => item.code);
      expect(codes).toContain(expectedCode);
    }
  });

  it('resolves Life-OS notes only when requested and distinguishes unavailable from missing', () => {
    const unavailable = loadLifecycleRegistries(
      [registryRoot],
      { lifeosRoot: path.join(tmpDir, 'not-mounted') },
    );
    expect(unavailable.diagnostics.some((item) => item.code === 'evidence-unresolved')).toBe(true);
    expect(unavailable.diagnostics.some((item) => item.severity === 'error')).toBe(false);
    expect(unavailable.skills[2].evidence_gates.some((gate) =>
      gate.verification === 'unverified')).toBe(true);

    const lifeosRoot = path.join(tmpDir, 'lifeos-41.15');
    fs.mkdirSync(lifeosRoot);
    const missing = loadLifecycleRegistries([registryRoot], { lifeosRoot });
    expect(missing.diagnostics.some((item) => item.code === 'evidence-reference-missing')).toBe(true);
    expect(missing.skills[2].evidence_gates.some((gate) => gate.verification === 'failed')).toBe(true);

    fs.mkdirSync(path.join(lifeosRoot, '10_skill-notes'));
    fs.mkdirSync(path.join(lifeosRoot, '20_experiments'));
    fs.writeFileSync(
      path.join(lifeosRoot, '10_skill-notes', 'mattpocock-grill-with-docs.md'),
      '# Skill note\n',
    );
    fs.writeFileSync(
      path.join(lifeosRoot, '20_experiments', 'grill-localization.md'),
      '# Experiment\n',
    );
    const resolved = loadLifecycleRegistries([registryRoot], { lifeosRoot });
    expect(resolved.diagnostics.some((item) => item.severity === 'error')).toBe(false);
    const grill = resolved.skills.find((item) => item.skill_id === 'mattpocock/grill-with-docs');
    expect(grill?.evidence_resolution.filter((item) => item.ref.startsWith('lifeos://'))
      .every((item) => item.resolution === 'resolved')).toBe(true);
    expect(grill?.evidence_gates.every((gate) => gate.verification === 'verified')).toBe(true);
  });

  it('rejects owner-relative evidence symlinks that resolve outside the owner root', () => {
    const profilePath = path.join(
      registryRoot,
      'registry/lifecycle/kepano/defuddle/profile.yaml',
    );
    fs.writeFileSync(
      profilePath,
      fs.readFileSync(profilePath, 'utf8')
        .replace('evidence/defuddle-reproduction.md', 'evidence/escape.md'),
    );
    fs.symlinkSync('/etc/hosts', path.join(registryRoot, 'evidence', 'escape.md'));
    const snapshot = loadLifecycleRegistries([registryRoot]);
    expect(snapshot.diagnostics.map((item) => item.code)).toContain('evidence-symlink-escape');
  });

  it('scans absolute home paths in every user-controlled profile string', () => {
    const profilePath = path.join(
      registryRoot,
      'registry/lifecycle/kepano/defuddle/profile.yaml',
    );
    fs.writeFileSync(
      profilePath,
      fs.readFileSync(profilePath, 'utf8')
        .replace('project: life-os', 'project: /Users/martin/private-project'),
    );
    const snapshot = loadLifecycleRegistries([registryRoot]);
    expect(snapshot.diagnostics.map((item) => item.code)).toContain('absolute-home-path');
  });

  it('defines lineage as current profile being a derivative of target and verifies target pin', () => {
    const upstreamRoot = path.join(tmpDir, 'upstream');
    const privateRoot = path.join(tmpDir, 'private');
    const revision = 'a'.repeat(40);
    writeRegistry(
      upstreamRoot,
      { 'upstream-source': { source_type: 'git', pinned_revision: revision } },
      [minimalProfile('upstream/base', 'upstream-source')],
    );
    writeRegistry(
      privateRoot,
      { 'private-source': { source_type: 'private-canonical', path: '.' } },
      [minimalProfile('martin/derived', 'private-source', {
        type: 'localized-derivative',
        target: 'upstream/base',
        base_revision: revision,
      })],
    );
    const positive = loadLifecycleRegistries([privateRoot, upstreamRoot]);
    expect(positive.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);

    const derivativePath = path.join(
      privateRoot,
      'registry/lifecycle/martin/derived/profile.yaml',
    );
    fs.writeFileSync(
      derivativePath,
      fs.readFileSync(derivativePath, 'utf8').replace('upstream/base', 'missing/not-real'),
    );
    expect(loadLifecycleRegistries([privateRoot, upstreamRoot]).diagnostics
      .map((item) => item.code)).toContain('lineage-target-missing');
  });

  it('rejects reverse derivative direction and target pin drift', () => {
    const upstreamRoot = path.join(tmpDir, 'upstream');
    const privateRoot = path.join(tmpDir, 'private');
    const revision = 'a'.repeat(40);
    writeRegistry(
      upstreamRoot,
      { 'upstream-source': { source_type: 'git', pinned_revision: revision } },
      [minimalProfile('upstream/base', 'upstream-source', {
        type: 'localized-derivative',
        target: 'martin/derived',
        base_revision: revision,
      })],
    );
    writeRegistry(
      privateRoot,
      { 'private-source': { source_type: 'private-canonical', path: '.' } },
      [minimalProfile('martin/derived', 'private-source')],
    );
    const reverse = loadLifecycleRegistries([privateRoot, upstreamRoot]);
    expect(reverse.diagnostics.map((item) => item.code)).toContain('lineage-target-pin-missing');

    const upstreamProfile = path.join(
      upstreamRoot,
      'registry/lifecycle/upstream/base/profile.yaml',
    );
    fs.writeFileSync(
      upstreamProfile,
      stringifyYaml(minimalProfile('upstream/base', 'upstream-source')),
    );
    const privateProfile = path.join(
      privateRoot,
      'registry/lifecycle/martin/derived/profile.yaml',
    );
    fs.writeFileSync(
      privateProfile,
      stringifyYaml(minimalProfile('martin/derived', 'private-source', {
        type: 'localized-derivative',
        target: 'upstream/base',
        base_revision: 'b'.repeat(40),
      })),
    );
    expect(loadLifecycleRegistries([privateRoot, upstreamRoot]).diagnostics
      .map((item) => item.code)).toContain('lineage-revision-mismatch');
  });

  it('fails read-only source integrity when a pinned submodule checkout/gitlink is absent', () => {
    const sourceRoot = path.join(tmpDir, 'missing-submodule');
    writeRegistry(
      sourceRoot,
      {
        'missing-source': {
          source_type: 'git-submodule',
          path: 'sources/missing',
          pinned_revision: 'a'.repeat(40),
          skill_paths: { 'upstream/base': 'skills/base' },
        },
      },
      [minimalProfile('upstream/base', 'missing-source')],
    );
    const snapshot = loadLifecycleRegistries([sourceRoot]);
    const codes = snapshot.diagnostics.map((item) => item.code);
    expect(codes).toContain('source-submodule-missing');
    expect(codes).toContain('source-gitlink-unavailable');
    expect(snapshot.skills[0].source_integrity.status).toBe('failed');
  });
});
