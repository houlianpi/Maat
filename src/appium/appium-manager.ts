import { AppiumClient } from "./appium-client.ts";
import { launchAppiumServer, type AppiumServerHandle } from "./appium-server.ts";
import {
  defaultCapabilities,
  type AppiumCapabilities,
  type AppiumConfig,
  type AppiumPlatform,
  type AppiumSessionInfo,
} from "./types.ts";

export class AppiumManager {
  private config: AppiumConfig = {
    platform: "macos",
    capabilities: defaultCapabilities("macos"),
  };
  private server: AppiumServerHandle | undefined;
  private client: AppiumClient | undefined;
  private session: AppiumSessionInfo | undefined;

  get currentConfig(): Readonly<AppiumConfig> {
    return this.config;
  }

  get currentSession(): Readonly<AppiumSessionInfo> | undefined {
    return this.session;
  }

  get isRunning(): boolean {
    return this.session !== undefined;
  }

  async configure(input: {
    platform?: AppiumPlatform;
    serverUrl?: string;
    capabilities?: AppiumCapabilities;
  }): Promise<AppiumConfig> {
    await this.close();
    const platform = input.platform ?? this.config.platform;
    this.config = {
      platform,
      ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
      capabilities: {
        ...defaultCapabilities(platform),
        ...(input.capabilities ?? {}),
      },
    };
    return this.config;
  }

  async start(): Promise<AppiumSessionInfo> {
    if (this.session) return this.session;
    if (!this.config.serverUrl) this.server = await launchAppiumServer();
    const url = this.config.serverUrl ?? this.server!.url;
    this.client = new AppiumClient(url);
    try {
      this.session = await this.client.createSession(this.config.capabilities);
      return this.session;
    } catch (error) {
      await this.server?.close();
      this.server = undefined;
      this.client = undefined;
      throw error;
    }
  }

  async find(using: string, value: string): Promise<string> {
    return (await this.getClient()).findElement(using, value);
  }

  async click(elementId: string): Promise<void> {
    await (await this.getClient()).click(elementId);
  }

  async clear(elementId: string): Promise<void> {
    await (await this.getClient()).clear(elementId);
  }

  async setValue(elementId: string, text: string): Promise<void> {
    await (await this.getClient()).setValue(elementId, text);
  }

  async getText(elementId: string): Promise<string> {
    return (await this.getClient()).getText(elementId);
  }

  async getAttribute(elementId: string, name: string): Promise<unknown> {
    return (await this.getClient()).getAttribute(elementId, name);
  }

  async isDisplayed(elementId: string): Promise<boolean> {
    return (await this.getClient()).isDisplayed(elementId);
  }

  async source(): Promise<string> {
    return (await this.getClient()).getPageSource();
  }

  async screenshot(): Promise<string> {
    return (await this.getClient()).takeScreenshot();
  }

  async tap(x: number, y: number): Promise<void> {
    await (await this.getClient()).tap(x, y);
  }

  async close(): Promise<void> {
    const client = this.client;
    const server = this.server;
    this.client = undefined;
    this.session = undefined;
    this.server = undefined;
    try {
      await client?.deleteSession();
    } finally {
      await server?.close();
    }
  }

  private async getClient(): Promise<AppiumClient> {
    await this.start();
    return this.client!;
  }
}
