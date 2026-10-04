import { access } from 'node:fs/promises';

const macOSChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function findBrowserExecutable(): Promise<string | undefined> {
  if (process.env.MAAT_BROWSER_EXECUTABLE_PATH) {
    return process.env.MAAT_BROWSER_EXECUTABLE_PATH;
  }

  if (process.platform === 'darwin') {
    try {
      await access(macOSChrome);
      return macOSChrome;
    } catch {
      // Let Playwright use its downloaded browser.
    }
  }

  return undefined;
}
