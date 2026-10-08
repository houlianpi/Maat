import assert from 'node:assert/strict';
import test from 'node:test';

import { CaseDraftManager } from '../packages/core/src/core/cases/draft-manager.ts';
import { maatStatusLines } from '../packages/pi/src/status.ts';
import {
  createMaatResourceOptions,
  createMaatSettings,
} from '../packages/maat/src/hosts/tui/runtime-config.ts';

test('Maat isolates Pi resources while copying initial model preferences', () => {
  const settings = createMaatSettings({
    defaultProvider: 'github-copilot',
    defaultModel: 'gpt-test',
    defaultThinkingLevel: 'medium',
    theme: 'dark',
    extensions: ['foreign-extension'],
    skills: ['foreign-skill'],
  });
  const resources = createMaatResourceOptions([]);

  assert.equal(settings.defaultProvider, 'github-copilot');
  assert.equal(settings.defaultModel, 'gpt-test');
  assert.deepEqual(settings.extensions, []);
  assert.deepEqual(settings.skills, []);
  assert.equal(settings.enableInstallTelemetry, false);
  assert.equal(resources.noExtensions, true);
  assert.equal(resources.noSkills, true);
  assert.equal(resources.noContextFiles, true);
  assert.equal(resources.noPromptTemplates, true);
});

test('Maat status lines show browser, Case, and Evidence state', () => {
  const caseManager = new CaseDraftManager();
  caseManager.begin({
    id: 'login-case',
    name: 'Login Case',
    description: 'Verify login',
    objectives: ['Dashboard is visible'],
  });

  const lines = maatStatusLines(
    { id: 'web', label: 'Web', root: '/tmp/web', session: 'idle', detail: 'chrome · headless' },
    caseManager,
  );
  assert.match(lines[0]!, /Platform Web · chrome · headless · idle/);
  assert.match(lines[1]!, /Case     login-case · 0 steps/);
  assert.match(lines[2]!, /Evidence 0 items · 1 objectives/);
});
