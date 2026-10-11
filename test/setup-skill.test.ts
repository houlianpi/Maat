import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DefaultResourceLoader,
  loadSkillsFromDir,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  MAAT_MOBILE_USE_SKILL_PATH,
  MAAT_SETUP_SKILL_PATH,
  MAAT_SYSTEM_PROMPT,
} from '../packages/pi/src/system-prompt.ts';
import { createMaatResourceOptions } from '../packages/maat/src/hosts/tui/runtime-config.ts';

test('the Pi package ships internal workflows without registering Skill commands', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../packages/pi/package.json', import.meta.url), 'utf8'),
  ) as { files: string[]; pi: { skills?: string[] } };
  assert.ok(manifest.files.includes('skills'));
  assert.equal(manifest.pi.skills, undefined);
  const loaded = loadSkillsFromDir({
    dir: path.resolve(path.dirname(MAAT_SETUP_SKILL_PATH), '..'),
    source: 'maat-test',
  });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(
    loaded.skills.map((skill) => skill.name),
    ['maat-setup', 'mobile-use'],
  );
  assert.equal(loaded.skills[0]!.filePath, MAAT_SETUP_SKILL_PATH);
  assert.equal(loaded.skills[1]!.filePath, MAAT_MOBILE_USE_SKILL_PATH);
  assert.doesNotMatch(MAAT_SYSTEM_PROMPT, /begin_case|save_case|case mode/i);
  assert.match(MAAT_SYSTEM_PROMPT, /check_device_ready/);
  const script = await readFile(
    new URL('../packages/pi/skills/maat-setup/scripts/android-tools.mjs', import.meta.url),
    'utf8',
  );
  assert.match(script, /resolveAndroidTools/);
  assert.match(script, /prepareAndroidTools/);
  assert.match(script, /tools\.environment/);
});

test('standalone loads only its own setup Skill while retaining resource isolation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-skill-loader-'));
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory(),
      ...createMaatResourceOptions([]),
    });

    await loader.reload();
    assert.deepEqual(loader.getSkills().diagnostics, []);
    assert.deepEqual(
      loader.getSkills().skills.map((skill) => skill.name),
      ['maat-setup', 'mobile-use'],
    );
    assert.equal(loader.getSkills().skills[0]!.filePath, MAAT_SETUP_SKILL_PATH);
    assert.equal(loader.getSkills().skills[1]!.filePath, MAAT_MOBILE_USE_SKILL_PATH);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mobile Use guidance covers Unicode input, visual fallback and intercepted gestures', async () => {
  const skill = await readFile(MAAT_MOBILE_USE_SKILL_PATH, 'utf8');
  assert.match(skill, /mobile: type/);
  assert.match(skill, /Input authorization is not send authorization/);
  assert.match(skill, /Do not try clipboard transport first for Chinese/);
  assert.match(skill, /tree is\s+effectively empty/);
  assert.match(skill, /Map displayed-image coordinates back to the original screenshot/);
  assert.match(skill, /Do not chain\s+blind Back actions/);
  assert.match(skill, /Returning from\s+a menu does not prove that all content was unchanged/);
});
