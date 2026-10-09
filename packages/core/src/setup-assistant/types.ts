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
  label: string;
  settingsUrl?: string;
  command?: string;
  estimatedMinutes?: number;
  requiresConfirmation?: boolean;
};

export type SetupCapability = {
  id: SetupCapabilityId;
  status: SetupCapabilityStatus;
  required: boolean;
  summary: string;
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
  title: string;
  summary: string;
  checkedAt: string;
  capabilities: SetupCapability[];
  available: string[];
  unavailable: string[];
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
