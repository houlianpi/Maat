import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aggregateSetup } from '../packages/core/src/setup-assistant/model.ts';
import { SetupAssistant } from '../packages/core/src/setup-assistant/setup-assistant.ts';
import { SetupPreferenceStore } from '../packages/core/src/setup-assistant/storage.ts';
import type { SetupSnapshot } from '../packages/core/src/setup-assistant/types.ts';
import { detectMacosSetup } from '../packages/core/src/setup-assistant/macos-detector.ts';

const fingerprint = { appiumPid: 10, appiumStartedAt: 'now', wdaPid: 20, wdaStartedAt: 'now' };

function partialSnapshot(): SetupSnapshot {
  return aggregateSetup({
    platform: 'macos',
    fingerprint,
    checkedAt: '2026-10-09T00:00:00.000Z',
    capabilities: [
      {
        id: 'appiumServer',
        status: 'ready',
        required: true,
        messageKey: 'capability.appium.ready',
      },
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
        errorCode: 'MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED',
        action: {
          id: 'open-screen-recording',
          labelKey: 'action.openScreenRecording',
          settingsUrl: 'x-apple.systempreferences:Privacy_ScreenCapture',
        },
      },
    ],
  });
}

test('setup aggregation distinguishes ready, partial, and blocked states', () => {
  const unknown = new SetupAssistant().current();
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.canContinue, false);
  const partial = partialSnapshot();
  assert.equal(partial.readiness, 'partially-ready');
  assert.equal(partial.canContinue, true);
  assert.equal(partial.recommendedAction?.id, 'open-screen-recording');
  const blocked = aggregateSetup({
    platform: 'macos',
    capabilities: [
      {
        id: 'appiumServer',
        status: 'action-required',
        required: true,
        messageKey: 'capability.appium.start',
        action: { id: 'start-appium', labelKey: 'action.startAppium' },
      },
    ],
  });
  assert.equal(blocked.readiness, 'blocked');
  assert.equal(blocked.canContinue, false);
  assert.equal(blocked.state, 'action-required');
});

