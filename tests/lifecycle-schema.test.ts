import { describe, expect, it } from 'vitest';
import {
  LifecycleProfileSchema,
  type LifecycleProfile,
} from '../src/lifecycle-schema.js';
import { evaluateEvidenceGates } from '../src/lifecycle-evidence.js';

function validProfile(): LifecycleProfile {
  return LifecycleProfileSchema.parse({
    schema_version: 1,
    skill_id: 'martin/example',
    display_name: 'Example',
    source_ref: 'private-source',
    source_path: 'skills/example',
    owner_class: 'private-canonical',
    learning: {
      current_level: 'L3',
      target_level: 'L4',
      evidence: [
        { kind: 'reproduction', ref: 'evidence/reproduction.md', reviewed_at: '2026-07-25' },
        {
          kind: 'architecture-review',
          ref: 'lifeos://41.15/skills/martin-example',
          reviewed_at: '2026-07-25',
        },
        { kind: 'adaptation', ref: 'evidence/adaptation.md', reviewed_at: '2026-07-25' },
        { kind: 'validation', ref: 'evidence/validation.md', reviewed_at: '2026-07-25' },
      ],
    },
    adoption: {
      scopes: [{
        project: 'life-os',
        stage: 'pilot',
        devices: ['mac-mini'],
        workflows: ['interview'],
        evidence: [
          { kind: 'source-review', ref: 'evidence/source.md', reviewed_at: '2026-07-25' },
          { kind: 'reproduction', ref: 'evidence/reproduction.md', reviewed_at: '2026-07-25' },
        ],
      }],
    },
    disposition: {
      relations: [
        {
          type: 'localized-derivative',
          target: 'martin/example-localized',
          base_revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ],
    },
    freshness: {
      status: 'current',
      reviewed_at: '2026-07-25',
      triggers: ['upstream-change'],
    },
    next_review_at: '2026-08-25',
  });
}

describe('LifecycleProfileSchema', () => {
  it('accepts the portable v1 contract and keeps lifecycle independent of deployment', () => {
    const profile = validProfile();
    expect(profile.skill_id).toBe('martin/example');
    expect(profile).not.toHaveProperty('installed');
    expect(profile).not.toHaveProperty('runtime');
  });

  it('rejects non-portable IDs and deployment-state additions', () => {
    const profile = validProfile() as unknown as Record<string, unknown>;
    profile.skill_id = '../example';
    profile.installed = true;
    expect(LifecycleProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('requires a portable repository-relative source_path for canonical owners', () => {
    const repositoryRoot = validProfile();
    repositoryRoot.source_path = '.';
    expect(LifecycleProfileSchema.safeParse(repositoryRoot).success).toBe(true);

    const missing = validProfile() as unknown as Record<string, unknown>;
    delete missing.source_path;
    expect(LifecycleProfileSchema.safeParse(missing).success).toBe(false);

    for (const invalid of [
      '/skills/example',
      './skills/example',
      'skills/./example',
      'skills/example/.',
      '../skills/example',
      'skills/../example',
      'skills/example/..',
      '..',
      'skills\\example',
      'C:/skills/example',
      '~/skills/example',
      'skills//example',
    ]) {
      const profile = validProfile();
      profile.source_path = invalid;
      expect(LifecycleProfileSchema.safeParse(profile).success).toBe(false);
    }

    const projectLocal = validProfile();
    projectLocal.owner_class = 'project-local';
    delete projectLocal.source_path;
    expect(LifecycleProfileSchema.safeParse(projectLocal).success).toBe(true);
  });

  it('rejects a target learning level below the declared current level', () => {
    const profile = validProfile();
    profile.learning.target_level = 'L2';
    expect(LifecycleProfileSchema.safeParse(profile).success).toBe(false);
  });

  it('allows absence as no scopes and requires stage inside each declared scope', () => {
    const noScope = validProfile();
    noScope.adoption.scopes = [];
    expect(LifecycleProfileSchema.safeParse(noScope).success).toBe(true);

    const missingStage = validProfile() as unknown as {
      adoption: { scopes: Array<Record<string, unknown>> };
    };
    delete missingStage.adoption.scopes[0].stage;
    expect(LifecycleProfileSchema.safeParse(missingStage).success).toBe(false);

    const noRevision = validProfile();
    delete noRevision.disposition.relations[0].base_revision;
    expect(LifecycleProfileSchema.safeParse(noRevision).success).toBe(false);
  });

  it('rejects impossible calendar dates and non-Git lineage revisions', () => {
    const impossibleDate = validProfile();
    impossibleDate.next_review_at = '2026-99-99';
    expect(LifecycleProfileSchema.safeParse(impossibleDate).success).toBe(false);

    const badRevision = validProfile();
    badRevision.disposition.relations[0].base_revision = 'not-a-revision';
    expect(LifecycleProfileSchema.safeParse(badRevision).success).toBe(false);
  });
});

describe('lifecycle Evidence Gates', () => {
  it('recognizes approved aliases and cumulative L1-L3 plus Pilot evidence', () => {
    const gates = evaluateEvidenceGates(validProfile());
    expect(gates).toEqual([
      { gate: 'L1', satisfied: true, verification: 'verified', missing: [], unverified: [] },
      { gate: 'L2', satisfied: true, verification: 'verified', missing: [], unverified: [] },
      { gate: 'L3', satisfied: true, verification: 'verified', missing: [], unverified: [] },
      {
        gate: 'pilot',
        scope: {
          project: 'life-os',
          stage: 'pilot',
          devices: ['mac-mini'],
          workflows: ['interview'],
        },
        satisfied: true,
        verification: 'verified',
        missing: [],
        unverified: [],
      },
    ]);
  });

  it('reports missing evidence without mutating or promoting the profile', () => {
    const profile = validProfile();
    profile.learning.evidence = [];
    const gates = evaluateEvidenceGates(profile);
    expect(gates.find((gate) => gate.gate === 'L3')?.missing).toEqual([
      'adaptation',
      'validation',
    ]);
    expect(profile.learning.current_level).toBe('L3');
  });
});
