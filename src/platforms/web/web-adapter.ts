import path from 'node:path';
import type { BrowserConfig } from '../../browser/browser-manager.ts';
import { BrowserManager } from '../../browser/browser-manager.ts';
import type { PlatformAdapter } from '../contracts.ts';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { browserNames, type BrowserName } from '../../browser/browser-options.ts';
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
  readonly browser: BrowserManager;

  constructor(root = path.resolve('maat-tests/web'), browser?: BrowserManager) {
    this.root = root;
    this.browser = browser ?? new BrowserManager(root);
  }

  async initialize(): Promise<void> {
    this.browser.setConfigRoot(this.root);
  }
  tools() {
    return [
      defineTool({
        name: 'configure_browser',
        label: 'Configure Browser',
        description: 'Configure browser, headed mode, or logical profile for the Web adapter.',
        parameters: Type.Object({
          browser: Type.Optional(Type.Union(browserNames.map((name) => Type.Literal(name)))),
          headless: Type.Optional(Type.Boolean()),
          profile: Type.Optional(Type.String()),
        }),
        execute: async (_id, input) => {
          const result = await this.configure({
            ...(input.browser ? { browser: input.browser as BrowserName } : {}),
            ...(input.headless !== undefined ? { headless: input.headless } : {}),
            ...(input.profile !== undefined ? { profile: input.profile } : {}),
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      }),
      defineTool({
        name: 'get_browser_config',
        label: 'Get Browser Config',
        description: 'Return Web adapter browser configuration.',
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify(this.config) }],
          details: this.config,
        }),
      }),
    ];
  }
  configure(config: Partial<BrowserConfig>) {
    return this.browser.configure(config);
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
