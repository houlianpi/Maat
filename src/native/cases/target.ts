import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { NativeAppTarget } from '../environment/schema.ts';

const appKeys = ['appium:bundleId', 'appium:appPackage', 'appium:appActivity', 'appium:app'] as const;
type AppKey = typeof appKeys[number];
export type CaseAppTarget = NativeAppTarget;

export function caseAppTarget(capabilities: Record<string, unknown>): CaseAppTarget {
  return Object.fromEntries(appKeys.flatMap(key => {
    const value = capabilities[key];
    return typeof value === 'string' && value.trim() ? [[key, value]] : [];
  })) as CaseAppTarget;
}

export function caseTargetComment(target: CaseAppTarget): string {
  return ` * @maat-target ${JSON.stringify(target)}\n`;
}

export function parseCaseAppTarget(source: string): CaseAppTarget | undefined {
  const header = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1];
  const match = header && /^\s*\*\s*@maat-target (.+)$/m.exec(header);
  if (!match) return undefined;
  const value: unknown = JSON.parse(match[1]!);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, entry]) => !appKeys.includes(key as AppKey) || typeof entry !== 'string' || !entry.trim())) {
    throw new Error('Invalid @maat-target in native Case. Expected an object of app capabilities.');
  }
  return value as CaseAppTarget;
}

export async function readCaseAppTarget(spec: string): Promise<CaseAppTarget> {
  const filename = spec.startsWith('file:') ? fileURLToPath(spec) : spec;
  const target = parseCaseAppTarget(await readFile(filename, 'utf8'));
  if (!target) throw new Error(`Native Case has no @maat-target: ${spec}. Revalidate and save the Case first.`);
  return target;
}

export function applyCaseAppTarget(capabilities: Record<string, unknown>, target: CaseAppTarget): void {
  const nested = ['alwaysMatch', 'capabilities'].flatMap(key => capabilities[key] && typeof capabilities[key] === 'object' ? [capabilities[key] as Record<string, unknown>] : []);
  const records = [capabilities, ...nested];
  for (const desired of records) {
    for (const key of appKeys) delete desired[key];
    Object.assign(desired, target);
  }
}
