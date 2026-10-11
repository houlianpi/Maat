import assert from 'node:assert/strict';
import test from 'node:test';

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
  assert.equal(resources.additionalSkillPaths.length, 2);
  assert.match(resources.additionalSkillPaths[0]!, /skills\/maat-setup\/SKILL\.md$/);
  assert.match(resources.additionalSkillPaths[1]!, /skills\/mobile-use\/SKILL\.md$/);
  assert.equal(resources.noContextFiles, true);
  assert.equal(resources.noPromptTemplates, true);
});

test('Android status presents execution without Case or Evidence counts', () => {
  const lines = maatStatusLines({ id: 'android', label: 'Android', session: 'idle' });
  assert.match(lines[1]!, /UI execution/);
  assert.doesNotMatch(lines.join('\n'), /no active Case|Evidence 0/);
});

test('Maat status lines show the selected platform and observation boundary', () => {
  const lines = maatStatusLines({
    id: 'web',
    label: 'Web',
    session: 'idle',
    detail: 'chrome · headless',
  });
  assert.match(lines[0]!, /Platform Web · chrome · headless · idle/);
  assert.match(lines[1]!, /observations are not business validation/);
  assert.doesNotMatch(lines.join('\n'), /Case|Evidence/);
});
