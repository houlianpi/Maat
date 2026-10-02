import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

export type BrowserRuntimeOptions = {
  executablePath?: string;
  headless?: boolean;
};

export class BrowserRuntime {
  private readonly options: BrowserRuntimeOptions;
  private activeBrowser: Browser | undefined;
  private activeContext: BrowserContext | undefined;
  private activePage: Page | undefined;
  private starting: Promise<Page> | undefined;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.options = options;
  }

  get isStarted(): boolean {
    return this.activePage !== undefined;
  }

  get page(): Page {
    if (!this.activePage) {
      throw new Error("BrowserRuntime has not been started.");
    }
    return this.activePage;
  }

  get browser(): Browser {
    if (!this.activeBrowser) {
      throw new Error("BrowserRuntime has not been started.");
    }
    return this.activeBrowser;
  }

  get context(): BrowserContext {
    if (!this.activeContext) {
      throw new Error("BrowserRuntime has not been started.");
    }
    return this.activeContext;
  }

  async start(): Promise<Page> {
    if (this.activePage) return this.activePage;
    if (this.starting) return this.starting;

    this.starting = this.launch();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async launch(): Promise<Page> {
    try {
      this.activeBrowser = await chromium.launch({
        executablePath: this.options.executablePath,
        headless: this.options.headless ?? true,
      });
      this.activeContext = await this.activeBrowser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      this.activePage = await this.activeContext.newPage();
      return this.activePage;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const context = this.activeContext;
    const browser = this.activeBrowser;

    this.activePage = undefined;
    this.activeContext = undefined;
    this.activeBrowser = undefined;

    try {
      await context?.close();
    } finally {
      await browser?.close();
    }
  }
}
