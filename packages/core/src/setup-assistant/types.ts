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
  | 'adb'
  | 'androidSdk'
  | 'appiumCli'
  | 'adbServer'
  | 'uiautomator2Driver'
  | 'androidDevice'
  | 'xcode'
  | 'xcuitestDriver'
  | 'iosDevice'
  | 'iosDeveloperMode'
  | 'appiumServer'
  | 'mac2Driver'
  | 'automationMode'
  | 'accessibility'
  | 'uiInteraction'
  | 'screenCapture'
  | 'videoRecording'
  | 'fullDiskAccess';

export type SetupErrorCode =
  | 'ANDROID_SETUP_CHECK_FAILED'
  | 'IOS_SETUP_CHECK_FAILED'
  | 'IOS_SETUP_REMOTE_UNSUPPORTED'
  | 'IOS_HOST_UNSUPPORTED'
  | 'XCODE_REQUIRED'
  | 'XCUITEST_DRIVER_MISSING'
  | 'IOS_DEVICE_MISSING'
  | 'IOS_DEVICE_OFFLINE'
  | 'IOS_DEVICE_UNPAIRED'
  | 'IOS_DEVICE_SELECTION_REQUIRED'
  | 'IOS_DEVELOPER_MODE_REQUIRED'
  | 'ADB_MISSING'
  | 'ADB_SERVER_NOT_RUNNING'
  | 'APPIUM_CLI_MISSING'
  | 'ANDROID_SDK_REQUIRED'
  | 'UIAUTOMATOR2_DRIVER_MISSING'
  | 'ANDROID_DEVICE_MISSING'
  | 'ANDROID_DEVICE_UNAUTHORIZED'
  | 'ANDROID_DEVICE_OFFLINE'
  | 'ANDROID_DEVICE_SELECTION_REQUIRED'
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
  | 'capability.adb.ready'
  | 'capability.adb.install'
  | 'capability.adb.unknown'
  | 'capability.appiumCli.ready'
  | 'capability.appiumCli.install'
  | 'capability.appiumCli.unknown'
  | 'capability.adbServer.ready'
  | 'capability.adbServer.start'
  | 'capability.adbServer.unknown'
  | 'capability.androidSdk.ready'
  | 'capability.androidSdk.required'
  | 'capability.androidSdk.unknown'
  | 'capability.uiautomator2.ready'
  | 'capability.uiautomator2.install'
  | 'capability.uiautomator2.unknown'
  | 'capability.androidDevice.ready'
  | 'capability.androidDevice.missing'
  | 'capability.androidDevice.unauthorized'
  | 'capability.androidDevice.offline'
  | 'capability.androidDevice.select'
  | 'capability.androidDevice.unknown'
  | 'capability.xcode.ready'
  | 'capability.xcode.required'
  | 'capability.xcode.unknown'
  | 'capability.xcuitest.ready'
  | 'capability.xcuitest.install'
  | 'capability.xcuitest.unknown'
  | 'capability.iosDevice.ready'
  | 'capability.iosDevice.missing'
  | 'capability.iosDevice.offline'
  | 'capability.iosDevice.trust'
  | 'capability.iosDevice.select'
  | 'capability.iosDevice.unknown'
  | 'capability.iosDeveloperMode.ready'
  | 'capability.iosDeveloperMode.required'
  | 'capability.iosDeveloperMode.unknown'
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
  | 'action.installAdb'
  | 'action.installAppium'
  | 'action.startAdb'
  | 'action.configureAndroidSdk'
  | 'action.installUiAutomator2'
  | 'action.connectAndroidDevice'
  | 'action.authorizeAndroidDevice'
  | 'action.selectAndroidDevice'
  | 'action.configureXcode'
  | 'action.installXcuitest'
  | 'action.connectIosDevice'
  | 'action.trustIosDevice'
  | 'action.selectIosDevice'
  | 'action.enableIosDeveloperMode'
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
    | 'install-adb'
    | 'install-appium'
    | 'start-adb'
    | 'configure-android-sdk'
    | 'install-uiautomator2'
    | 'connect-android-device'
    | 'authorize-android-device'
    | 'select-android-device'
    | 'configure-xcode'
    | 'install-xcuitest'
    | 'connect-ios-device'
    | 'trust-ios-device'
    | 'select-ios-device'
    | 'enable-ios-developer-mode'
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
  pendingAction?: string;
  interruptedAt: string;
};
import type { JavaScriptObservation } from '../core/exploration/protocol.ts';
import type { NativeDeviceSelector } from '../platforms/appium/schema.ts';
import type { PublicDeviceCandidate, TargetSelectionInput } from '../mobile/contracts/device.ts';

export type AndroidSetupCheckInput = {
  serverUrl?: string;
  device?: NativeDeviceSelector;
  remoteDeviceConfigured?: boolean;
  signal?: AbortSignal;
};

export type IosSetupCheckInput = Pick<AndroidSetupCheckInput, 'serverUrl' | 'device' | 'signal'>;

export type SetupReadyInput = {
  screenshot?: boolean;
  signal?: AbortSignal;
  allowWdaInitialization?: boolean;
  allowWdaInstallation?: boolean;
  targetSelection?: TargetSelectionInput;
};

export type SetupReadinessSuccess = {
  platform: 'android' | 'ios';
  ready: true;
  targetSelection?: {
    selectedBy: 'single-candidate' | 'explicit-user-selection';
    candidate: PublicDeviceCandidate;
  };
  proof: {
    /** driver.isLocked() returned false before and after this observation, not a lasting guarantee. */
    phoneUnlocked: true;
    sessionUsable: true;
    sourceReadable: true;
    viewportReadable: true;
    screenshotReadable: boolean;
  };
  observations: JavaScriptObservation[];
};

export type SetupReadinessSelection =
  | {
      platform: 'android' | 'ios';
      ready: false;
      status: 'device-not-found' | 'selection-stale' | 'selection-invalid';
    }
  | {
      platform: 'android' | 'ios';
      ready: false;
      status: 'selection-required';
      discoveryId: string;
      candidates: readonly PublicDeviceCandidate[];
    }
  | {
      platform: 'android' | 'ios';
      ready: false;
      status: 'target-selected';
      selectedBy: 'single-candidate' | 'explicit-user-selection';
      candidate: PublicDeviceCandidate;
    };

export type SetupReadiness = SetupReadinessSuccess | SetupReadinessSelection;
