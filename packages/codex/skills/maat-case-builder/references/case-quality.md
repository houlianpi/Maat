# Formal Case quality

Keep deterministic business actions, stable locators, user-requested assertions, and relevant Evidence.

Remove DOM/page-source/UI-tree dumps, locator inventories, duplicated Fixture setup, local paths, credentials, fixed device IDs, and sleeps used instead of framework waits.

Saved Cases use Mocha `beforeEach`/`afterEach`; Fixtures own Session setup, Evidence finalization, App termination, and teardown.
