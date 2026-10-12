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
  const { createMaatResourceOptions } = await import(
    '../packages/maat/src/hosts/tui/runtime-config.ts'
  );
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

test('mobile policy reaches the Pi prompt and Skill without a parallel operation path', async () => {
  const skill = await readFile(MAAT_MOBILE_USE_SKILL_PATH, 'utf8');
  assert.match(skill, /Android and iPhone UI tasks/);
  assert.match(skill, /Use `exe_js` for all phone UI observation and interaction/);
  assert.match(skill, /Only use visual absolute-coordinate actions when the JS interface cannot/);
  assert.match(skill, /bad selector, truncated tree or parsing/);
  assert.match(skill, /identified scroll container and a supported element-targeted/);
  assert.match(skill, /not a separate recognition runtime/);
  assert.doesNotMatch(skill, /Use host-authorized ADB only when/);
  assert.match(MAAT_SYSTEM_PROMPT, /execute all UI interaction through exe_js/);
  assert.match(MAAT_SYSTEM_PROMPT, /Controls come first/);
  assert.match(MAAT_SYSTEM_PROMPT, /map its pixels to Appium viewport units/);
});

test('UI-only execution policy preserves authorized Android file transfer', async () => {
  const skill = await readFile(MAAT_MOBILE_USE_SKILL_PATH, 'utf8');
  assert.match(skill, /This is a UI-only boundary/);
  assert.match(skill, /`adb push` copies to the device/);
  assert.match(skill, /`adb pull` copies to the computer/);
  assert.match(skill, /bind the\s+exact selected device/);
  assert.match(skill, /ask before an overwrite not already authorized/);
  assert.match(skill, /ADB is not an iOS capability/);
  assert.match(skill, /not an Appium Session or\s+`check_device_ready`/);
  assert.match(MAAT_SYSTEM_PROMPT, /Android adb push and adb pull file transfers are allowed/);
  assert.match(MAAT_SYSTEM_PROMPT, /not an iOS API or an alternate UI path/);
  assert.match(MAAT_SYSTEM_PROMPT, /execute all UI interaction through exe_js/);
});

test('iOS internal workflows require transient authorization and never reuse Android-only examples', async () => {
  const setup = await readFile(MAAT_SETUP_SKILL_PATH, 'utf8');
  const mobile = await readFile(MAAT_MOBILE_USE_SKILL_PATH, 'utf8');
  assert.match(setup, /## iOS/);
  assert.match(setup, /allowWdaInitialization/);
  assert.match(setup, /IOS_WDA_SECURITY_REJECTED/);
  assert.match(mobile, /## iOS/);
  assert.match(mobile, /Android-only/);
  assert.match(MAAT_SYSTEM_PROMPT, /allowWdaInitialization=true/);
  assert.match(MAAT_SYSTEM_PROMPT, /not current-unlock proof/);
});

test('unified preparation uses concrete task ownership instead of nonexistent bash background APIs', async () => {
  const setup = await readFile(MAAT_SETUP_SKILL_PATH, 'utf8');
  assert.match(setup, /prepare_mobile/);
  assert.match(setup, /serviceResponding only/);
  assert.match(setup, /60-second/);
  assert.match(setup, /Paid and free signing are both supported/);
  assert.doesNotMatch(
    setup,
    /using the host's supported background|offer\s+an explicit user-managed terminal/,
  );
  assert.match(MAAT_SYSTEM_PROMPT, /Do not use bash nohup/);
  assert.match(MAAT_SYSTEM_PROMPT, /paid and free certificates/);
});
