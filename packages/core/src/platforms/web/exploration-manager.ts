import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { browserChannel, type BrowserName } from './config.ts';
import type { JavaScriptSession } from '../../core/exploration/runtime.ts';
import { createWebExplorationSession } from './exploration-session.ts';

export type BrowserProfile = {
  browser: BrowserName;
  userDataDir: string;
  profileDirectory?: string;
};

export type BrowserConfig = {
  browser: BrowserName;
  headless: boolean;
  executablePath?: string;
  profileDirectory?: string;
  profile?: string;
  userDataDir?: string;
};

type MaatConfig = { profiles?: Record<string, BrowserProfile> };

export class WebExplorationManager implements JavaScriptSession {
  private configRoot: string;
  private session: JavaScriptSession | undefined;
  private config: BrowserConfig = { browser: 'chrome', headless: true };

  constructor(configRoot = path.resolve('maat-tests/web')) {
    this.configRoot = configRoot;
  }

  setConfigRoot(root: string): void {
    this.configRoot = root;
  }

  get currentConfig(): Readonly<BrowserConfig> {
    return this.config;
  }

  get isRunning(): boolean {
    return this.session !== undefined;
  }

  async configure(next: Partial<BrowserConfig>): Promise<BrowserConfig> {
    await this.close();
    this.config = { ...this.config, ...next };
    if (next.profile === '') this.config.profile = undefined;
    return this.config;
  }

  async execute(code: string, signal?: AbortSignal) {
    const session = await this.getSession();
    return session.execute(code, signal);
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    await session?.close();
  }

  async createValidationSession(): Promise<JavaScriptSession> {
    return this.launch();
  }

  private async getSession(): Promise<JavaScriptSession> {
    this.session ??= await this.launch();
    return this.session;
  }

  private async readProfile(): Promise<BrowserProfile | undefined> {
    if (!this.config.profile) return undefined;
    const configPath = path.join(this.configRoot, 'maat.config.json');
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as MaatConfig;
    const profile = parsed.profiles?.[this.config.profile];
    if (!profile) {
      throw new Error(`Unknown browser profile "${this.config.profile}" in ${configPath}.`);
    }
    return profile;
  }

  private async launch(): Promise<JavaScriptSession> {
    const profile = await this.readProfile();
    const browser = profile?.browser ?? this.config.browser;
    return createWebExplorationSession({
      channel: browserChannel(browser),
      executablePath: this.config.executablePath,
      headless: this.config.headless,
      profileDirectory: profile?.profileDirectory ?? this.config.profileDirectory,
      userDataDir: profile?.userDataDir ?? this.config.userDataDir,
    });
  }
}
