import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativeFixtureSource(root: string): string {
  const implementation = fileURLToPath(new URL('../execution/evidence.ts', import.meta.url));
  let relative = path.relative(path.join(root, 'fixtures'), implementation).split(path.sep).join('/');
  if (!relative.startsWith('.')) relative = './' + relative;
  return `// Shared native test fixture. Evidence lifecycle is owned by wdio.conf.ts.
export { browser as driver, browser, expect } from '@wdio/globals';
export { describe, it } from 'mocha';
export { display, evidence } from ${JSON.stringify(relative)};
`;
}

export async function scaffoldNativeFixture(root: string) {
  await mkdir(path.join(root, 'fixtures'), { recursive: true });
  await writeFile(path.join(root, 'fixtures/maat-test.ts'), nativeFixtureSource(root), { flag: 'wx' })
    .catch(error => { if (error.code !== 'EEXIST') throw error; });
}
