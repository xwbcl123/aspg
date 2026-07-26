/**
 * Portable Portfolio v1 contracts.
 *
 * The Portfolio Manifest and Lock are the sole cross-deployment revision
 * authority. Absolute machine paths are deliberately confined to the
 * device-local registry.
 */
import path from 'node:path';
import { z } from 'zod';
import {
  CommandMaturitySchema,
  InstallBackendSchema,
  RuntimeOwnershipModeSchema,
} from './profile-schema.js';

const portableIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const canonicalSkillIdPattern =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const treeHashPattern = /^sha256:[0-9a-f]{64}$/;

function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function looksAbsolute(value: string): boolean {
  return path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value === '~'
    || value.startsWith('~/')
    || value.startsWith('~\\')
    || /^file:/i.test(value);
}

function isSameOrWithinAbsolute(parent: string, candidate: string): boolean {
  const pathApi = path.win32.isAbsolute(parent) || path.win32.isAbsolute(candidate)
    ? path.win32
    : path.posix;
  const relative = pathApi.relative(pathApi.normalize(parent), pathApi.normalize(candidate));
  return relative === ''
    || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function rejectAbsoluteStrings(
  value: unknown,
  ctx: z.RefinementCtx,
  location: Array<string | number> = [],
): void {
  if (typeof value === 'string') {
    if (looksAbsolute(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: location,
        message: 'absolute paths are allowed only in the device-local registry',
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectAbsoluteStrings(entry, ctx, [...location, index]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      rejectAbsoluteStrings(entry, ctx, [...location, key]);
    }
  }
}

export const PortfolioPortableIdSchema = z.string().regex(
  portableIdPattern,
  'expected a portable lowercase identifier',
);

export const CanonicalSkillIdSchema = z.string().regex(
  canonicalSkillIdPattern,
  'expected a canonical namespace/name Skill identifier',
);

export const GitRevisionSchema = z.string().regex(
  revisionPattern,
  'expected a lowercase 40-character Git revision',
);

export const SkillTreeHashSchema = z.string().regex(
  treeHashPattern,
  'expected sha256 followed by 64 lowercase hexadecimal characters',
);

export const PortfolioDateSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealCalendarDate, 'expected a real calendar date');

export const PortableRelativePathSchema = z.string().min(1).superRefine((value, ctx) => {
  if (looksAbsolute(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'expected a portable relative path',
    });
  }
  if (value.includes('\\')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'backslashes are not portable',
    });
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'path contains characters outside the portable path alphabet',
    });
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === '..'
    || normalized.startsWith('../')
    || normalized !== value
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'path must be normalized and must not traverse its owner root',
    });
  }
});

/**
 * A Skill may occupy its source repository root. Other Portfolio paths retain
 * the stricter non-root relative-path contract.
 */
export const PortfolioSkillPathSchema = z.union([
  z.literal('.'),
  PortableRelativePathSchema,
]);

export const AbsoluteDevicePathSchema = z.string().min(1).refine(
  (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value),
  'device registry paths must be absolute',
);

export const PortfolioSourceSchema = z.object({
  kind: z.literal('git'),
  repository: z.string().trim().min(1),
  privacy: z.enum(['private', 'sanitized-public', 'third-party']),
}).strict();

export const PortfolioSkillSchema = z.object({
  source: PortfolioPortableIdSchema,
  path: PortfolioSkillPathSchema,
  ownership: RuntimeOwnershipModeSchema,
  exposure_name: PortfolioPortableIdSchema,
  description_chars: z.number().int().nonnegative(),
  capabilities: z.array(PortfolioPortableIdSchema).default([]),
}).strict().superRefine((skill, ctx) => {
  if (skill.ownership === 'project-local' || skill.ownership === 'runtime-native') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ownership'],
      message: `${skill.ownership} is not a centrally revisioned Portfolio Skill`,
    });
  }
});

export const PortfolioBudgetsSchema = z.object({
  max_skills: z.number().int().positive(),
  max_description_chars: z.number().int().positive(),
}).strict();

export const PortfolioProfileSchema = z.object({
  include: z.array(CanonicalSkillIdSchema).default([]),
  exclude: z.array(CanonicalSkillIdSchema).default([]),
  budgets: PortfolioBudgetsSchema,
}).strict();

export const PortfolioDeploymentSchema = z.object({
  project_ref: PortfolioPortableIdSchema,
  profiles: z.array(PortfolioPortableIdSchema).min(1),
  include: z.array(CanonicalSkillIdSchema).default([]),
  exclude: z.array(CanonicalSkillIdSchema).default([]),
}).strict();

export const PortfolioProjectSchema = z.object({
  expected_vault: PortfolioPortableIdSchema,
}).strict();

export const PortfolioManifestSchema = z.object({
  version: z.literal(1),
  portfolio: PortfolioPortableIdSchema,
  command_maturity: z.object({
    portfolio_plan: CommandMaturitySchema,
    portfolio_apply: z.literal('future'),
  }).strict(),
  concurrency: z.object({
    activation_lock: z.literal('device-local'),
  }).strict(),
  sources: z.record(PortfolioPortableIdSchema, PortfolioSourceSchema),
  skills: z.record(CanonicalSkillIdSchema, PortfolioSkillSchema),
  profiles: z.record(PortfolioPortableIdSchema, PortfolioProfileSchema),
  deployments: z.record(PortfolioPortableIdSchema, PortfolioDeploymentSchema),
  projects: z.record(PortfolioPortableIdSchema, PortfolioProjectSchema),
}).strict().superRefine((manifest, ctx) => {
  rejectAbsoluteStrings(manifest, ctx);
});
export type PortfolioManifest = z.infer<typeof PortfolioManifestSchema>;

