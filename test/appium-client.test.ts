import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import { AppiumClient, AppiumProtocolError } from "../src/appium/appium-client.ts";
import { defaultCapabilities } from "../src/appium/types.ts";

type RequestLog = { method?: string; url?: string; body?: unknown };

async function readBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body ? JSON.parse(body) : undefined;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ value }));
}

test("Appium client implements W3C session, element, source, screenshot, and actions", async () => {
  const requests: RequestLog[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method, url: request.url, body });
    if (request.url === "/session") {
      send(response, 200, { sessionId: "session-1", capabilities: { platformName: "Mac" } });
    } else if (request.url === "/session/session-1/element") {
      send(response, 200, { "element-6066-11e4-a52e-4f735466cecf": "element-1" });
    } else if (request.url === "/session/session-1/element/element-1/text") {
      send(response, 200, "Hello");
    } else if (request.url === "/session/session-1/element/element-1/displayed") {
      send(response, 200, true);
    } else if (request.url === "/session/session-1/source") {
      send(response, 200, "<App/>");
    } else if (request.url === "/session/session-1/screenshot") {
      send(response, 200, Buffer.from("png").toString("base64"));
    } else {
      send(response, 200, null);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const client = new AppiumClient(`http://127.0.0.1:${address.port}/`);

  try {
    const session = await client.createSession(defaultCapabilities("macos"));
    assert.equal(session.sessionId, "session-1");
    const elementId = await client.findElement("accessibility id", "Greeting");
    assert.equal(elementId, "element-1");
    await client.click(elementId);
    await client.setValue(elementId, "World");
    assert.equal(await client.getText(elementId), "Hello");
    assert.equal(await client.isDisplayed(elementId), true);
    assert.equal(await client.getPageSource(), "<App/>");
    assert.equal(await client.takeScreenshot(), Buffer.from("png").toString("base64"));
    await client.tap(10, 20);
    await client.deleteSession();

    const create = requests.find((item) => item.url === "/session");
    assert.deepEqual(
      (create?.body as { capabilities: { alwaysMatch: unknown } }).capabilities.alwaysMatch,
      defaultCapabilities("macos"),
    );
    assert.ok(requests.some((item) => item.url === "/session/session-1/actions"));
    assert.ok(
      requests.some(
        (item) =>
          item.url === "/session/session-1/element/element-1/value" &&
          (item.body as { text?: string }).text === "World",
      ),
    );
  } finally {
    server.close();
  }
});

test("Appium client exposes protocol errors", async () => {
  const server = createServer((_request, response) => {
    send(response, 500, { error: "session not created", message: "Driver missing" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const client = new AppiumClient(`http://127.0.0.1:${address.port}/`);

  try {
    await assert.rejects(
      client.createSession(defaultCapabilities("android")),
      (error: unknown) =>
        error instanceof AppiumProtocolError &&
        error.status === 500 &&
        error.message === "Driver missing",
    );
  } finally {
    server.close();
  }
});

test("platform capability templates select official Appium drivers", () => {
  assert.equal(defaultCapabilities("android")["appium:automationName"], "UiAutomator2");
  assert.equal(defaultCapabilities("ios")["appium:automationName"], "XCUITest");
  assert.equal(defaultCapabilities("macos")["appium:automationName"], "Mac2");
});
