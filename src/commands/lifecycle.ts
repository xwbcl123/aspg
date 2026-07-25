import {
  lifecycleList,
  lifecycleRecommendations,
  lifecycleStatus,
  loadLifecycleRegistries,
  type LifecycleRegistrySnapshot,
} from '../lifecycle-registry.js';
import { PortableDateSchema } from '../lifecycle-schema.js';

export interface LifecycleCommandOptions {
  registry: string[];
  lifeosRoot?: string;
  asOf?: string;
  json?: boolean;
}

function hasErrors(snapshot: LifecycleRegistrySnapshot): boolean {
  return snapshot.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function emitDiagnostics(snapshot: LifecycleRegistrySnapshot): void {
  for (const diagnostic of snapshot.diagnostics) {
    const location = diagnostic.profile_path
      ? `${diagnostic.registry_root}/${diagnostic.profile_path}`
      : diagnostic.registry_root;
    const prefix = diagnostic.severity === 'error' ? '✗' : '⚠';
    const output = `${prefix} [${diagnostic.code}] ${location}: ${diagnostic.message}`;
    if (diagnostic.severity === 'error') console.error(output);
    else console.warn(output);
  }
}

function load(opts: LifecycleCommandOptions): LifecycleRegistrySnapshot {
  return loadLifecycleRegistries(opts.registry, { lifeosRoot: opts.lifeosRoot });
}

function effectiveAsOf(value: string | undefined): string | undefined {
  const effective = value ?? new Date().toISOString().slice(0, 10);
  const parsed = PortableDateSchema.safeParse(effective);
  if (!parsed.success) {
    console.error(`✗ --as-of: ${parsed.error.issues[0].message}`);
    process.exitCode = 2;
    return undefined;
  }
  return parsed.data;
}

export async function lifecycleValidateCommand(opts: LifecycleCommandOptions): Promise<void> {
  const snapshot = load(opts);
  const output = {
    schema_version: 1,
    valid: !hasErrors(snapshot),
    registry_roots: snapshot.registry_roots,
    evidence_resolution_mode: snapshot.evidence_resolution_mode,
    profiles: snapshot.skills.length,
    diagnostics: snapshot.diagnostics,
    evidence_resolution: snapshot.skills.map((dossier) => ({
      skill_id: dossier.skill_id,
      evidence: dossier.evidence_resolution,
    })),
    source_integrity: snapshot.skills.map((dossier) => ({
      skill_id: dossier.skill_id,
      source_ref: dossier.profile.source_ref,
      ...dossier.source_integrity,
    })),
    evidence_gaps: snapshot.skills
      .filter((dossier) => dossier.missing_evidence.length > 0)
      .map((dossier) => ({
        skill_id: dossier.skill_id,
        missing: dossier.missing_evidence,
      })),
    evidence_unverified: snapshot.skills
      .filter((dossier) => dossier.unverified_evidence.length > 0)
      .map((dossier) => ({
        skill_id: dossier.skill_id,
        unverified: dossier.unverified_evidence,
      })),
    writes_performed: 0,
  };
  if (opts.json) console.log(JSON.stringify(output, null, 2));
  else {
    emitDiagnostics(snapshot);
    console.log(`Lifecycle profiles: ${output.profiles}`);
    console.log(`Validation: ${output.valid ? 'valid' : 'invalid'}`);
    console.log(`Evidence gaps: ${output.evidence_gaps.length}`);
    console.log(`Evidence unverified: ${output.evidence_unverified.length}`);
    console.log('Writes performed: 0');
  }
  if (!output.valid) process.exitCode = 1;
}

export async function lifecycleListCommand(opts: LifecycleCommandOptions): Promise<void> {
  const snapshot = load(opts);
  const entries = lifecycleList(snapshot);
  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      evidence_resolution_mode: snapshot.evidence_resolution_mode,
      skills: entries,
      diagnostics: snapshot.diagnostics,
      writes_performed: 0,
    }, null, 2));
  } else {
    emitDiagnostics(snapshot);
    for (const entry of entries) {
      console.log(
        `${entry.skill_id}\t${entry.learning.current_level}→${entry.learning.target_level}`
        + `\t${entry.aggregate_adoption}\t${entry.freshness}`,
      );
    }
    console.log('Writes performed: 0');
  }
  if (hasErrors(snapshot)) process.exitCode = 1;
}

