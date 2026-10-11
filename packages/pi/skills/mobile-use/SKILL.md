---
name: mobile-use
description: 'Operate Android apps reliably with Maat in Pi: use isolated exe_js calls, bounded scrolling, current UI observations, and safe recovery from unexpected navigation or gesture results.'
---

# Operate the phone from current state

Use this workflow for multi-step Android UI tasks after `check_device_ready`
succeeds.

## Execution boundaries

- Every `exe_js` call is isolated. Variables, functions and assignments from an
  earlier call do not exist in the next call. Put all helpers needed by an action
  in that call, or use a runtime global listed by `list_platforms`.
- `driver` and `browser` are the same attached WebdriverIO client. Use
  `driver.$()` and `driver.$$()`; there are no global `$` or `$$`.
- Await every operation. Emit a compact observation with `console.log()` or
  `evidence.screenshot()` when needed.

## Scroll without overshooting

Keep the complete gesture in the current `exe_js` call. Derive coordinates from
the current viewport and keep the drag in the center of the screen:

```javascript
const { x, y, width, height } = await driver.getWindowRect();
await driver.execute('mobile: dragGesture', {
  startX: Math.round(x + width * 0.5),
  startY: Math.round(y + height * 0.68),
  endX: Math.round(x + width * 0.5),
  endY: Math.round(y + height * 0.43),
  speed: 600,
});
await evidence.screenshot();
```

For precise reading, move about 20% to 28% of the viewport at a time. Keep both
points away from screen edges.

- Observe after every scroll and compare the current screen with the previous
  observation. Do not queue several blind gestures.
- Do not use `mobile: swipeGesture` for precise reading; its inertia can skip
  content.
- Do not drag into screen edges or hold near an edge. Vendor navigation,
  assistants or content portals may intercept those gestures.
- If a gesture opens another App or system page, stop. Observe the foreground
  state, return without accepting terms or changing settings, then reread the
  target App. Never repeat the gesture blindly.

## Recovery

Maat classifies execution failures for the model. A compile/validation failure
has `actionState: not-started` and may be corrected and retried. A runtime,
timeout or aborted failure has `actionState: uncertain`: reread the current
foreground App and UI before deciding what to do next. Do not replay a click,
input, send, purchase or delete action that may already have executed.
