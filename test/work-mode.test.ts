import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkModePolicy } from '../src/tui/work-mode.ts';

test('assistance permits shell and file edits', () => {
  const policy = new WorkModePolicy();
  for (const tool of ['bash', 'edit', 'write', 'read']) assert.equal(policy.beforeTool(tool), undefined);
  assert.equal(policy.userBash(), undefined);
});

test('exploration is guarded even before begin_case', () => {
  for (const entry of ['exec_js', 'exec_native', 'begin_case', 'save_case']) {
    const policy = new WorkModePolicy();
    assert.equal(policy.beforeTool(entry), undefined);
    for (const tool of ['bash', 'powershell', 'edit', 'write']) assert.match(policy.beforeTool(tool)!, /disabled/);
    for (const tool of ['read', 'grep', 'find', 'ls', 'exec_js', 'exec_native', 'save_case']) assert.equal(policy.beforeTool(tool), undefined);
    assert.equal(policy.userBash()?.result.exitCode, 1);
  }
});

test('failure and project switches retain guard; successful save restores assistance', () => {
  const policy = new WorkModePolicy();
  policy.beforeTool('begin_case');
  policy.afterTool('save_case', true);
  policy.beforeTool('select_project');
  assert.equal(policy.mode, 'case');
  policy.afterTool('get_case_status', false);
  assert.equal(policy.mode, 'case');
  policy.afterTool('save_case', false);
  assert.equal(policy.mode, 'assist');
  assert.equal(policy.beforeTool('bash'), undefined);
  policy.beforeTool('exec_native');
  assert.equal(policy.mode, 'case');
});
