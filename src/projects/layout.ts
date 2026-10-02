import path from 'node:path';

export const platforms = ['web', 'android', 'ios', 'macos'] as const;
export type Platform = typeof platforms[number];

export function platformRoot(base: string, platform: string): string {
  if (!platforms.includes(platform as Platform)) throw new Error('Platform must be web, android, ios or macos.');
  return path.resolve(base, platform);
}

export function casePath(root: string, id: string, module?: string): string {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!slug.test(id) || (module !== undefined && !module.split('/').every(part => slug.test(part)))) {
    throw new Error('Case ID and module must be lowercase slugs; module may contain slash-separated segments.');
  }
  return path.join(root, 'cases', module ?? '', `${id}.spec.ts`);
}
