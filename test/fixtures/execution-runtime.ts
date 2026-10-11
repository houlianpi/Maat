import type {
  ExplorationRuntime,
  ExplorationRuntimeModule,
} from '../../packages/core/src/core/exploration/runtime.ts';

const state = { value: 'initial' };

export const createRuntime: ExplorationRuntimeModule['createRuntime'] = async (options) => {
  if (
    options &&
    typeof options === 'object' &&
    'failInitialization' in options &&
    options.failInitialization === true
  )
    throw new Error('Fixture runtime initialization failed.');
  const runtime: ExplorationRuntime = {
    bindings: () => ({
      state: {
        get: () => state.value,
        set: (value: string) => {
          state.value = value;
        },
      },
    }),
    screenshot: async () => {
      throw new Error('Screenshot is not available in the execution error fixture.');
    },
    close: async () => {},
  };
  return runtime;
};
