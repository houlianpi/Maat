import { homedir } from 'node:os';
import path from 'node:path';
import { detectMacosSetup, type MacosSetupDetectorDependencies } from './macos-detector.ts';
import { aggregateSetup } from './model.ts';
import { sameFingerprint, SetupPreferenceStore } from './storage.ts';
import type {
  SetupAction,
  SetupCapabilityId,
  SetupInterruption,
  SetupPreference,
  SetupSnapshot,
} from './types.ts';

export type SetupAssistantOptions = {
  preferencesFile?: string;
  detector?: typeof detectMacosSetup;
  detectorDependencies?: MacosSetupDetectorDependencies;
};

function unknownSnapshot(platform = 'macos'): SetupSnapshot {
  return aggregateSetup({ platform, capabilities: [], state: 'unknown' });
}

export class SetupAssistant {
  private snapshot: SetupSnapshot = unknownSnapshot();
  private waitingForRecheck = false;
  private readonly store: SetupPreferenceStore;
  private readonly detector: typeof detectMacosSetup;
  private readonly detectorDependencies?: MacosSetupDetectorDependencies;
  private interruption?: SetupInterruption;
  private actionFingerprint?: SetupSnapshot['fingerprint'];
  private lastActionId?: SetupAction['id'];

  constructor(options: SetupAssistantOptions = {}) {
    this.store = new SetupPreferenceStore(
      options.preferencesFile ?? path.join(homedir(), '.maat', 'setup', 'macos.json'),
    );
    this.detector = options.detector ?? detectMacosSetup;
    this.detectorDependencies = options.detectorDependencies;
  }

  current(): SetupSnapshot {
    return this.snapshot;
  }

  interrupt(input: Omit<SetupInterruption, 'interruptedAt'>): SetupInterruption {
    this.interruption = { ...input, interruptedAt: new Date().toISOString() };
    return this.interruption;
  }

  pendingInterruption(): SetupInterruption | undefined {
    return this.interruption;
  }

  resume(): SetupInterruption | undefined {
    if (!this.snapshot.canContinue) return undefined;
    const pendingCapability = (() => {
      switch (this.interruption?.pendingAction) {
        case 'screenshot':
        case 'open-screen-recording':
          return 'screenCapture';
        case 'open-accessibility':
          return 'accessibility';
        case 'open-full-disk-access':
          return 'fullDiskAccess';
        case 'install-mac2':
          return 'mac2Driver';
        case 'start-appium':
        case 'restart-appium':
          return 'appiumServer';
        case 'authenticate-automation-mode':
          return 'automationMode';
        case 'install-ffmpeg':
          return 'videoRecording';
        default:
          return undefined;
      }
    })();
    if (pendingCapability) {
      const capability = this.snapshot.capabilities.find(
        (candidate) => candidate.id === pendingCapability,
      );
      if (!capability || !['ready', 'skipped'].includes(capability.status)) return undefined;
    }
    const value = this.interruption;
    this.interruption = undefined;
    return value;
  }

