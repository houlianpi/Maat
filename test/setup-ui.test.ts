import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { setupDoctor, setupPanel } from '../packages/pi/src/setup-ui.ts';

test('setup panel uses user language and one next action without implementation jargon', () => {
  const snapshot = aggregateSetup({
    platform: 'macos',
    capabilities: [
      { id: 'uiInteraction', status: 'ready', required: true, summary: '可以操作应用并运行断言' },
      {
        id: 'screenCapture',
        status: 'action-required',
        required: false,
        summary: '截图 Evidence 尚未开启',
        action: { id: 'open-screen-recording', label: '开启截图权限', estimatedMinutes: 1 },
      },
      {
        id: 'videoRecording',
        status: 'unavailable',
        required: false,
        summary: '视频录制组件未安装',
      },
    ],
  });
  const panel = setupPanel(snapshot).join('\n');
  assert.match(panel, /测试能力：部分可用/);
  assert.match(panel, /下一步：开启截图权限/);
  assert.doesNotMatch(panel, /视频录制/);
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
      doctor: 'x'.repeat(3_000),
    },
  });
  const doctor = setupDoctor(snapshot);
  assert.match(doctor, /\[redacted\]/);
  assert.match(doctor, /wdaPath/);
  assert.doesNotMatch(doctor, /"secret"/);
  assert.match(doctor, /1000 characters omitted/);
  assert.ok(doctor.length < 3_000);
});
