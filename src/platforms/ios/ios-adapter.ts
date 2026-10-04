import { AppiumPlatformAdapter } from '../appium/appium-adapter.ts';

export class IosPlatformAdapter extends AppiumPlatformAdapter {
  constructor(root: string) {
    super({ id: 'ios', label: 'iOS', platformName: 'iOS', automationName: 'XCUITest' }, root);
  }
}
