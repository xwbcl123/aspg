/**
 * profile-schema.ts — Portable Foundation contracts for Profile planning.
 *
 * Portable project intent lives in the manifest/lock. Machine-local path
 * resolution lives in the device registry. None of these schemas mutate a
 * project runtime.
 */
import { z } from 'zod';

export const CommandMaturitySchema = z.enum(['current', 'mvp', 'future']);
export type CommandMaturity = z.infer<typeof CommandMaturitySchema>;

export const RuntimeOwnershipModeSchema = z.enum([
  'project-local',
  'managed-link',
  'managed-materialized',
  'catalog-only',
  'runtime-native',
]);
export type RuntimeOwnershipMode = z.infer<typeof RuntimeOwnershipModeSchema>;

export const SourceKindSchema = z.enum([
  'project-local',
  'git',
  'runtime-native',
]);

export const InstallBackendSchema = z.enum([
  'none',
  'symlink',
  'junction',
  'copy',
  'materialize',
]);
export type InstallBackend = z.infer<typeof InstallBackendSchema>;

export const SourceDefinitionSchema = z.object({
  kind: SourceKindSchema,
  repository: z.string().optional(),
  revision: z.string().optional(),
  path: z.string().optional(),
  privacy: z.enum(['private', 'sanitized-public', 'third-party']).optional(),
  upstream: z.object({
    repository: z.string().min(1),
    revision: z.string().min(1),
    path: z.string().optional(),
  }).optional(),
}).superRefine((source, ctx) => {
  if (source.kind === 'git' && !source.repository) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['repository'],
      message: 'git source requires repository',
    });
  }
});

export const SkillDefinitionSchema = z.object({
  source: z.string().min(1),
  path: z.string().min(1),
  ownership: RuntimeOwnershipModeSchema,
  description_chars: z.number().int().nonnegative(),
  capabilities: z.array(z.string()).default([]),
});

export const ProfileBudgetsSchema = z.object({
  max_skills: z.number().int().positive(),
  max_description_chars: z.number().int().positive(),
});

export const ProfileDefinitionSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  budgets: ProfileBudgetsSchema,
});

export const RuntimeDefinitionSchema = z.object({
  replacements: z.record(z.string()).default({}),
});

export const ProfileConcurrencySchema = z.object({
  mode: z.literal('stable-core-catalog-on-demand'),
  hot_switch_shared_runtime: z.literal(false),
  activation_lock: z.string().min(1),
});

export const ProjectManifestSchema = z.object({
  version: z.literal(1),
  project: z.string().min(1),
  command_maturity: z.object({
    profile_plan: CommandMaturitySchema,
    profile_apply: CommandMaturitySchema,
  }),
  concurrency: ProfileConcurrencySchema,
  core: z.array(z.string()).default([]),
  sources: z.record(SourceDefinitionSchema),
  skills: z.record(SkillDefinitionSchema),
  profiles: z.record(ProfileDefinitionSchema),
  runtimes: z.record(RuntimeDefinitionSchema).default({}),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const LockedSourceSchema = z.object({
  revision: z.string().min(1),
  tree_hash: z.string().min(1),
});

export const ManagedExposureSchema = z.object({
  target: z.string().min(1),
  ownership: z.enum(['managed-link', 'managed-materialized']),
  tree_hash: z.string().optional(),
});

export const ProjectLockSchema = z.object({
  version: z.literal(1),
  sources: z.record(LockedSourceSchema).default({}),
  managed: z.record(ManagedExposureSchema).default({}),
});
export type ProjectLock = z.infer<typeof ProjectLockSchema>;

export const DeviceDefinitionSchema = z.object({
  platform: z.enum(['darwin', 'linux', 'win32']),
  source_roots: z.record(z.string()),
  backends: z.object({
    'managed-link': z.enum(['symlink', 'junction', 'copy']),
    'managed-materialized': z.enum(['materialize', 'copy']),
  }),
});

export const DeviceRegistrySchema = z.object({
  version: z.literal(1),
  devices: z.record(DeviceDefinitionSchema),
});
export type DeviceRegistry = z.infer<typeof DeviceRegistrySchema>;
