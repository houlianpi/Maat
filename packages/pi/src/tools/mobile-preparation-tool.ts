import { Type, type Static } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { MobilePreparation } from '../mobile-preparation.ts';

export function createMobilePreparationTool(preparation: MobilePreparation) {
  const parameters = Type.Object(
    {
      action: Type.Union(
        ['status', 'start-appium', 'build-ios-wda'].map((value) => Type.Literal(value)),
        {
          description:
            'status inspects current state or polls a returned taskId. start-appium/build-ios-wda start new work with taskId:null, never a guessed or existing taskId.',
        },
      ),
      taskId: Type.Optional(
        Type.Union([Type.String({ minLength: 1, pattern: '\\S' }), Type.Null()], {
          description:
            'Use only a taskId returned by this tool for status; use null when inspecting current state or starting new work. Never invent current/new/reuse-wda or use an empty string.',
        }),
      ),
      waitSeconds: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 20,
          description:
            'Wait 0–20 seconds for the same task. Use 0 for an immediate result; wait expiry never starts or replays work.',
        }),
      ),
      signingAuthorized: Type.Optional(
        Type.Boolean({
          description:
            'iOS WDA build/renewal only: true requires explicit user signing authorization. Use false otherwise; valid builds can be reused without it.',
        }),
      ),
    },
    { additionalProperties: false },
  );
  return defineTool({
    name: 'prepare_mobile',
    label: 'Prepare Local Phone',
    description:
      'Track local Android/iOS preparation. status is read-only and never starts or installs. start-appium reuses a healthy exact endpoint or owns one foreground child; ready means serviceResponding only, not deviceReady. build-ios-wda inspects/reuses valid WDA and builds only with explicit signing authorization. Use taskId:null for current inspection or new work; poll only a returned taskId with status. Wait timeout never restarts work. No arbitrary commands, phone actions, Team selection or endpoint fallback.',
    executionMode: 'sequential',
    parameters,
    prepareArguments(args) {
      const taskId = args && typeof args === 'object' && 'taskId' in args ? args.taskId : undefined;
      // Pi 0.87 converts "" into null before schema checking. Enforce
      // this field's raw schema constraints first, never coerce an invalid ID.
      if (
        taskId !== null &&
        taskId !== undefined &&
        (typeof taskId !== 'string' || !/\S/.test(taskId))
      )
        throw new Error(
          'Validation failed for tool "prepare_mobile": taskId must be null or a nonempty, nonblank returned taskId.',
        );
      // The Agent loop validates all remaining fields against parameters next.
      return args as Static<typeof parameters>;
    },
    async execute(_id, input, signal) {
      // Documented nullable wire contract for providers that supply every field.
      // Only null/undefined mean no task; invalid strings are never normalized.
      const { taskId, ...options } = input;
      const result = await preparation.execute(
        taskId === null || taskId === undefined ? options : { ...options, taskId },
        signal,
      );
      // Pi's Agent loop marks resolved tool.execute results as successful even
      // if an extra isError property is returned. Throw the safe task envelope
      // so failure/cancellation is an actual error result in the conversation.
      if (result.state === 'failed' || result.state === 'cancelled')
        throw new Error(JSON.stringify(result));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
