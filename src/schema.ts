/**
 * schema.ts — Zod schema for SKILL.md frontmatter contract
 */
import { z } from 'zod';

export const AspgRequirementsSchema = z.object({
  tools: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
});

export const AspgOriginSchema = z.object({
  vendor: z.string(),
  imported_at: z.string(),
  source_version: z.string().optional(),
});

export const AspgNamespaceSchema = z.object({
  requirements: AspgRequirementsSchema.optional(),
  origin: AspgOriginSchema.optional(),
});

export const SkillFrontmatterSchema = z.object({
  name: z.string({ required_error: 'SKILL.md must have a "name" field' }),
  description: z.string({ required_error: 'SKILL.md must have a "description" field' }),
  version: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
  aspg: AspgNamespaceSchema.optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
export type AspgOrigin = z.infer<typeof AspgOriginSchema>;

/** Vendor-specific root-level fields to strip during import */
export const VENDOR_FIELD_PATTERNS = [
  /^claude[_-]/i,
  /^gemini[_-]/i,
  /^codex[_-]/i,
  /^openai[_-]/i,
  /^model[_-]config$/i,
];

/** Standard fields to preserve during import */
export const STANDARD_FIELDS = new Set([
  'name',
  'description',
  'version',
  'author',
  'license',
  'tags',
  'aspg',
]);

/**
 * Check if a root-level field is vendor-specific (should be stripped).
 */
export function isVendorField(key: string): boolean {
  return VENDOR_FIELD_PATTERNS.some((p) => p.test(key));
}
