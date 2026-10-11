import path from 'node:path';
import { WebExplorationManager } from './exploration-manager.ts';
import type { PlatformAdapter } from '../../core/platforms/contracts.ts';
import type { BrowserName } from './config.ts';

export class WebPlatformAdapter implements PlatformAdapter {
  readonly configRoot: string;
  readonly id = 'web';
  readonly label = 'Web';
  readonly codeContext = {
    language: 'javascript' as const,
    globals: [
      { name: 'page', description: 'Playwright Page' },
      { name: 'context', description: 'Playwright BrowserContext' },
      { name: 'browser', description: 'Playwright Browser' },
      { name: 'expect', description: 'Playwright expect' },
      { name: 'display', description: 'Return a screenshot UI observation' },
      { name: 'evidence', description: 'Capture a screenshot UI observation with screenshot()' },
    ],
    guidelines: [
      'Use Playwright locators.',
      'Await every browser operation.',
      'Observe actual UI state; check only user-declared outcomes.',
    ],
  };
  readonly browser: WebExplorationManager;

  constructor(configRoot = path.resolve('maat-tests/web'), browser?: WebExplorationManager) {
    this.configRoot = configRoot;
    this.browser = browser ?? new WebExplorationManager(configRoot);
  }

  async initialize(): Promise<void> {
    this.browser.setConfigRoot(this.configRoot);
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
  status() {
    const config = this.config;
    return {
      id: this.id,
      label: this.label,
      session: this.browser.isRunning ? ('ready' as const) : ('idle' as const),
      detail: `${config.browser} · ${config.headless ? 'headless' : 'headed'}`,
    };
  }
  close() {
    return this.browser.close();
  }
}
