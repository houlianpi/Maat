import assert from "node:assert/strict";
import test from "node:test";

import { createAgentTrace } from "../src/logging/agent-trace.ts";

test("trace labels directions and summarizes images and secrets", () => {
  let output = "";
  const trace = createAgentTrace({
    enabled: true,
    write: (text) => {
      output += text;
    },
  });

  trace.value("HOST -> LLM", "TOOL RESULT", {
    content: [
      { type: "text", text: "visible" },
      { type: "image", mimeType: "image/png", data: "abcd" },
    ],
    apiKey: "do-not-print",
  });

  assert.match(output, /HOST -> LLM/);
  assert.match(output, /visible/);
  assert.match(output, /base64Characters: 4/);
  assert.match(output, /\[redacted\]/);
  assert.doesNotMatch(output, /do-not-print/);
  assert.doesNotMatch(output, /data: 'abcd'/);
});

test("trace can be disabled", () => {
  let output = "";
  const trace = createAgentTrace({
    enabled: false,
    write: (text) => {
      output += text;
    },
  });

  trace.text("LLM -> HOST", "ASSISTANT MESSAGE", "hidden");
  assert.equal(output, "");
});
