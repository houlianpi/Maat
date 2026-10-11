import path from 'node:path';

import { createDefaultPlatformRegistry } from '../platforms/default-registry.ts';
import { MaatApi } from './maat-api.ts';
import type { SetupAssistantOptions } from '../setup-assistant/setup-assistant.ts';

export type CreateMaatOptions = {
  workspaceRoot?: string;
  setupAssistant?: SetupAssistantOptions;
};

export function createMaat(options: CreateMaatOptions = {}): MaatApi {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  return new MaatApi(
    createDefaultPlatformRegistry(workspaceRoot),
    workspaceRoot,
    options.setupAssistant,
  );
}