export const PortfolioLockedSourceSchema = z.object({
  revision: GitRevisionSchema,
}).strict();

export const PortfolioLockedSkillSchema = z.object({
  source: PortfolioPortableIdSchema,
  path: PortfolioSkillPathSchema,
  source_revision: GitRevisionSchema,
  tree_hash: SkillTreeHashSchema,
  executable_files: z.array(PortableRelativePathSchema).default([]),
  overlay_hash: SkillTreeHashSchema.nullable().default(null),
}).strict().superRefine((skill, ctx) => {
  const unique = new Set(skill.executable_files);
  if (unique.size !== skill.executable_files.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executable_files'],
      message: 'executable_files must not contain duplicates',
    });
  }
  const sorted = [...skill.executable_files].sort();
  if (sorted.some((entry, index) => entry !== skill.executable_files[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['executable_files'],
      message: 'executable_files must be sorted for deterministic locks',
    });
  }
});

export const PortfolioLockedDeploymentSchema = z.object({
  resolved_skills: z.array(CanonicalSkillIdSchema),
}).strict().superRefine((deployment, ctx) => {
  const unique = new Set(deployment.resolved_skills);
  if (unique.size !== deployment.resolved_skills.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolved_skills'],
      message: 'resolved_skills must not contain duplicates',
    });
  }
  const sorted = [...deployment.resolved_skills].sort();
  if (sorted.some((entry, index) => entry !== deployment.resolved_skills[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resolved_skills'],
      message: 'resolved_skills must be sorted for deterministic locks',
    });
  }
});

export const PortfolioMigrationExceptionSchema = z.object({
  skill: CanonicalSkillIdSchema,
  deployment: PortfolioPortableIdSchema,
  pinned_revision: GitRevisionSchema,
  reason: z.string().trim().min(1).max(500),
  owner: z.string().trim().min(1).max(120),
  expires_at: PortfolioDateSchema,
}).strict();

export const PortfolioLockSchema = z.object({
  version: z.literal(1),
  sources: z.record(PortfolioPortableIdSchema, PortfolioLockedSourceSchema),
  skills: z.record(CanonicalSkillIdSchema, PortfolioLockedSkillSchema),
  deployments: z.record(PortfolioPortableIdSchema, PortfolioLockedDeploymentSchema),
  exceptions: z.array(PortfolioMigrationExceptionSchema).default([]),
}).strict().superRefine((lock, ctx) => {
  rejectAbsoluteStrings(lock, ctx);
  const seen = new Set<string>();
  lock.exceptions.forEach((exception, index) => {
    const key = `${exception.deployment}\0${exception.skill}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exceptions', index],
        message: `duplicate migration exception for ${exception.deployment}/${exception.skill}`,
      });
    }
    seen.add(key);
  });
});
export type PortfolioLock = z.infer<typeof PortfolioLockSchema>;

export const ProjectBindingSchema = z.object({
  version: z.literal(1),
  portfolio: z.object({
    repository: z.string().trim().min(1),
    revision: GitRevisionSchema,
    deployment: PortfolioPortableIdSchema,
  }).strict(),
}).strict().superRefine((binding, ctx) => {
  rejectAbsoluteStrings(binding, ctx);
});
export type ProjectBinding = z.infer<typeof ProjectBindingSchema>;

export const PortfolioDeviceSchema = z.object({
  platform: z.enum(['darwin', 'linux', 'win32']),
  state_root: AbsoluteDevicePathSchema,
  source_roots: z.record(PortfolioPortableIdSchema, AbsoluteDevicePathSchema),
  project_roots: z.record(PortfolioPortableIdSchema, AbsoluteDevicePathSchema),
  backends: z.object({
    'managed-link': z.enum(['symlink', 'junction', 'copy']),
    'managed-materialized': z.enum(['materialize', 'copy']),
  }).strict(),
}).strict().superRefine((device, ctx) => {
  if (
    (device.platform === 'darwin' || device.platform === 'linux')
    && device.backends['managed-link'] !== 'symlink'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['backends', 'managed-link'],
      message: `${device.platform} managed-link deployments require symlink`,
    });
  }
  for (const [kind, roots] of [
    ['source_roots', device.source_roots],
    ['project_roots', device.project_roots],
  ] as const) {
    for (const [rootId, rootPath] of Object.entries(roots)) {
      if (
        isSameOrWithinAbsolute(rootPath, device.state_root)
        || isSameOrWithinAbsolute(device.state_root, rootPath)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['state_root'],
          message: `device-local state_root must not overlap ${kind}.${rootId}`,
        });
      }
    }
  }
});

export const PortfolioDeviceRegistrySchema = z.object({
  version: z.literal(1),
  devices: z.record(PortfolioPortableIdSchema, PortfolioDeviceSchema),
}).strict();
export type PortfolioDeviceRegistry = z.infer<typeof PortfolioDeviceRegistrySchema>;

export type PortfolioBackend = z.infer<typeof InstallBackendSchema>;
