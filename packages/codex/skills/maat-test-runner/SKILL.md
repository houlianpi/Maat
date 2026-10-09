---
name: maat-test-runner
description: Run saved Maat Cases or Suites, inspect structured results and Evidence, and diagnose whether failures come from setup, automation, assertions, or the product.
---

# Run and diagnose Maat tests

1. Select the Case, Suite, tag, or all-Cases scope requested by the user. Do not silently broaden it.
2. Select the owner platform, then call `maat_run_tests` with exactly one scope.
3. Call `maat_get_latest_run` and inspect the structured result. Inspect relevant Evidence before concluding.
4. Classify failures as setup/environment, Session lifecycle, locator/timing, assertion mismatch, or likely product behavior. Preserve uncertainty when Evidence is insufficient.
5. Do not weaken an expected outcome to make a test pass. Do not implement a fix unless requested.
6. Report the run directory and the most important failure evidence.

Read [references/diagnosis.md](references/diagnosis.md) for classification criteria.
