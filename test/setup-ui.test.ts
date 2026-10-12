import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { setupAgentContext, setupDoctor, setupPanel } from '../packages/pi/src/setup-ui.ts';
import { resolveSetupLocale } from '../packages/pi/src/setup-i18n.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

test('setup context preserves Android SDK/ADB and mobile driver install commands', () => {
  for (const [platform, id, labelKey, expected] of [
    ['android', 'install-adb', 'action.installAdb', /android-tools\.mjs.*prepare/],
    [
      'android',
      'configure-android-sdk',
      'action.configureAndroidSdk',
      /android-tools\.mjs.*prepare/,
    ],
    ['android', 'start-adb', 'action.startAdb', /android-tools\.mjs.*adb/],
    ['android', 'install-appium', 'action.installAppium', /npm install --global appium@3\.7\.0/],
    [
      'android',
      'install-uiautomator2',
      'action.installUiAutomator2',
      /appium driver install uiautomator2@8\.7\.0/,
    ],
    ['ios', 'install-appium', 'action.installAppium', /npm install --global appium@3\.7\.0/],
    [
      'ios',
      'install-xcuitest',
      'action.installXcuitest',
      /appium driver install xcuitest@12\.13\.2/,
    ],
  ] as const) {
    const snapshot = aggregateSetup({
      platform,
      capabilities: [
        {
          id: 'appiumServer',
          status: 'action-required',
          required: true,
          messageKey: 'capability.appium.start',
          action: { id, labelKey },
        },
      ],
    });
    assert.match(setupAgentContext(snapshot), expected);
    assert.match(setupAgentContext(snapshot, 'en', { prepareAvailable: true }), expected);
  }
});

test('mobile doctor drops only foreground startup commands, retaining installation diagnostics', () => {
  const snapshot = aggregateSetup({
    platform: 'ios',
    capabilities: [
      {
        id: 'appiumServer',
        status: 'action-required',
        required: true,
        messageKey: 'capability.appium.start',
        action: {
          id: 'start-appium',
          labelKey: 'action.startAppium',
          command: 'appium --address 127.0.0.1 --port 4723',
        },
      },
      {
        id: 'xcuitestDriver',
        status: 'action-required',
        required: true,
        messageKey: 'capability.xcuitest.install',
        action: {
          id: 'install-xcuitest',
          labelKey: 'action.installXcuitest',
          command: 'appium driver install xcuitest@12.13.2',
        },
      },
    ],
  });
  assert.doesNotMatch(setupDoctor(snapshot), /appium --address/);
  assert.match(setupDoctor(snapshot), /appium driver install xcuitest@12\.13\.2/);
});

test('setup panel uses user language and one next action without implementation jargon', () => {
  const snapshot = aggregateSetup({
    platform: 'macos',
    capabilities: [
      {
        id: 'uiInteraction',
        status: 'ready',
        required: true,
        messageKey: 'capability.interaction.ready',
      },
      {
        id: 'screenCapture',
        status: 'action-required',
        required: false,
        messageKey: 'capability.screenshot.required',
        action: {
          id: 'open-screen-recording',
          labelKey: 'action.openScreenRecording',
          estimatedMinutes: 1,
        },
      },
      {
        id: 'videoRecording',
        status: 'unavailable',
        required: false,
        messageKey: 'capability.video.unavailable',
      },
    ],
  });
  const panel = setupPanel(snapshot, 'zh-CN').join('\n');
  assert.match(panel, /操作能力：部分可用/);
  assert.match(panel, /1\. 读取界面：尚未检测/);
  assert.match(panel, /2\. 操作应用：正常/);
  assert.match(panel, /3\. 截图观察：截图能力尚未开启/);
  assert.match(panel, /4\. 可选增强：Automation Mode、视频录制尚未配置/);
  assert.match(panel, /下一步：读取当前界面后继续任务/);
  assert.doesNotMatch(panel, /WebDriverAgent|TCC|capability/);
});

