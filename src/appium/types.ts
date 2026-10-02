export const appiumPlatforms = ["android", "ios", "macos"] as const;

export type AppiumPlatform = (typeof appiumPlatforms)[number];

export type AppiumCapabilities = Record<string, unknown>;

export type AppiumConfig = {
  platform: AppiumPlatform;
  serverUrl?: string;
  capabilities: AppiumCapabilities;
};

export type AppiumSessionInfo = {
  sessionId: string;
  capabilities: AppiumCapabilities;
};

export function defaultCapabilities(
  platform: AppiumPlatform,
): AppiumCapabilities {
  switch (platform) {
    case "android":
      return {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:deviceName": "Android",
      };
    case "ios":
      return {
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": "iPhone Simulator",
      };
    case "macos":
      return {
        platformName: "Mac",
        "appium:automationName": "Mac2",
      };
  }
}
