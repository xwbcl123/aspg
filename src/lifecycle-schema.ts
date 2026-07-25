/**
 * Portable, read-only lifecycle contracts.
 *
 * Lifecycle profiles deliberately exclude installation, exposure and runtime
 * state. Those remain derived by the existing Profile subsystem.
 */
import { z } from 'zod';

function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export const PortableDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO calendar date (YYYY-MM-DD)')
  .refine(isRealCalendarDate, 'expected a real ISO calendar date (YYYY-MM-DD)');

export const LearningLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5']);
export type LearningLevel = z.infer<typeof LearningLevelSchema>;

export const AdoptionStageSchema = z.enum([
  'none',
  'sandbox',
  'pilot',
  'production',
  'embedded',
  'suspended',
  'retired',
]);
export type AdoptionStage = z.infer<typeof AdoptionStageSchema>;

export const DispositionRelationTypeSchema = z.enum([
  'use-as-is',
  'configure',
  'wrap',
  'fork',
  'localized-derivative',
  'absorb',
  'compose',
  'reference',
  'reject',
  'archive',
]);
export type DispositionRelationType = z.infer<typeof DispositionRelationTypeSchema>;

export const FreshnessStatusSchema = z.enum([
  'current',
  'needs-revalidation',
  'stale',
  'superseded',
  'archived',
]);
export type FreshnessStatus = z.infer<typeof FreshnessStatusSchema>;

export const LifecycleOwnerClassSchema = z.enum([
  'third-party',
  'private',
  'private-canonical',
  'project-local',
  'sanitized-public',
]);
export type LifecycleOwnerClass = z.infer<typeof LifecycleOwnerClassSchema>;

export const EvidenceSchema = z.object({
  kind: z.string().trim().min(1),
  ref: z.string().trim().min(1),
  reviewed_at: PortableDateSchema,
  summary: z.string().trim().min(1).max(600).optional(),
  result: z.object({
    value: z.number(),
    rubric: z.string().trim().min(1).max(240),
    unit: z.string().trim().min(1).max(40).optional(),
  }).strict().optional(),
}).strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const AdoptionScopeSchema = z.object({
  project: z.string().trim().min(1),
  stage: AdoptionStageSchema,
  devices: z.array(z.string().trim().min(1)).default([]),
  workflows: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(EvidenceSchema).default([]),
}).strict();
export type AdoptionScope = z.infer<typeof AdoptionScopeSchema>;

export const DispositionRelationSchema = z.object({
  type: DispositionRelationTypeSchema,
  target: z.string().trim().min(1).optional(),
  base_revision: z.string().trim().regex(
    /^[0-9a-f]{40}$/,
    'base_revision must be a lowercase 40-character Git revision',
  ).optional(),
}).strict().superRefine((relation, ctx) => {
  if (
    ['configure', 'wrap', 'fork', 'localized-derivative', 'absorb', 'compose']
      .includes(relation.type)
    && !relation.target
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: `${relation.type} relation requires target`,
    });
  }
  const versionedRelations: DispositionRelationType[] = [
    'configure',
    'wrap',
    'fork',
    'localized-derivative',
    'absorb',
  ];
  if (relation.type === 'localized-derivative' && !relation.base_revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['base_revision'],
      message: 'localized-derivative relation requires base_revision',
    });
  }
  if (relation.base_revision && !versionedRelations.includes(relation.type)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['base_revision'],
      message: `${relation.type} relation must not declare base_revision`,
    });
  }
  if (
    ['use-as-is', 'reference', 'reject', 'archive'].includes(relation.type)
    && relation.target
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target'],
      message: `${relation.type} relation must not declare target`,
    });
  }
});
export type DispositionRelation = z.infer<typeof DispositionRelationSchema>;

const skillIdPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export const LifecycleProfileSchema = z.object({
  schema_version: z.literal(1),
  skill_id: z.string().trim().regex(
    skillIdPattern,
    'skill_id must be a portable namespace/name identifier',
  ),
  display_name: z.string().trim().min(1).max(160),
  source_ref: z.string().trim().regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'source_ref must be a portable source identifier',
  ),
  owner_class: LifecycleOwnerClassSchema,
  learning: z.object({
    current_level: LearningLevelSchema,
    target_level: LearningLevelSchema,
    evidence: z.array(EvidenceSchema).default([]),
  }).strict().superRefine((learning, ctx) => {
    const levels = LearningLevelSchema.options;
    if (levels.indexOf(learning.target_level) < levels.indexOf(learning.current_level)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target_level'],
        message: 'target_level cannot be lower than current_level',
      });
    }
  }),
  adoption: z.object({
    scopes: z.array(AdoptionScopeSchema).default([]),
  }).strict(),
  disposition: z.object({
    relations: z.array(DispositionRelationSchema).default([]),
  }).strict(),
  freshness: z.object({
    status: FreshnessStatusSchema,
    reviewed_at: PortableDateSchema,
    triggers: z.array(z.string().trim().min(1)).default([]),
  }).strict(),
  next_review_at: PortableDateSchema.optional(),
}).strict();
export type LifecycleProfile = z.infer<typeof LifecycleProfileSchema>;

export const LifecycleSourceEntrySchema = z.object({
  id: z.string().trim().min(1).optional(),
}).passthrough();
