import { AppiumPlatformAdapter } from '../appium/appium-adapter.ts';

export class MacosPlatformAdapter extends AppiumPlatformAdapter {
  constructor() {
    super({ id: 'macos', label: 'macOS', platformName: 'Mac', automationName: 'Mac2' });
  }
}
