import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = path.resolve("bin/maat.mjs");

test("maat shows command help", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "--help"]);

  assert.match(stdout, /Maat - conversational UI verification/);
  assert.match(stdout, /maat test --suite smoke/);
  assert.match(stdout, /maat appium doctor/);
  assert.match(stdout, /maat appium install TARGET/);
});

test("maat rejects unknown commands", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "unknown"]),
    /Unknown command: unknown/,
  );
});

test("maat test dispatches the Case runner and preserves failure status", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli,
      "test",
      "--case",
      "does-not-exist",
    ]),
    /Unknown Case: does-not-exist/,
  );
});
