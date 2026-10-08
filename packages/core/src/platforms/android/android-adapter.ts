import { AppiumPlatformAdapter } from '../appium/appium-adapter.ts';

export class AndroidPlatformAdapter extends AppiumPlatformAdapter {
  constructor(root: string) {
    super(
      { id: 'android', label: 'Android', platformName: 'Android', automationName: 'UiAutomator2' },
      root,
    );
  }
}
