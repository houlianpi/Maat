import path from 'node:path';

import { createDefaultPlatformRegistry } from '../platforms/default-registry.ts';
import { MaatApi } from './maat-api.ts';
import type { SetupAssistantOptions } from '../setup-assistant/setup-assistant.ts';

export type CreateMaatOptions = {
  workspaceRoot?: string;
  testsRoot?: string;
  setupAssistant?: SetupAssistantOptions;
};

export function createMaat(options: CreateMaatOptions = {}): MaatApi {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const testsRoot = path.resolve(workspaceRoot, options.testsRoot ?? 'maat-tests');
  return new MaatApi(
    createDefaultPlatformRegistry(testsRoot),
    workspaceRoot,
    options.setupAssistant,
  );
}