test('setup doctor exposes technical details while redacting secret-shaped fields', () => {
  const snapshot = aggregateSetup({
    platform: 'macos',
    capabilities: [],
    technicalDetails: {
      token: 'secret',
      wdaPath: '/tmp/WDA',
      prompt: 'not included',
      doctor:
        'Diagnostic completed, 0 required fixes needed, 2 optional fixes possible.\nWARN Doctor ✖ Automation Mode requires user authentication\nWARN Doctor ✖ ffmpeg cannot be found\n' +
        'x'.repeat(3_000),
    },
  });
  const doctor = setupDoctor(snapshot, 'zh-CN');
  assert.match(doctor, /\[redacted\]/);
  assert.match(doctor, /wdaPath/);
  assert.doesNotMatch(doctor, /secret|not included/);
  assert.match(doctor, /doctor.requiredFixes: 0/);
  assert.match(doctor, /doctor.optionalFixes: 2/);
  assert.match(doctor, /doctor.warning: Automation Mode requires user authentication/);
  assert.ok(doctor.length < 2_000);
  assert.doesNotMatch(doctor, /^\s*[{[]/);
  assert.match(doctor, /Maat · macOS 工程诊断/);
  assert.match(doctor, /进程、版本与检测依据/);
});

test('setup panel agrees with partial readiness when optional capabilities are unavailable', () => {
  const snapshot = aggregateSetup({
    platform: 'macos',
    capabilities: [
      {
        id: 'accessibility',
        status: 'ready',
        required: true,
        messageKey: 'capability.accessibility.ready',
      },
      {
        id: 'uiInteraction',
        status: 'ready',
        required: true,
        messageKey: 'capability.interaction.ready',
      },
      {
        id: 'screenCapture',
        status: 'ready',
        required: false,
        messageKey: 'capability.screenshot.ready',
      },
      {
        id: 'automationMode',
        status: 'action-required',
        required: false,
        messageKey: 'capability.automation.auth',
        action: { id: 'authenticate-automation-mode', labelKey: 'action.automationMode' },
      },
      {
        id: 'videoRecording',
        status: 'unavailable',
        required: false,
        messageKey: 'capability.video.unavailable',
      },
    ],
  });
  const panel = setupPanel(snapshot, 'zh-CN').join('\n');
  assert.match(panel, /操作能力：部分可用/);
  assert.match(panel, /1\. 读取界面：正常/);
  assert.match(panel, /2\. 操作应用：正常/);
  assert.match(panel, /3\. 截图观察：正常/);
  assert.match(panel, /4\. 可选增强：Automation Mode、视频录制尚未配置/);
  assert.match(panel, /下一步：读取当前界面后继续任务/);
  assert.doesNotMatch(panel, /查看设置方法/);
  const english = setupPanel(snapshot, 'en').join('\n');
  assert.match(english, /Execution capability: Partially ready/);
  assert.match(english, /1\. Read the UI: Ready/);
  assert.match(
    english,
    /4\. Optional enhancements: Automation Mode, video recording not configured/,
  );
  assert.match(english, /Next: Read the current UI and continue/);
  assert.doesNotMatch(english, /[测试正常尚未配置]/);
});

test('setup locale follows explicit override, recent user language, then system fallback', () => {
  const context = (content: string) =>
    ({
      sessionManager: {
        getEntries: () => [
          {
            type: 'message',
            message: { role: 'user', content, timestamp: Date.now() },
          },
        ],
      },
    }) as unknown as ExtensionContext;
  assert.equal(resolveSetupLocale(undefined, context('请检查环境')), 'zh-CN');
  assert.equal(resolveSetupLocale(undefined, context('Check the environment')), 'en');
  assert.equal(resolveSetupLocale('en', context('请检查环境')), 'en');
  assert.equal(resolveSetupLocale('中文', context('Check it')), 'zh-CN');
});

test('Android unknown or blocked preparation never suggests starting a test', () => {
  const unknown = aggregateSetup({ platform: 'android', capabilities: [], state: 'unknown' });
  const panel = setupPanel(unknown, 'zh-CN').join('\n');
  assert.match(panel, /尚未检查准备条件/);
  assert.match(panel, /检查环境，确认具体缺项/);
  assert.doesNotMatch(panel, /开始测试|完全可用|macOS/);
  const ready = aggregateSetup({
    platform: 'android',
    capabilities: [
      {
        id: 'appiumServer',
        status: 'ready',
        required: true,
        messageKey: 'capability.appium.ready',
      },
    ],
  });

  assert.match(setupPanel(ready, 'zh-CN').join('\n'), /手机操作通道尚需确认/);
  assert.match(setupDoctor(ready, 'en'), /does not create a phone Session/);
});

test('iOS preparation reports its own next actions and never substitutes Android startup tooling', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    for (const [id, messageKey, actionId, labelKey] of [
      ['iosDevice', 'capability.iosDevice.trust', 'trust-ios-device', 'action.trustIosDevice'],
      [
        'iosDeveloperMode',
        'capability.iosDeveloperMode.required',
        'enable-ios-developer-mode',
        'action.enableIosDeveloperMode',
      ],
      [
        'xcuitestDriver',
        'capability.xcuitest.install',
        'install-xcuitest',
        'action.installXcuitest',
      ],
      ['appiumServer', 'capability.appium.start', 'start-appium', 'action.startAppium'],
    ] as const) {
      const snapshot = aggregateSetup({
        platform: 'ios',
        capabilities: [
          {
            id,
            messageKey,
            required: true,
            status: 'action-required',
            action: { id: actionId, labelKey },
          },
        ],
      });
      const facts = setupAgentContext(snapshot, locale);
      assert.match(facts, new RegExp(actionId));
      assert.match(setupPanel(snapshot, locale).join('\n'), /Maat · iOS/);
      assert.doesNotMatch(facts, /android-tools\.mjs|uiautomator2@|SDK paths/);
      if (actionId === 'start-appium') assert.doesNotMatch(facts, /"command":/);
    }
    const ready = aggregateSetup({
      platform: 'ios',
      capabilities: [
        {
          id: 'iosDevice',
          messageKey: 'capability.iosDevice.ready',
          required: true,
          status: 'ready',
        },
      ],
    });
    assert.match(setupAgentContext(ready, locale), /"tool":"check_device_ready"/);
    assert.match(
      setupAgentContext(ready, locale),
      /IOS_DEVICE_LOCK_STATE_UNKNOWN|allowWdaInitialization/,
    );
    assert.match(setupDoctor(ready, locale), /does not create|不会创建/);
    assert.match(setupPanel(ready, locale).join('\n'), /尚需确认|verify the phone control/);
  }
});
