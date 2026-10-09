export type SetupState =
  | 'unknown'
  | 'checking'
  | 'action-required'
  | 'waiting-for-recheck'
  | 'partially-ready'
  | 'ready';

export type SetupCapabilityStatus =
  | 'unknown'
  | 'checking'
  | 'ready'
  | 'action-required'
  | 'restart-required'
  | 'unavailable'
  | 'skipped';

export type SetupCapabilityId =
  | 'appiumServer'
  | 'mac2Driver'
  | 'automationMode'
  | 'accessibility'
  | 'uiInteraction'
  | 'screenCapture'
  | 'videoRecording'
  | 'fullDiskAccess';

export type SetupErrorCode =
  | 'APPIUM_SERVER_UNAVAILABLE'
  | 'MAC2_DRIVER_MISSING'
  | 'AUTOMATION_MODE_AUTH_REQUIRED'
  | 'MACOS_ACCESSIBILITY_PERMISSION_REQUIRED'
  | 'MACOS_SCREEN_CAPTURE_PERMISSION_REQUIRED'
  | 'MACOS_SCREEN_CAPTURE_RESTART_REQUIRED'
  | 'MACOS_FULL_DISK_ACCESS_REQUIRED'
  | 'FFMPEG_MISSING';

export type SetupMessageKey =
  | 'setup.title.checking'
  | 'setup.title.unknown'
  | 'setup.title.ready'
  | 'setup.title.partial'
  | 'setup.title.blocked'
  | 'setup.summary.checking'
  | 'setup.summary.unknown'
  | 'setup.summary.ready'
  | 'setup.summary.partial'
  | 'setup.summary.blocked'
  | 'capability.appium.ready'
  | 'capability.appium.start'
  | 'capability.mac2.ready'
  | 'capability.mac2.install'
  | 'capability.automation.ready'
  | 'capability.automation.auth'
  | 'capability.automation.unavailable'
  | 'capability.accessibility.ready'
  | 'capability.accessibility.required'
  | 'capability.interaction.ready'
  | 'capability.interaction.required'
  | 'capability.screenshot.ready'
  | 'capability.screenshot.required'
  | 'capability.screenshot.unknown'
  | 'capability.interaction.unknown'
  | 'capability.screenshot.restart'
  | 'capability.fullDisk.ready'
  | 'capability.fullDisk.required'
  | 'capability.video.ready'
  | 'capability.video.unavailable'
  | 'action.startAppium'
  | 'action.installMac2'
  | 'action.automationMode'
  | 'action.openAccessibility'
  | 'action.openScreenRecording'
  | 'action.openFullDiskAccess'
  | 'action.installFfmpeg'
  | 'action.restartAppium'
  | 'action.recheck';

export type SetupAction = {
  id:
    | 'open-screen-recording'
    | 'open-accessibility'
    | 'open-full-disk-access'
    | 'restart-appium'
    | 'install-mac2'
    | 'start-appium'
    | 'authenticate-automation-mode'
    | 'install-ffmpeg'
    | 'recheck';
  labelKey: SetupMessageKey;
  settingsUrl?: string;
  command?: string;
  estimatedMinutes?: number;
  requiresConfirmation?: boolean;
};

export type SetupCapability = {
  id: SetupCapabilityId;
  status: SetupCapabilityStatus;
  required: boolean;
  messageKey: SetupMessageKey;
  errorCode?: SetupErrorCode;
  action?: SetupAction;
  details?: Record<string, unknown>;
};

export type SetupProcessFingerprint = {
  appiumPid?: number;
  appiumStartedAt?: string;
  wdaPid?: number;
  wdaStartedAt?: string;
};

export type SetupSnapshot = {
  platform: string;
  state: SetupState;
  readiness: 'ready' | 'partially-ready' | 'blocked';
  titleKey: SetupMessageKey;
  summaryKey: SetupMessageKey;
  checkedAt: string;
  capabilities: SetupCapability[];
  available: SetupCapabilityId[];
  unavailable: SetupCapabilityId[];
  recommendedAction?: SetupAction;
  canContinue: boolean;
  restartRequired: boolean;
  fingerprint: SetupProcessFingerprint;
  technicalDetails?: Record<string, unknown>;
};

export type SetupPreference = {
  skippedCapabilities: SetupCapabilityId[];
  fingerprint: SetupProcessFingerprint;
  pendingAction?: {
    id: SetupAction['id'];
    fingerprint: SetupProcessFingerprint;
    updatedAt: string;
  };
  updatedAt: string;
};

export type SetupInterruption = {
  platform: string;
  caseId?: string;
  pendingAction?: string;
  workMode?: string;
  interruptedAt: string;
};
