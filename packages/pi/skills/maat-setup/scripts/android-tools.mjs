#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { parseArgs, promisify } from 'node:util';
import {
  assertAdbServerCompatible,
  prepareAndroidTools,
  resolveAndroidTools,
  resolveAppiumCommand,
} from '@houlianpi/maat-core';

const exec = promisify(execFile);

function summary(tools) {
  return {
    source: tools.source,
    ...(tools.warnings?.length ? { warnings: tools.warnings } : {}),
    adbAvailable: Boolean(tools.adbPath),
    aapt2Available: Boolean(tools.aapt2Path),
    toolchainReady: Boolean(tools.sdkRoot && tools.adbPath && tools.aapt2Path),
  };
}

async function portOccupied(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1500, () => {
      socket.destroy();
      reject(new Error('Could not determine whether the local Appium port is available.'));
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'accept-sdk-license': { type: 'boolean' },
      port: { type: 'string', default: '4723' },
    },
    strict: true,
  });
  const command = positionals[0] ?? 'status';
  if (positionals.length > 1 || !['status', 'prepare', 'adb', 'appium'].includes(command))
    throw new Error(
      'Usage: android-tools.mjs status | prepare [--accept-sdk-license] | adb | appium [--port PORT]',
    );
  if (values['accept-sdk-license'] && command !== 'prepare')
    throw new Error('--accept-sdk-license applies only to explicitly authorized tool preparation.');

  if (command === 'prepare') {
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error('Android tool preparation cancelled.'));
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    try {
      const tools = await prepareAndroidTools({
        acceptSdkLicense: values['accept-sdk-license'] === true,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]),
        onProgress: (event) => console.error(JSON.stringify({ preparation: event })),
      });
      if (!summary(tools).toolchainReady)
        throw new Error('Android preparation did not produce usable ADB and AAPT2 tools.');
      console.log(JSON.stringify({ ...summary(tools), prepared: true }));
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
    return;
  }
  const tools = await resolveAndroidTools();
  if (command === 'status') {
    console.log(JSON.stringify(summary(tools)));
    return;
  }
  if (command === 'adb') {
    if (!tools.adbPath) throw new Error('ADB is missing. Run the authorized prepare step first.');
    const signal = AbortSignal.timeout(10_000);
    await assertAdbServerCompatible(tools.adbPath, signal);
    await exec(tools.adbPath, ['start-server'], {
      env: { ...process.env, ...tools.environment },
      timeout: 10_000,
      signal,
      maxBuffer: 128 * 1024,
    });
    console.log(
      JSON.stringify({ adbConnectionServiceStarted: true, phoneReadinessChecked: false }),
    );
    return;
  }
  if (!summary(tools).toolchainReady)
    throw new Error(
      'Android connection tools are incomplete. Run the authorized prepare step first.',
    );
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Appium port must be an integer between 1 and 65535.');

  if (await portOccupied(port)) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(3000),
      });
      const body = await response.json();
      if (!response.ok || body?.value?.ready !== true) throw new Error('No ready Appium response.');
    } catch (error) {
      throw new Error(
        'APPIUM_PORT_IN_USE: the port is occupied, but no ready Appium service was confirmed. Check existing startup work; do not restart or kill it.',
        { cause: error },
      );
    }
    console.log(
      JSON.stringify({
        serviceAlreadyRunning: true,
        existingServiceReconfigured: false,
        phoneReadinessChecked: false,
      }),
    );
    return;
  }

  const appium = await resolveAppiumCommand();
  const child = spawn(
    appium.file,
    [...appium.args, '--address', '127.0.0.1', '--port', String(port), '--log-level', 'warn'],
    {
      env: { ...process.env, ...tools.environment },
      stdio: 'inherit',
    },
  );
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', (error) =>
        reject(
          error.code === 'ENOENT'
            ? new Error(
                'Appium is not installed. Prepare it with the host tools before starting the service.',
                { cause: error },
              )
            : error,
        ),
      );
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    process.exitCode = exitCode;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
