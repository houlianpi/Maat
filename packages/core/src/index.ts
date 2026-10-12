export { createMaat, type CreateMaatOptions } from './api/create-maat.ts';
export { MaatApi } from './api/maat-api.ts';
export type { JavaScriptObservation } from './core/exploration/protocol.ts';
export {
  ExplorationExecutionError,
  WorkerTerminatedError,
  type JavaScriptSession,
} from './core/exploration/runtime.ts';
export type {
  ExecutionErrorCategory,
  ExecutionErrorPhase,
  WorkerError,
} from './core/exploration/protocol.ts';
export type { PlatformStatus } from './core/platforms/contracts.ts';
export {
  browserNames,
  browserChannel,
  parseBrowserName,
  type BrowserName,
} from './platforms/web/config.ts';
export { nativeDeviceKinds } from './platforms/appium/schema.ts';
export type { NativeDeviceSelector } from './platforms/appium/schema.ts';
export { SetupAssistant, type SetupAssistantOptions } from './setup-assistant/setup-assistant.ts';
export { aggregateSetup } from './setup-assistant/model.ts';
export { SetupPreferenceStore, sameFingerprint } from './setup-assistant/storage.ts';
export {
  detectMacosSetup,
  type MacosSetupDetectorDependencies,
} from './setup-assistant/macos-detector.ts';
export {
  detectAndroidSetup,
  type AndroidSetupDetectorDependencies,
  type AndroidSetupCommandResult,
} from './setup-assistant/android-detector.ts';
export type * from './setup-assistant/types.ts';
export {
  detectIosSetup,
  type IosSetupDetectorDependencies,
} from './setup-assistant/ios-detector.ts';
export {
  resolveAndroidTools,
  prepareAndroidTools,
  assertAdbServerCompatible,
} from './setup/android-tools.ts';
export type {
  ResolvedAndroidTools,
  ResolveAndroidToolsOptions,
  PrepareAndroidToolsOptions,
} from './setup/android-tools.ts';
export { resolveAppiumCommand, type ResolvedAppiumCommand } from './setup/appium-command.ts';
export {
  inspectIosWda,
  prepareIosWda,
  type IosWdaInspection,
  type IosWdaInput,
} from './setup/ios-wda.ts';
