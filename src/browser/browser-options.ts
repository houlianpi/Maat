export const browserNames = ['chromium', 'chrome', 'chrome-beta', 'edge', 'edge-beta'] as const;

export type BrowserName = (typeof browserNames)[number];

const browserChannels: Record<BrowserName, string | undefined> = {
  chromium: undefined,
  chrome: 'chrome',
  'chrome-beta': 'chrome-beta',
  edge: 'msedge',
  'edge-beta': 'msedge-beta',
};

export function parseBrowserName(value: string): BrowserName {
  if (browserNames.includes(value as BrowserName)) return value as BrowserName;
  throw new Error(`Unsupported browser "${value}". Choose: ${browserNames.join(', ')}.`);
}

export function browserChannel(browser: BrowserName): string | undefined {
  return browserChannels[browser];
}
