import { fileURLToPath } from 'node:url';
import { createNativeConfig } from '../../src/native/wdio-config.ts';
export const config = await createNativeConfig(fileURLToPath(new URL('.', import.meta.url)));
