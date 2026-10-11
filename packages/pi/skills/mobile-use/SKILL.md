---
name: mobile-use
description: 'Operate Android apps reliably with Maat in Pi: Chinese and Unicode text input through Appium, accessibility-first targeting with visual fallback, calibrated scrolling, isolated exe_js calls, and safe recovery from unexpected menus or navigation.'
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

## Own the connection, not the App

Create a base Android Session without `appPackage`, `appActivity` or `app`
capabilities. Launch the requested App separately through `exe_js`:
`await driver.activateApp(packageId)` when its package is known, or use the
observed launcher/search UI when it is not. A package ID used for activation
does not bind that App to the Session. Use host-authorized ADB only when the
existing runtime cannot perform the required launch; never switch devices.

When this conversation no longer needs phone interaction, call
`release_device_session` before the final reply, including when phone work is
explicitly abandoned. It releases the owned Worker/Session, not the Pi
conversation or external Appium/ADB services. Android cleanup does not explicitly
terminate the foreground App; normal no-reset use retains its page and login.
Do not reset App data to release a connection.

Keep the connection while waiting for a user action or clarification if the
task still requires more phone work. A reply, screenshot, successful action or
business summary alone is not a reliable release boundary. If later phone work
is requested after release, check the channel and observe current state again;
do not replay previous actions. Report cleanup failure explicitly rather than
claiming resources were released.

## Choose controls before visual coordinates

1. Read the current accessibility tree and use a visible, unambiguous element
   when its label, resource ID, bounds and state support the intended action.
2. If the target is missing, ambiguous, has unusable bounds or the tree is
   effectively empty, capture a current screenshot and use visual recognition.
   A nonempty tree is not necessarily sufficient for the specific target.
   Do not repeatedly dump the same unhelpful tree or toggle accessibility
   settings to force an App to expose controls.
3. Use the host model's image understanding. Use OCR or another recognition
   tool only if already available and permitted; do not invent an image
   recognition API, install another runtime or upload private screenshots to
   an external service.

For visual targeting, identify the actual control rather than nearby text.
Map displayed-image coordinates back to the original screenshot, then to the
current driver viewport; account for resizing, rotation and offsets. Never
assume a model-visible image has the same dimensions as the device. If that
mapping or target is uncertain, obtain a better observation or ask the user.
Use a short `mobile: clickGesture` for a visually located target, not a long
press or drag. After navigation, keyboard changes or scrolling, observe again
before reusing coordinates.

## Enter Chinese text through Appium

For Chinese and other Unicode text, prefer the Appium UiAutomator2 input
method, not clipboard/paste or shell `input text`. First focus the intended
editable field using a current element or a verified short tap. Then, within
the user's authorization:

```javascript
await driver.execute('mobile: type', { text: '你好' });
```

The example text is illustrative; enter only the text requested by the user.
`mobile: type` types into the focused field and does not guarantee replacement
of existing text. Inspect any draft first; do not clear it, append a duplicate
or change the system keyboard configuration without understanding the impact.

- A successful command means text was handed to the input channel, not that
  the intended field contains the correct text. Read its value back through a
  usable element, or inspect a current screenshot if the tree is insufficient.
- Verify the exact requested text and intended recipient or destination before
  any authorized send/submit action. Input authorization is not send authorization.
- Do not try clipboard transport first for Chinese. If an earlier attempt
  produced replacement characters, mojibake or unexpected text, stop before
  sending; inspect the actual draft and correct only the affected input within
  authorization. Do not assume a base64 clipboard payload proves the UI text.
- If `mobile: type` is unsupported or fails, report that failure and reread the
  field before choosing another supported Appium input method. Do not silently
  fall back to clipboard, replay uncertain input or reinstall helpers.

## Scroll without overshooting

Keep the complete gesture in the current `exe_js` call. Derive coordinates from
the current viewport and a safe scrollable content area. Prefer an area whose
bounds are exposed by the current tree; otherwise locate it visually. The
following center-screen example is only a starting point when those points are
inside the observed scrollable area:

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
points away from screen edges, navigation bars, image tiles, selectable text
and interactive controls. A fixed speed or distance cannot guarantee no inertia
or long-press interception on every device.

- Observe after every scroll and compare the current screen with the previous
  observation. Do not queue several blind gestures.
- Do not use `mobile: swipeGesture` for precise reading; its inertia can skip
  content.
- Do not drag into screen edges or hold near an edge. Vendor navigation,
  assistants or content portals may intercept those gestures.
- Keep overlap between observations when reading a feed. If content was
  skipped, make one smaller reverse movement and reread it; reduce distance
  before continuing. Do not repeatedly jump to the top or queue a long
  recovery loop.
- Wait for the view to settle with supported driver waits and a bounded budget,
  not an assumed `setTimeout` global. If the view does not change, diagnose the
  scroll area or end of content before repeating a gesture.

## Recover from intercepted gestures

An image long-press menu, text-selection menu or vendor content portal is an
unexpected interaction, not a successful scroll. Stop and inspect the current
foreground App and screenshot. Do not accept terms, enable the portal, choose
save/edit/translate/share, or continue with stale coordinates.

If the observation confirms a dismissible menu or welcome page, use one Back
action (`await driver.back()`) and reread the foreground state. Do not chain
blind Back actions: Back can also leave the target screen or discard a draft.
Resume only after confirming the intended App and screen; change the gesture
start area, distance or touch method rather than repeating the intercepted
gesture.

Report what was observed and what was verified after recovery. Returning from
a menu does not prove that all content was unchanged. Do not claim "no impact"
or "nothing was modified" without evidence covering that claim.

## Recovery

Maat classifies execution failures for the model. A compile/validation failure
has `actionState: not-started` and may be corrected and retried. A runtime,
timeout or aborted failure has `actionState: uncertain`: reread the current
foreground App and UI before deciding what to do next. Do not replay a click,
input, send, purchase or delete action that may already have executed.
