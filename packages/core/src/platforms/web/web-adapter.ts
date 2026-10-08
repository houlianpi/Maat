import path from 'node:path';
import type { BrowserConfig } from './exploration-manager.ts';
import { WebExplorationManager } from './exploration-manager.ts';
import type { PlatformAdapter } from '../../core/platforms/contracts.ts';
import type { BrowserName } from './config.ts';
import { createWebTestSession } from './test-session.ts';

export class WebPlatformAdapter implements PlatformAdapter {
  readonly root: string;
  readonly id = 'web';
  readonly label = 'Web';
  readonly codeContext = {
    language: 'javascript' as const,
    globals: [
      { name: 'page', description: 'Playwright Page' },
      { name: 'context', description: 'Playwright BrowserContext' },
      { name: 'browser', description: 'Playwright Browser' },
      { name: 'expect', description: 'Playwright expect' },
      { name: 'display', description: 'Return screenshot Evidence' },
    ],
    guidelines: [
      'Use Playwright locators.',
      'Await every browser operation.',
      'Assert only explicit test objectives.',
    ],
  };
  readonly browser: WebExplorationManager;

  constructor(root = path.resolve('maat-tests/web'), browser?: WebExplorationManager) {
    this.root = root;
    this.browser = browser ?? new WebExplorationManager(root);
  }

  async initialize(): Promise<void> {
    this.browser.setConfigRoot(this.root);
  }
  configure(config: Record<string, unknown>) {
    return this.browser.configure({
      ...(typeof config.browser === 'string' ? { browser: config.browser as BrowserName } : {}),
      ...(typeof config.headless === 'boolean' ? { headless: config.headless } : {}),
      ...(typeof config.executablePath === 'string'
        ? { executablePath: config.executablePath }
        : {}),
      ...(typeof config.profileDirectory === 'string'
        ? { profileDirectory: config.profileDirectory }
        : {}),
      ...(typeof config.profile === 'string' ? { profile: config.profile } : {}),
      ...(typeof config.userDataDir === 'string' ? { userDataDir: config.userDataDir } : {}),
    });
  }
  get config() {
    return this.browser.currentConfig;
  }
  execute(code: string, signal?: AbortSignal) {
    return this.browser.execute(code, signal);
  }
  runtimeRequirement() {
    return {
      adapterId: this.id,
      setup: { browser: this.config.browser, headless: this.config.headless },
    };
  }
  createTestSession(requirement = this.runtimeRequirement()) {
    return createWebTestSession(requirement.setup);
  }
  status() {
    const config = this.config;
    return {
      id: this.id,
      label: this.label,
      root: this.root,
      session: this.browser.isRunning ? ('ready' as const) : ('idle' as const),
      detail: `${config.browser} · ${config.headless ? 'headless' : 'headed'}`,
    };
  }
  close() {
    return this.browser.close();
  }
}
