# Platform setup routing

- Web: configure a supported browser; Appium is not required.
- Android: use Appium with UiAutomator2 and an online authorized device. Preserve App data unless reset is explicit.
- iOS: use Appium with XCUITest. Trust, Developer Mode, signing, and WDA may require the user.
- macOS: use Appium Mac2. Accessibility and UI interaction are required; screenshot Evidence may additionally require Screen Recording.

Never persist device IDs, signing identities, credentials, or browser profile paths in Cases.
