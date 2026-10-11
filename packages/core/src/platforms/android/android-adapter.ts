import { AppiumPlatformAdapter } from '../appium/appium-adapter.ts';

export class AndroidPlatformAdapter extends AppiumPlatformAdapter {
  constructor() {
    super({
      id: 'android',
      label: 'Android',
      platformName: 'Android',
      automationName: 'UiAutomator2',
    });
  }
}
