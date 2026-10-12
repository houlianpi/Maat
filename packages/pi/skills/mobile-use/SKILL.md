---
name: mobile-use
description: 'Operate Android and iPhone apps through LLM-generated Appium JavaScript in exe_js: control-first targeting, conditional visual-coordinate fallback, platform-correct input and scrolling, list reading, and safe recovery.'
---

# Operate the phone from current state

Use this workflow for Android and iPhone UI tasks after `check_device_ready`
succeeds. The host LLM chooses each operation from current observations and
generates its Appium JavaScript. This Skill supplies strategies, not fixed App
navigation or collection scripts.

## iOS boundaries

For a physical iPhone, first follow the iOS section of `maat-setup` and obtain
actual readiness observations. The input, gesture and Back examples marked below are
Android-only: do not use UiAutomator2 `mobile: type`, `clickGesture`,
`dragGesture`, `swipeGesture`, shell input or `driver.back()` as iOS APIs.
Use only the selected XCUITest adapter's supported APIs and current observed
elements, such as element text input or an observed in-App navigation control.
Do not invent an iOS gesture/input API or reuse stale coordinates.
Input authorization is not send authorization on either platform.

Use a base iPhone Session without `app`/`bundleId` target capabilities and
activate a known bundle identifier separately. Keep the same isolation,
observation, no-replay and privacy boundaries below. Keep the phone Session
while waiting for user unlock/authorization if more phone work remains; call
`release_device_session` only when this conversation no longer needs the phone.
Never stop user-managed Appium/WDA or reset data as cleanup.

## Execution boundaries

- Use `exe_js` for all phone UI observation and interaction. Do not use host
  shell phone commands, direct WDA/Appium HTTP clients or temporary operation
  channels instead. This is a UI-only boundary: host tools remain available for
  authorized preparation and platform-native non-UI work, including Android file
  transfers. Readiness and resource cleanup remain Maat infrastructure.
- Every `exe_js` call is isolated. Variables, functions and assignments from an
  earlier call do not exist in the next call. Put all helpers needed by an action
  in that call, or use a runtime global listed by `list_platforms`.
- `driver` and `browser` are the same attached WebdriverIO client. Use
  `driver.$()` and `driver.$$()`; there are no global `$` or `$$`.
- Await every operation. Emit a compact observation with `console.log()` or
  `evidence.screenshot()` when needed.
- WebdriverIO element arrays have asynchronous collection methods. Use an
  awaited loop or await the collection method's result; do not pass an unresolved
  asynchronous `elements.map(...)` result into `Promise.all`.

## Android file transfers

User-requested transfers between the selected Android device and the computer
may use the existing ADB through host tools: `adb push` copies to the device,
and `adb pull` copies to the computer. File transfer is not UI interaction and
does not need to be forced through `exe_js`. ADB is not an iOS capability.
Transfers require an authorized ADB connection, not an Appium Session or
`check_device_ready`; do not start UI automation merely to copy a file.

Establish the requested files, direction and source/destination paths; bind the
exact selected device rather than relying on ADB's default device. Preserve
unrelated files and ask before an overwrite not already authorized by the task.
Check command status and verify the destination file using size or a checksum
when available. Report permission, connection or transfer failures explicitly;
do not claim a file was transferred merely because the command was issued.

## Own the connection, not the App

Create a base Android Session without `appPackage`, `appActivity` or `app`
capabilities. Launch the requested App separately through `exe_js`:
`await driver.activateApp(packageId)` when its package is known, or use the
observed launcher/search UI when it is not. A package ID used for activation
does not bind that App to the Session. If the selected runtime cannot launch
the App, report the missing capability; do not bypass `exe_js` with ADB or an
ad-hoc phone client, and never switch devices.

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
   Query a specific target with `driver.$()`/`driver.$$()` rather than repeatedly
   dumping the entire tree. For scrolling, first inspect any identified list or
   scroll container and use the platform's supported element-targeted API.
2. Only use visual absolute-coordinate actions when the JS interface cannot
   reliably obtain the tree, or the requested target genuinely exposes no usable
   control. If the tree is effectively empty, first distinguish unreadable UI
   from a failed query or extraction. A bad selector, truncated tree or parsing
   error does not prove that an App has no controls. Prefer native element
   attributes and bounds; if parsing XML, use a proper parser and exact attribute
   names, not a regex that can confuse `index` with `x`.
3. State the concrete fallback reason and capture a current screenshot. Use the
   host LLM's image understanding, not a separate recognition runtime or an
   upload to an external service. Generate the coordinate Appium JS in `exe_js`;
   return to control locators when usable. A screenshot for understanding content
   does not require abandoning a reliable control locator. Do not toggle
   accessibility settings to force an App to expose controls.

For visual targeting, identify the actual control rather than nearby text.
Map displayed-image coordinates back to the original screenshot, then to the
current driver viewport; account for resizing, rotation and offsets. Never
assume a model-visible image has the same dimensions as the device. If that
mapping or target is uncertain, obtain a better observation or ask the user.
Use a supported short tap for a visually located target, not a long press or
drag; `mobile: clickGesture` is an Android-only example, not an iOS API.
After navigation, keyboard changes or scrolling, observe again before reusing
coordinates.

These observation and fallback principles were compared with
[iPhone Use's operation workflow](https://github.com/zhongerxin/iPhone-use/tree/08ed5b00965025120f572a7635aef6698f05cf1a/skills/iphone-use)
and its native element queries. Reuse the strategy, not its controller or an
additional Maat operation interface.

## Enter Chinese text through Appium

The following input example is Android-only.

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

First use an identified scroll container and a supported element-targeted
operation. Do not turn the following coordinate example into the default
scrolling path. If no usable scroll control is exposed and coordinate fallback
is necessary, explain that limitation and identify a safe area from the current
observation. Keep the complete gesture in the current `exe_js` call.
The following bounded drag example is Android-only:

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