export async function lifecycleShowCommand(
  skillId: string,
  opts: LifecycleCommandOptions,
): Promise<void> {
  const snapshot = load(opts);
  const dossier = snapshot.skills.find((candidate) => candidate.skill_id === skillId);
  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      evidence_resolution_mode: snapshot.evidence_resolution_mode,
      skill: dossier ?? null,
      diagnostics: snapshot.diagnostics,
      writes_performed: 0,
    }, null, 2));
  } else {
    emitDiagnostics(snapshot);
    if (dossier) {
      console.log(`${dossier.skill_id} — ${dossier.profile.display_name}`);
      console.log(`Source: ${dossier.profile.source_ref} (${dossier.profile.owner_class})`);
      console.log(
        `Learning: ${dossier.profile.learning.current_level}`
        + ` → ${dossier.profile.learning.target_level}`,
      );
      console.log(`Aggregate adoption: ${dossier.aggregate_adoption}`);
      for (const scope of dossier.profile.adoption.scopes) {
        console.log(`- ${scope.project}: ${scope.stage} [${scope.devices.join(', ')}]`);
      }
      console.log(`Freshness: ${dossier.profile.freshness.status}`);
      console.log(`Missing evidence: ${dossier.missing_evidence.join(', ') || 'none'}`);
      console.log('Writes performed: 0');
    } else {
      console.error(`✗ lifecycle Skill not found: ${skillId}`);
    }
  }
  if (!dossier || hasErrors(snapshot)) process.exitCode = 1;
}

export async function lifecycleStatusCommand(opts: LifecycleCommandOptions): Promise<void> {
  const asOf = effectiveAsOf(opts.asOf);
  if (!asOf) return;
  const snapshot = load(opts);
  const status = lifecycleStatus(snapshot, asOf);
  if (opts.json) {
    console.log(JSON.stringify({
      ...status,
      diagnostics: snapshot.diagnostics,
    }, null, 2));
  }
  else {
    emitDiagnostics(snapshot);
    console.log(`Lifecycle Skills: ${status.total_skills}`);
    console.log(`Validation: ${status.valid ? 'valid' : 'invalid'}`);
    console.log(`Evidence gaps: ${status.evidence_gaps}`);
    console.log(`Learning: ${JSON.stringify(status.learning)}`);
    console.log(`Aggregate adoption: ${JSON.stringify(status.aggregate_adoption)}`);
    console.log(`Freshness: ${JSON.stringify(status.freshness)}`);
    console.log('Writes performed: 0');
  }
  if (hasErrors(snapshot)) process.exitCode = 1;
}

export async function lifecycleNextCommand(opts: LifecycleCommandOptions): Promise<void> {
  const asOf = effectiveAsOf(opts.asOf);
  if (!asOf) return;
  const snapshot = load(opts);
  const recommendations = lifecycleRecommendations(snapshot, asOf);
  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      as_of: asOf,
      evidence_resolution_mode: snapshot.evidence_resolution_mode,
      recommendations,
      diagnostics: snapshot.diagnostics,
      writes_performed: 0,
    }, null, 2));
  } else {
    emitDiagnostics(snapshot);
    if (recommendations.length === 0) console.log('No lifecycle action recommended.');
    for (const recommendation of recommendations) {
      console.log(
        `${recommendation.priority}. ${recommendation.skill_id}`
        + ` [${recommendation.code}] ${recommendation.action}`,
      );
      if (recommendation.missing_evidence.length > 0) {
        console.log(`   Missing: ${recommendation.missing_evidence.join(', ')}`);
      }
    }
    console.log('Writes performed: 0');
  }
  if (hasErrors(snapshot)) process.exitCode = 1;
}
