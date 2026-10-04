import path from 'node:path';

export function adapterRoot(base: string, adapterId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapterId)) {
    throw new Error('Adapter ID must be a lowercase slug.');
  }
  return path.resolve(base, adapterId);
}

export function casePath(root: string, id: string, module?: string): string {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (
    !slug.test(id) ||
    (module !== undefined && !module.split('/').every((part) => slug.test(part)))
  ) {
    throw new Error(
      'Case ID and module must be lowercase slugs; module may contain slash-separated segments.',
    );
  }
  return path.join(root, 'cases', module ?? '', `${id}.spec.ts`);
}