  async check(
    input: { platform?: string; serverUrl?: string; signal?: AbortSignal } = {},
  ): Promise<SetupSnapshot> {
    if ((input.platform ?? 'macos') !== 'macos') {
      this.snapshot = aggregateSetup({
        platform: input.platform!,
        capabilities: [],
        state: 'unknown',
      });
      return this.snapshot;
    }
    const previous = this.snapshot;
    this.snapshot = aggregateSetup({
      platform: 'macos',
      capabilities: [],
      state: 'checking',
    });
    let detected: SetupSnapshot;
    try {
      detected = await this.detector(
        { serverUrl: input.serverUrl, signal: input.signal },
        this.detectorDependencies,
      );
    } catch (error) {
      this.snapshot = previous;
      throw error;
    }
    const stored = await this.store.readAny();
    const preference =
      stored && sameFingerprint(stored.fingerprint, detected.fingerprint) ? stored : undefined;
    const pendingAction = stored?.pendingAction;
    const persistedScreenRecordingAction =
      pendingAction?.id === 'open-screen-recording' &&
      sameFingerprint(pendingAction.fingerprint, detected.fingerprint);
    const screenRecordingFingerprint = this.actionFingerprint ?? pendingAction?.fingerprint;
    const capabilities = detected.capabilities.map((capability) => {
      if (preference?.skippedCapabilities.includes(capability.id) && !capability.required)
        return {
          ...capability,
          status: 'skipped' as const,
          summary: `${capability.summary}（已暂时跳过）`,
        };
      if (
        ((this.waitingForRecheck && this.lastActionId === 'open-screen-recording') ||
          persistedScreenRecordingAction) &&
        capability.id === 'screenCapture' &&
        capability.status !== 'ready' &&
        screenRecordingFingerprint &&
        sameFingerprint(screenRecordingFingerprint, detected.fingerprint)
      ) {
        return {
          ...capability,
          status: 'restart-required' as const,
          summary: '权限可能已更新，需要重启 macOS 测试服务后生效',
          errorCode: 'MACOS_SCREEN_CAPTURE_RESTART_REQUIRED' as const,
          action: {
            id: 'restart-appium' as const,
            label: '重启 macOS 测试服务',
            command: 'Stop Appium with Ctrl+C, then run: appium --address 127.0.0.1 --port 4723',
            requiresConfirmation: true,
            estimatedMinutes: 1,
          },
        };
      }
      return capability;
    });
    const screenCaptureSettled = ['ready', 'skipped'].includes(
      capabilities.find((item) => item.id === 'screenCapture')?.status ?? '',
    );
    const processChanged = Boolean(
      pendingAction && !sameFingerprint(pendingAction.fingerprint, detected.fingerprint),
    );
    if (pendingAction && (screenCaptureSettled || processChanged)) {
      await this.store.write({
        skippedCapabilities: processChanged ? [] : (preference?.skippedCapabilities ?? []),
        fingerprint: detected.fingerprint,
        updatedAt: new Date().toISOString(),
      });
    }
    this.snapshot = aggregateSetup({
      platform: detected.platform,
      capabilities,
      checkedAt: detected.checkedAt,
      fingerprint: detected.fingerprint,
      technicalDetails: detected.technicalDetails,
      waitingForRecheck: this.waitingForRecheck,
    });
    this.waitingForRecheck = false;
    this.lastActionId = undefined;
    this.actionFingerprint = undefined;
    return this.snapshot;
  }

  async action(actionId?: SetupAction['id']): Promise<SetupAction> {
    const actions = this.snapshot.capabilities
      .map((capability) => capability.action)
      .filter((action): action is SetupAction => Boolean(action));
    const action = actionId
      ? actions.find((candidate) => candidate.id === actionId)
      : this.snapshot.recommendedAction;
    if (!action) throw new Error('No matching setup action is currently required.');
    this.lastActionId = action.id;
    this.actionFingerprint = this.snapshot.fingerprint;
    this.waitingForRecheck = true;
    const current = await this.store.read(this.snapshot.fingerprint);
    const now = new Date().toISOString();
    await this.store.write({
      skippedCapabilities: current?.skippedCapabilities ?? [],
      fingerprint: this.snapshot.fingerprint,
      pendingAction: { id: action.id, fingerprint: this.snapshot.fingerprint, updatedAt: now },
      updatedAt: now,
    });
    this.snapshot = aggregateSetup({
      platform: this.snapshot.platform,
      capabilities: this.snapshot.capabilities,
      checkedAt: this.snapshot.checkedAt,
      fingerprint: this.snapshot.fingerprint,
      technicalDetails: this.snapshot.technicalDetails,
      waitingForRecheck: true,
    });
    return action;
  }

  async skip(capabilityId: SetupCapabilityId): Promise<SetupSnapshot> {
    const capability = this.snapshot.capabilities.find((item) => item.id === capabilityId);
    if (!capability) throw new Error(`Unknown setup capability: ${capabilityId}`);
    if (capability.required) throw new Error(`${capabilityId} is required and cannot be skipped.`);
    const current = await this.store.read(this.snapshot.fingerprint);
    const preference: SetupPreference = {
      skippedCapabilities: [...new Set([...(current?.skippedCapabilities ?? []), capabilityId])],
      fingerprint: this.snapshot.fingerprint,
      ...(current?.pendingAction ? { pendingAction: current.pendingAction } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.store.write(preference);
    return this.check({ platform: this.snapshot.platform });
  }
}
