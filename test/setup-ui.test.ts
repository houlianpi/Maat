import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { setupDoctor, setupPanel } from '../packages/pi/src/setup-ui.ts';
import { resolveSetupLocale } from '../packages/pi/src/setup-i18n.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

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
  assert.match(panel, /测试能力：部分可用/);
  assert.match(panel, /1\. 读取界面：尚未检测/);
  assert.match(panel, /2\. 操作应用和断言：正常/);
  assert.match(panel, /3\. 截图 Evidence：截图 Evidence 尚未开启/);
  assert.match(panel, /4\. 可选增强：Automation Mode、视频录制尚未配置（不影响测试）/);
  assert.match(panel, /下一步：开启截图权限/);
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

test('setup panel treats optional automation and video improvements as test-ready', () => {
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
  assert.match(panel, /测试能力：完全可用/);
  assert.match(panel, /1\. 读取界面：正常/);
  assert.match(panel, /2\. 操作应用和断言：正常/);
  assert.match(panel, /3\. 截图 Evidence：正常/);
  assert.match(panel, /4\. 可选增强：Automation Mode、视频录制尚未配置（不影响测试）/);
  assert.match(panel, /下一步：开始测试/);
  assert.doesNotMatch(panel, /查看设置方法/);
  const english = setupPanel(snapshot, 'en').join('\n');
  assert.match(english, /Test capability: Ready/);
  assert.match(english, /1\. Read the UI: Ready/);
  assert.match(
    english,
    /4\. Optional enhancements: Automation Mode, video recording not configured/,
  );
  assert.match(english, /Next: Start testing/);
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
