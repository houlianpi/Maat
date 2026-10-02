import type {
  AppiumCapabilities,
  AppiumSessionInfo,
} from "./types.ts";

const elementKey = "element-6066-11e4-a52e-4f735466cecf";

type AppiumResponse = {
  value?: unknown;
  sessionId?: string;
};

export class AppiumProtocolError extends Error {
  readonly status: number;
  readonly value: unknown;

  constructor(
    message: string,
    status: number,
    value: unknown,
  ) {
    super(message);
    this.name = "AppiumProtocolError";
    this.status = status;
    this.value = value;
  }
}

export class AppiumClient {
  private readonly baseUrl: string;
  private sessionId: string | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  async status(): Promise<unknown> {
    return this.request("GET", "/status");
  }

  async createSession(
    capabilities: AppiumCapabilities,
  ): Promise<AppiumSessionInfo> {
    const value = await this.request("POST", "/session", {
      capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
    });
    if (!isRecord(value) || typeof value.sessionId !== "string") {
      throw new Error("Appium returned an invalid new-session response.");
    }
    this.sessionId = value.sessionId;
    return {
      sessionId: value.sessionId,
      capabilities: isRecord(value.capabilities) ? value.capabilities : {},
    };
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.sessionId = undefined;
    await this.request("DELETE", `/session/${encodeURIComponent(id)}`);
  }

  async findElement(using: string, value: string): Promise<string> {
    const result = await this.sessionRequest("POST", "/element", {
      using,
      value,
    });
    if (!isRecord(result)) throw new Error("Appium returned an invalid element.");
    const id = result[elementKey] ?? result.ELEMENT;
    if (typeof id !== "string") {
      throw new Error("Appium element response has no element id.");
    }
    return id;
  }

  async click(elementId: string): Promise<void> {
    await this.elementRequest(elementId, "POST", "/click", {});
  }

  async clear(elementId: string): Promise<void> {
    await this.elementRequest(elementId, "POST", "/clear", {});
  }

  async setValue(elementId: string, text: string): Promise<void> {
    await this.elementRequest(elementId, "POST", "/value", {
      text,
      value: [...text],
    });
  }

  async getText(elementId: string): Promise<string> {
    const value = await this.elementRequest(elementId, "GET", "/text");
    return String(value ?? "");
  }

  async getAttribute(elementId: string, name: string): Promise<unknown> {
    return this.elementRequest(
      elementId,
      "GET",
      `/attribute/${encodeURIComponent(name)}`,
    );
  }

  async isDisplayed(elementId: string): Promise<boolean> {
    return Boolean(await this.elementRequest(elementId, "GET", "/displayed"));
  }

  async getPageSource(): Promise<string> {
    return String(await this.sessionRequest("GET", "/source"));
  }

  async takeScreenshot(): Promise<string> {
    const value = await this.sessionRequest("GET", "/screenshot");
    if (typeof value !== "string") {
      throw new Error("Appium returned an invalid screenshot.");
    }
    return value;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.sessionRequest("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x, y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 100 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  }

  private async elementRequest(
    elementId: string,
    method: string,
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    return this.sessionRequest(
      method,
      `/element/${encodeURIComponent(elementId)}${suffix}`,
      body,
    );
  }

  private async sessionRequest(
    method: string,
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!this.sessionId) throw new Error("No active Appium session.");
    return this.request(
      method,
      `/session/${encodeURIComponent(this.sessionId)}${suffix}`,
      body,
    );
  }

  private async request(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json().catch(() => ({}))) as AppiumResponse;
    if (!response.ok) {
      const nested = isRecord(payload.value) ? payload.value : undefined;
      const message =
        (nested && typeof nested.message === "string" && nested.message) ||
        `Appium request failed with HTTP ${response.status}.`;
      throw new AppiumProtocolError(message, response.status, payload.value);
    }
    return payload.value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
