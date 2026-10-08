export { createMaat, type CreateMaatOptions } from './api/create-maat.ts';
export { MaatApi } from './api/maat-api.ts';
export type { CaseSelection } from './core/testing/case-selection.ts';
export { CaseDraftManager, type BeginCaseInput } from './core/cases/draft-manager.ts';
export { saveCase } from './core/cases/save-case.ts';
export { runMaatTests, type MaatRunOptions, type MaatRunResult } from './core/testing/runner.ts';
export type { StepExecution, StepRecorder } from './core/cases/step-recorder.ts';
export type { JavaScriptObservation } from './core/exploration/protocol.ts';
export type { JavaScriptSession } from './core/exploration/runtime.ts';
export type { PlatformStatus } from './core/platforms/contracts.ts';
export {
  browserNames,
  browserChannel,
  parseBrowserName,
  type BrowserName,
} from './platforms/web/config.ts';
export { nativeDeviceKinds } from './platforms/appium/schema.ts';
