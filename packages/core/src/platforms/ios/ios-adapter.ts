import { AppiumPlatformAdapter } from '../appium/appium-adapter.ts';

export class IosPlatformAdapter extends AppiumPlatformAdapter {
  constructor() {
    super({ id: 'ios', label: 'iOS', platformName: 'iOS', automationName: 'XCUITest' });
  }
}
