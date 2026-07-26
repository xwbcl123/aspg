/**
 * Shared canonical Skill identity rules.
 *
 * Lifecycle and Portfolio must classify project/device suffixes identically.
 */
export const FORBIDDEN_CANONICAL_SUFFIXES = [
  'life-os',
  'work-pkm',
  'mac-mini',
  'macbook-pro',
  'linux',
  'linux-server',
] as const;

export function forbiddenCanonicalSuffix(skillId: string): string | undefined {
  const basename = skillId.includes('/') ? skillId.split('/').at(-1)! : skillId;
  return FORBIDDEN_CANONICAL_SUFFIXES.find((suffix) =>
    basename.endsWith(`-${suffix}`));
}
