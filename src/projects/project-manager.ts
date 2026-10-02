import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { BrowserManager } from '../browser/browser-manager.ts';
import { NativeManager } from '../native/manager.ts';
import { readNativeTarget, type NativeTarget } from '../native/config.ts';
import { platformRoot, casePath, type Platform } from './layout.ts';
import { scaffoldNativeFixture } from '../native/fixture.ts';
import { nativeSpec } from '../native/spec-generator.ts';
import { runNativeProject } from '../native/runner.ts';
import type { CaseDraft } from '../cases/types.ts';
import { validateAndSaveCase } from '../cases/case-store.ts';

export type { Platform } from './layout.ts';
export class ProjectManager {
  readonly native = new NativeManager();
  private active: { name: Platform; platform: Platform; root: string };
  private readonly base: string;
  constructor(base = path.resolve('maat-tests')) {
    this.base = base;
    this.active = { name: 'web', platform: 'web', root: platformRoot(base, 'web') };
  }
  get current() { return this.active; }
  async select(name: string, platform: Platform, browser: BrowserManager) {
    const root = platformRoot(this.base, platform);
    if (name !== platform) throw new Error(`Project name must equal platform (${platform}). Put business grouping in begin_case.module, not a new project directory.`);
    const existing = await readFile(path.join(root, 'wdio.conf.ts'), 'utf8').catch(() => undefined);
    if (platform === 'web' && existing) throw new Error('This project already uses WDIO.');
    if (platform !== 'web' && await readFile(path.join(root, 'playwright.config.ts')).then(() => true, () => false)) throw new Error('This project already uses Playwright.');
    await browser.close(); await this.native.close();
    if (platform === 'web') {
      this.active = { name: platform, platform, root };
      browser.setConfigRoot(root);
    } else {
      const targetFile = path.join(root, 'native-target.local.json');
      let target: NativeTarget;
      try { target = await readNativeTarget(targetFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        target = { platform, capabilities: {} };
      }
      if (target.platform !== platform) throw new Error('Project platform conflicts with its target configuration.');
      await this.native.configure(target);
      this.active = { name: platform, platform, root };
      await this.scaffold();
    }
    return this.active;
  }
  async configure(target: NativeTarget) {
    if (target.platform !== this.active.platform) throw new Error('Select the matching native project first.');
    await this.native.configure(target);
    await this.scaffold();
    await writeFile(path.join(this.active.root, 'native-target.local.json'), JSON.stringify(target, null, 2) + '\n', { mode: 0o600 });
  }
  private async scaffold() {
    const root = this.active.root;
    await mkdir(path.join(root, 'cases'), { recursive: true });
    const implementation = fileURLToPath(new URL('../native/wdio-config.ts', import.meta.url));
    let importPath = path.relative(root, implementation).split(path.sep).join('/');
    if (!importPath.startsWith('.')) importPath = './' + importPath;
    const source = `import { createNativeConfig } from ${JSON.stringify(importPath)};
import { fileURLToPath } from 'node:url';
export const config = await createNativeConfig(fileURLToPath(new URL('.', import.meta.url)));
`;
    await writeFile(path.join(root, 'wdio.conf.ts'), source, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await scaffoldNativeFixture(root);
  }
  async save(draft: CaseDraft, browser: BrowserManager, signal?: AbortSignal) {
    if (draft.rootDirectory !== this.active.root) throw new Error('Draft belongs to a different project.');
    const final = casePath(this.active.root, draft.id, draft.module);
    if (this.active.platform === 'web') return validateAndSaveCase(draft, browser);
    if (!draft.steps.length) throw new Error('No native steps to save.');
    const target = this.native.currentTarget;
    if (!target) throw new Error('Configure a native target first.');
    // Discovery resolves once; persist device choice only in ignored local target config.
    const { selectDevice } = await import('../native/devices.ts');
    await this.configure(await selectDevice(target));
    await this.native.close();
    const directory = path.dirname(final);
    await mkdir(directory, { recursive: true });
    const candidate = path.join(directory, `.validate-${randomUUID()}.spec.ts`);
    await writeFile(candidate, nativeSpec(draft));
    try {
      const code = await runNativeProject(this.active.root, { mode: 'all' }, candidate, signal);
      if (code !== 0) throw new Error('WDIO validation failed; no formal Case saved.');
      await rename(candidate, final);
    } finally { await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { caseDirectory: directory, testPath: final };
  }
}