test('setup exposes checking while a read-only detector is in flight', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-checking-'));
  let finish!: (snapshot: SetupSnapshot) => void;
  const assistant = new SetupAssistant({
    preferencesFile: path.join(directory, 'setup.json'),
    detector: () => new Promise((resolve) => (finish = resolve)),
  });
  try {
    const checking = assistant.check();
    assert.equal(assistant.current().state, 'checking');
    assert.equal(assistant.current().canContinue, false);
    finish(partialSnapshot());
    assert.equal((await checking).state, 'partially-ready');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup skip persists only while Appium and WDA fingerprints match', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-'));
  const file = path.join(directory, 'setup.json');
  try {
    const assistant = new SetupAssistant({
      preferencesFile: file,
      detector: async () => partialSnapshot(),
    });
    await assistant.check();
    const skipped = await assistant.skip('screenCapture');
    assert.equal(
      skipped.capabilities.find((item) => item.id === 'screenCapture')?.status,
      'skipped',
    );
    const store = new SetupPreferenceStore(file);
    assert.ok(await store.read(fingerprint));
    assert.equal(await store.read({ ...fingerprint, wdaPid: 21 }), undefined);
    assert.equal(await store.read({}), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corrupted setup preferences are ignored and replaced atomically', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-corrupt-'));
  const file = path.join(directory, 'setup.json');
  try {
    await writeFile(file, '{not-json');
    const store = new SetupPreferenceStore(file);
    assert.equal(await store.read(fingerprint), undefined);
    await store.write({ skippedCapabilities: [], fingerprint, updatedAt: 'now' });
    assert.deepEqual((await store.read(fingerprint))?.fingerprint, fingerprint);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup action moves workflow to waiting-for-recheck without changing the system', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-action-'));
  const assistant = new SetupAssistant({
    preferencesFile: path.join(directory, 'setup.json'),
    detector: async () => partialSnapshot(),
  });
  try {
    await assistant.check();
    const action = await assistant.action();
    assert.equal(action.id, 'open-screen-recording');
    assert.equal(assistant.current().state, 'waiting-for-recheck');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('macOS detector reports functional testing with optional screenshot degradation', async () => {
  const snapshot = await detectMacosSetup(
    {},
    {
      fetchStatus: async () => true,
      command: async (file, args = []) => {
        const command = [file, ...args].join(' ');
        if (command.includes('driver list'))
          return { stdout: JSON.stringify({ mac2: { version: '4.3.0' } }), stderr: '' };
        if (file === 'automationmodetool')
          return { stdout: 'Automation Mode is ENABLED.', stderr: '' };
        if (command.includes('doctor')) return { stdout: 'All required checks passed', stderr: '' };
        if (command.includes('command -v ffmpeg')) return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      fingerprint: async () => ({ ...fingerprint, wdaPath: '/tmp/WebDriverAgentRunner' }),
      probeSession: async () => ({
        accessibility: true,
        uiInteraction: true,
        screenCapture: false,
        screenCaptureEmpty: true,
      }),
    },
  );
  assert.equal(snapshot.readiness, 'partially-ready');
  assert.equal(snapshot.canContinue, true);
  assert.equal(
    snapshot.capabilities.find((item) => item.id === 'screenCapture')?.errorCode,
    'MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED',
  );
  assert.equal(snapshot.capabilities.find((item) => item.id === 'videoRecording')?.required, false);
});

test('enabled Automation Mode with authentication remains an optional improvement', async () => {
  const snapshot = await detectMacosSetup(
    {},
    {
      fetchStatus: async () => false,
      command: async (file) =>
        file === 'automationmodetool'
          ? {
              stdout: 'Automation Mode is ENABLED. This device requires user authentication.',
              stderr: '',
            }
          : { stdout: '', stderr: '' },
      fingerprint: async () => ({}),
      probeSession: async () => ({
        accessibility: false,
        uiInteraction: false,
        screenCapture: false,
        screenCaptureEmpty: false,
      }),
    },
  );
  const automation = snapshot.capabilities.find((item) => item.id === 'automationMode');
  assert.equal(automation?.required, false);
});

test('macOS setup detection aborts before later probes and preserves cleanup boundaries', async () => {
  const controller = new AbortController();
  let commandCalls = 0;
  let probeCalls = 0;
  const detection = detectMacosSetup(
    { signal: controller.signal },
    {
      fingerprint: async () => fingerprint,
      fetchStatus: async (_url, signal) => {
        signal?.throwIfAborted();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return true;
      },
      command: async () => {
        commandCalls += 1;
        return { stdout: '', stderr: '' };
      },
      probeSession: async () => {
        probeCalls += 1;
        return {
          accessibility: true,
          uiInteraction: true,
          screenCapture: true,
          screenCaptureEmpty: false,
        };
      },
    },
  );
  controller.abort(new Error('setup check cancelled'));
  await assert.rejects(detection, /setup check cancelled/);
  assert.equal(commandCalls, 0);
  assert.equal(probeCalls, 0);
});

test('an aborted assistant check restores the previous usable snapshot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-abort-'));
  let abortNext = false;
  const assistant = new SetupAssistant({
    preferencesFile: path.join(directory, 'setup.json'),
    detector: async () => {
      if (abortNext) throw new Error('cancelled');
      return partialSnapshot();
    },
  });
  try {
    await assistant.check();
    abortNext = true;
    await assert.rejects(assistant.check(), /cancelled/);
    assert.equal(assistant.current().state, 'partially-ready');
    assert.equal(assistant.current().canContinue, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup interruption resumes only after the interrupted capability recovers', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-interruption-'));
  const assistant = new SetupAssistant({
    preferencesFile: path.join(directory, 'setup.json'),
    detector: async () => partialSnapshot(),
  });
  try {
    assistant.interrupt({ platform: 'macos', caseId: 'calculator', pendingAction: 'screenshot' });
    await assistant.check();
    assert.equal(assistant.resume(), undefined);
    assert.equal(assistant.pendingInterruption()?.caseId, 'calculator');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rechecking the same WDA process after opening Screen Recording requests restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-restart-'));
  const preferencesFile = path.join(directory, 'setup.json');
  try {
    const assistant = new SetupAssistant({
      preferencesFile,
      detector: async () => partialSnapshot(),
    });
    await assistant.check();
    await assistant.action('open-screen-recording');

    const restartedHost = new SetupAssistant({
      preferencesFile,
      detector: async () => partialSnapshot(),
    });
    const snapshot = await restartedHost.check();
    const screenCapture = snapshot.capabilities.find((item) => item.id === 'screenCapture');
    assert.equal(screenCapture?.status, 'restart-required');
    assert.equal(screenCapture?.errorCode, 'MACOS_SCREEN_CAPTURE_RESTART_REQUIRED');
    assert.equal(snapshot.recommendedAction?.id, 'restart-appium');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a changed WDA process invalidates the permission action restart cache', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-changed-'));
  let currentFingerprint = fingerprint;
  const assistant = new SetupAssistant({
    preferencesFile: path.join(directory, 'setup.json'),
    detector: async () => {
      const snapshot = partialSnapshot();
      return { ...snapshot, fingerprint: currentFingerprint };
    },
  });
  try {
    await assistant.check();
    await assistant.action('open-screen-recording');
    currentFingerprint = { ...fingerprint, wdaPid: 21, wdaStartedAt: 'later' };
    const snapshot = await assistant.check();
    const screenCapture = snapshot.capabilities.find((item) => item.id === 'screenCapture');
    assert.equal(screenCapture?.status, 'action-required');
    assert.equal(screenCapture?.errorCode, 'MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a changed process clears persisted pending actions and skipped capabilities', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'maat-setup-process-'));
  const preferencesFile = path.join(directory, 'setup.json');
  let currentFingerprint = fingerprint;
  const detector = async () => {
    const snapshot = partialSnapshot();
    return { ...snapshot, fingerprint: currentFingerprint };
  };
  try {
    const assistant = new SetupAssistant({ preferencesFile, detector });
    await assistant.check();
    await assistant.skip('videoRecording').catch(() => undefined);
    await assistant.action('open-screen-recording');
    currentFingerprint = { ...fingerprint, wdaPid: 99, wdaStartedAt: 'later' };

    const restartedHost = new SetupAssistant({ preferencesFile, detector });
    const snapshot = await restartedHost.check();
    assert.equal(
      snapshot.capabilities.find((item) => item.id === 'screenCapture')?.status,
      'action-required',
    );
    const stored = await new SetupPreferenceStore(preferencesFile).readAny();
    assert.equal(stored?.pendingAction, undefined);
    assert.deepEqual(stored?.skippedCapabilities, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
