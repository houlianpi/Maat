import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  inspectIosWda,
  prepareIosWda,
  runIosWdaCommand,
  resolveIosWdaReuse,
} from '../packages/core/src/setup/ios-wda.ts';

const certificate = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIICrjCCAZYCCQCHqeOa6IxrYTANBgkqhkiG9w0BAQsFADAZMRcwFQYDVQQDDA5t
YWF0LXRlc3Qtb25seTAeFw0yNjEwMTIwMTE0MjVaFw0zNjEwMDkwMTE0MjVaMBkx
FzAVBgNVBAMMDm1hYXQtdGVzdC1vbmx5MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEAp3Dvse7sfJP3U01IOtwPs+HrFnbizm0KBZ/IfBVY+YgSrwrNOK80
6ZKYzGR+M7C3pjCsvRTJr0MfnVfsHPhKuX6cy7kJYxmCicDxlI4Az1rVOosrgafo
QL5KT4XYLllJ4sbqlfH8q+sdY2+E3X+WEaqwpeBKd/krersywweMMSYwewSvXC6m
5VjUXnLjW6LM/wMV/sqx0rzq0zcwKSN9YFiqQrtaMEixY3fB8/1IVldjig7Tha02
rHld2RRJJv/+pWRwGGpsnbQ3VagNesHkdW+qn4CuCTFRMcsb5Of/ZlrRFlVbZpPM
jfJOTXMa9Hs1AhXdFamDMDW5mPgUwTGtJQIDAQABMA0GCSqGSIb3DQEBCwUAA4IB
AQAvTvGMlSvdcP3YniSYUJf+T6QHaoP1uJgJhhDo5h6UMNQW0nnL+0+gc65QIQOw
7KJMYqFvYkWrsRedt259U4ePmDRUjl9kTc6c7YFvNTGwRsa5H5Kue50mfXRcTL5e
j35H2loRUZ7y3Xh0vP78VgS2IgDABeYiQNBkT+bG1oY0NZpiHJzxnPE4BOvWGB8N
f4zs6ZTB1OqiDDkbl4VC8j5vcz9jDitNi4P1uK6huW23GBvHk0mW7QVKdyiwOORS
aXMLs8RNt//YoobpjVRkUrIXfLl/KyECUkog4L+wZNVDC+8H50Jhmob74YIpLViO
n/+hTwKQSlEdvSusxiJTXTcF
-----END CERTIFICATE-----`);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-wda-test-'));
  const project = path.join(root, 'WebDriverAgent.xcodeproj');
  const build = path.join(root, 'build');
  const app = path.join(
    build,
    'Build',
    'Products',
    'Debug-iphoneos',
    'WebDriverAgentRunner-Runner.app',
  );
  await mkdir(project, { recursive: true });
  await mkdir(app, { recursive: true });
  await writeFile(path.join(project, 'project.pbxproj'), 'existing signing configuration');
  await writeFile(path.join(app, 'embedded.mobileprovision'), 'test-only');
  const calls: string[][] = [];
  const flags = {
    team: 'EXISTING_TEAM',
    bundle: 'com.example.wda',
    expires: '2028-01-01T00:00:00Z',
    certificateMatches: true,
    includesDevice: true,
    signatureFailure: false,
    mutateProject: false,
    cachedExpires: '',
    profileIdentifier: 'LEGACY_PREFIX.com.example.wda.xctrunner',
    installed: true,
    installationReadFailed: false,
    otherRunner: false,
    emptyMetadata: false,
  };
  const deps: NonNullable<Parameters<typeof inspectIosWda>[1]> = {
    hostPlatform: 'darwin',
    cacheRoot: root,
    project: async () => project,
    now: () => Date.parse('2027-01-01T00:00:00Z'),
    devices: async () => [
      {
        id: 'PRIVATE_PHONE',
        name: 'Test iPhone',
        kind: 'device',
        connected: true,
        paired: true,
        developerMode: 'enabled',
      },
    ],
    command: async (file, args, options) => {
      options.signal?.throwIfAborted();
      calls.push([file, ...args]);
      if (file === 'xcrun') {
        if (flags.installationReadFailed)
          throw new Error('PRIVATE_PHONE installed inspection failed');
        assert.equal(args[args.indexOf('--device') + 1], 'PRIVATE_PHONE');
        return JSON.stringify({
          result: {
            apps: [
              ...(flags.installed
                ? [
                    {
                      name: 'WebDriverAgentRunner-Runner',
                      bundleIdentifier: `${flags.bundle}.xctrunner`,
                    },
                  ]
                : []),
              ...(flags.otherRunner
                ? [{ name: 'Other Runner', bundleIdentifier: 'com.other.xctrunner' }]
                : []),
              ...(flags.emptyMetadata ? [{ name: '', bundleIdentifier: '' }] : []),
            ],
          },
        });
      }
      if (file === 'xcodebuild' && args.includes('-showBuildSettings'))
        return `Build settings for action build and target WebDriverAgentRunner:\n DEVELOPMENT_TEAM = ${flags.team}\n PRODUCT_BUNDLE_IDENTIFIER = ${flags.bundle}\n BUILD_DIR = ${path.join(build, 'Build', 'Products')}\n`;
      if (file === 'plutil')
        return JSON.stringify({ CFBundleIdentifier: `${flags.bundle}.xctrunner` });
      if (file === 'security')
        return `<plist><dict>
<key>CreationDate</key><date>2026-12-31T00:00:00Z</date>
<key>ExpirationDate</key><date>${flags.cachedExpires && !args.at(-1)!.startsWith(app + path.sep) ? flags.cachedExpires : flags.expires}</date>
<key>ProvisionedDevices</key><array><string>${flags.includesDevice ? 'PRIVATE_PHONE' : 'OTHER_PHONE'}</string></array>
<key>TeamIdentifier</key><array><string>EXISTING_TEAM</string></array>
<key>ApplicationIdentifierPrefix</key><array><string>LEGACY_PREFIX</string></array>
<key>DeveloperCertificates</key><array><data>${flags.certificateMatches ? certificate.raw.toString('base64') : 'AAAA'}</data></array>
<key>Entitlements</key><dict><key>application-identifier</key><string>${flags.profileIdentifier}</string></dict>
</dict></plist>`;
      if (file === 'codesign' && args.includes('--verify')) {
        if (flags.signatureFailure)
          throw new Error('IOS_WDA_COMMAND_FAILED: signature verification failed.');
        return '';
      }
      if (file === 'codesign' && args.some((arg) => arg.startsWith('--extract-certificates='))) {
        const prefix = args
          .find((arg) => arg.startsWith('--extract-certificates='))!
          .slice('--extract-certificates='.length);
        await writeFile(`${prefix}0`, certificate.raw);
        return '';
      }
      if (file === 'xcodebuild' && args.includes('build-for-testing')) {
        flags.expires = '2028-01-01T00:00:00Z';
        if (flags.mutateProject)
          await writeFile(path.join(project, 'project.pbxproj'), 'unexpected signing change');
        return '';
      }
      throw new Error('Unexpected test command.');
    },
  };
  const input = {
    device: { kind: 'device' as const, name: 'Test iPhone' },
    capabilities: { 'appium:derivedDataPath': build },
  };
  return { root, app, project, flags, calls, deps, input };
}

test('WDA inspection reuses paid-year and free-week profiles without assuming validity from the certificate', async () => {
  const f = await fixture();
  try {
    for (const expires of ['2028-01-01T00:00:00Z', '2027-01-07T00:00:00Z']) {
      f.flags.expires = expires;
      const result = await inspectIosWda(f.input, f.deps);
      assert.equal(result.state, 'ready');
      assert.equal(result.profile?.expiresAt, expires.replace('Z', '.000Z'));
      assert.equal(result.certificate?.expired, false);
      assert.equal(result.capabilities?.['appium:usePrebuiltWDA'], true);
      const { capabilities: _caps, ...facts } = result;
      assert.doesNotMatch(
        JSON.stringify(facts),
        /PRIVATE_PHONE|EXISTING_TEAM|LEGACY_PREFIX|maat-wda-test-/,
      );
      assert.equal(
        (await prepareIosWda({ ...f.input, signingAuthorized: false }, f.deps)).state,
        'ready',
      );
    }
    assert.equal(
      f.calls.some((args) => args.includes('build-for-testing')),
      false,
    );
    const discovered = await inspectIosWda({ device: f.input.device }, f.deps);
    assert.equal(discovered.state, 'ready');
    assert.equal(
      discovered.capabilities?.['appium:derivedDataPath'],
      f.input.capabilities['appium:derivedDataPath'],
    );
    f.flags.expires = '2026-12-31T12:00:00Z';
    const expired = await inspectIosWda(f.input, f.deps);
    assert.equal(expired.state, 'expired');
    assert.equal(expired.profile?.expired, true);
    assert.equal(expired.certificate?.expired, false);
    assert.equal(expired.capabilities, undefined);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('normal WDA reuse verifies phone installation without signing; first installation requires permission', async () => {
  const f = await fixture();
  try {
    const caps = await resolveIosWdaReuse(f.input, false, f.deps);
    assert.equal(caps['appium:usePrebuiltWDA'], true);
    for (const key of [
      'prebuildWDA',
      'useSimpleBuildTest',
      'useXctestrunFile',
      'allowProvisioningUpdates',
      'allowProvisioningDeviceRegistration',
    ])
      assert.equal(caps[`appium:${key}`], false);
    assert.equal(
      f.calls.some(
        (args) =>
          args.includes('build-for-testing') || args.includes('install') || args.includes('launch'),
      ),
      false,
    );
    f.flags.installed = false;
    await assert.rejects(
      resolveIosWdaReuse(f.input, false, f.deps),
      /INSTALLATION_AUTHORIZATION_REQUIRED/,
    );
    assert.equal((await resolveIosWdaReuse(f.input, true, f.deps))['appium:usePrebuiltWDA'], true);
    f.flags.expires = '2026-12-31T00:00:00Z';
    await assert.rejects(resolveIosWdaReuse(f.input, true, f.deps), /SIGNING_REQUIRED/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('WDA reuse refuses unknown installation, other runners and conflicting identity before startup', async () => {
  const f = await fixture();
  try {
    f.flags.installationReadFailed = true;
    await assert.rejects(resolveIosWdaReuse(f.input, false, f.deps), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /IOS_WDA_INSPECTION_FAILED/);
      assert.doesNotMatch(error.message, /PRIVATE_PHONE/);
      return true;
    });
    f.flags.installationReadFailed = false;
    f.flags.emptyMetadata = true;
    await assert.rejects(resolveIosWdaReuse(f.input, true, f.deps), /INSPECTION_FAILED/);
    f.flags.emptyMetadata = false;
    f.flags.otherRunner = true;
    await assert.rejects(resolveIosWdaReuse(f.input, true, f.deps), /CONFIGURATION_CONFLICT/);
    f.flags.otherRunner = false;
    for (const capabilities of [
      { ...f.input.capabilities, 'appium:udid': 'OTHER_PHONE' },
      { ...f.input.capabilities, 'appium:xcodeOrgId': 'OTHER_TEAM' },
      { ...f.input.capabilities, 'appium:options': { updatedWDABundleId: 'com.other.wda' } },
    ])
      await assert.rejects(
        resolveIosWdaReuse({ ...f.input, capabilities }, false, f.deps),
        /IDENTITY_CONFLICT/,
      );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('expired WDA builds require explicit renewal and preserve the existing project and device', async () => {
  const f = await fixture();
  try {
    f.flags.expires = '2026-12-31T00:00:00Z';
    await assert.rejects(
      prepareIosWda({ ...f.input, signingAuthorized: false }, f.deps),
      /AUTHORIZATION_REQUIRED/,
    );
    assert.equal(
      f.calls.some((args) => args.includes('build-for-testing')),
      false,
    );
    const result = await prepareIosWda({ ...f.input, signingAuthorized: true }, f.deps);
    assert.equal(result.state, 'ready');
    const build = f.calls.find((args) => args.includes('build-for-testing'))!;
    assert.ok(build.includes('id=PRIVATE_PHONE'));
    assert.ok(build.includes('-allowProvisioningUpdates'));
    assert.equal(
      build.some((arg) => /DEVELOPMENT_TEAM=|PRODUCT_BUNDLE_IDENTIFIER=/.test(arg)),
      false,
    );
    assert.equal(
      await readFile(path.join(f.project, 'project.pbxproj'), 'utf8'),
      'existing signing configuration',
    );
    f.flags.expires = '2026-12-31T00:00:00Z';
    f.flags.mutateProject = true;
    await assert.rejects(
      prepareIosWda({ ...f.input, signingAuthorized: true }, f.deps),
      /SIGNING_CHANGED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('an expired implicit cache cannot hide a valid Xcode build; explicit paths never fall back', async () => {
  const f = await fixture();
  try {
    const key = createHash('sha256')
      .update(`${f.project}\0EXISTING_TEAM\0com.example.wda`)
      .digest('hex')
      .slice(0, 20);
    const cached = path.join(f.root, key);
    const cachedApp = path.join(
      cached,
      'Build',
      'Products',
      'Debug-iphoneos',
      'WebDriverAgentRunner-Runner.app',
    );
    await mkdir(cachedApp, { recursive: true });
    await writeFile(path.join(cachedApp, 'embedded.mobileprovision'), 'old-cache');
    f.flags.cachedExpires = '2026-12-31T00:00:00Z';
    const result = await prepareIosWda(
      { device: f.input.device, signingAuthorized: false },
      f.deps,
    );
    assert.equal(result.state, 'ready');
    assert.equal(
      result.capabilities?.['appium:derivedDataPath'],
      f.input.capabilities['appium:derivedDataPath'],
    );
    assert.equal(
      f.calls.some((args) => args.includes('build-for-testing')),
      false,
    );
    await assert.rejects(
      prepareIosWda(
        {
          device: f.input.device,
          capabilities: { 'appium:derivedDataPath': cached },
          signingAuthorized: false,
        },
        f.deps,
      ),
      /AUTHORIZATION_REQUIRED/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('WDA mismatched device or missing Team asks for signing without selecting another identity', async () => {
  const f = await fixture();
  try {
    f.flags.includesDevice = false;
    assert.equal((await inspectIosWda(f.input, f.deps)).state, 'needs-signing');
    assert.equal(
      (await prepareIosWda({ ...f.input, signingAuthorized: true }, f.deps)).state,
      'needs-signing',
    );
    assert.equal(
      f.calls.some((args) => args.includes('build-for-testing')),
      false,
    );
    f.flags.team = '';
    assert.equal((await inspectIosWda(f.input, f.deps)).signingConfigured, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('WDA invalid signatures, certificate membership, missing build and Abort remain explicit', async () => {
  const f = await fixture();
  try {
    f.flags.signatureFailure = true;
    await assert.rejects(inspectIosWda(f.input, f.deps), /COMMAND_FAILED/);
    f.flags.signatureFailure = false;
    f.flags.certificateMatches = false;
    await assert.rejects(inspectIosWda(f.input, f.deps), /IDENTITY_CONFLICT/);
    f.flags.certificateMatches = true;
    f.flags.profileIdentifier = 'LEGACY_PREFIX.other.com.example.wda.xctrunner';
    await assert.rejects(inspectIosWda(f.input, f.deps), /IDENTITY_CONFLICT/);
    f.flags.profileIdentifier = 'LEGACY_PREFIX.com.example.wda.xctrunner';
    await rm(path.join(f.app, 'embedded.mobileprovision'));
    assert.equal((await inspectIosWda(f.input, f.deps)).state, 'missing');
    const controller = new AbortController();
    controller.abort(new Error('stop preparation'));
    const count = f.calls.length;
    await assert.rejects(
      inspectIosWda({ ...f.input, signal: controller.signal }, f.deps),
      /stop preparation/,
    );
    assert.equal(f.calls.length, count);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test(
  'WDA command cleanup still kills owned descendants after the parent closes',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'maat-wda-tree-'));
    let pid: number | undefined;
    const alive = () => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    try {
      const marker = path.join(root, 'descendant.pid');
      const descendant = `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`;
      const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore"});setInterval(()=>{},1000);`;
      const controller = new AbortController();
      const pending = runIosWdaCommand(process.execPath, ['-e', parent], {
        timeout: 5000,
        signal: controller.signal,
      });
      const rejection = assert.rejects(pending, /PREPARATION_CANCELLED/);
      for (let attempt = 0; attempt < 100 && !pid; attempt++) {
        try {
          pid = Number(await readFile(marker, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      assert.ok(pid);
      assert.equal(alive(), true);
      controller.abort();
      await rejection;
      for (let attempt = 0; attempt < 100 && alive(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(alive(), false);
    } finally {
      if (alive()) process.kill(pid!, 'SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'owned WDA commands bound output, cancellation and deadline without leaking stderr',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    assert.equal(
      await runIosWdaCommand(process.execPath, ['-e', 'console.log("probe");'], { timeout: 2000 }),
      'probe\n',
    );
    await assert.rejects(
      runIosWdaCommand(
        process.execPath,
        ['-e', 'console.error("PRIVATE_ACCOUNT");process.exit(2);'],
        { timeout: 2000 },
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exited with 2/);
        assert.doesNotMatch(error.message, /PRIVATE_ACCOUNT/);
        return true;
      },
    );
    const began = Date.now();
    await assert.rejects(
      runIosWdaCommand(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { timeout: 100 }),
      /PREPARATION_TIMEOUT/,
    );
    assert.ok(Date.now() - began < 2000);
    const controller = new AbortController();
    const pending = runIosWdaCommand(process.execPath, ['-e', 'setInterval(()=>{},1000);'], {
      timeout: 5000,
      signal: controller.signal,
    });
    controller.abort(new Error('user stopped'));
    await assert.rejects(pending, /PREPARATION_CANCELLED/);
    await assert.rejects(
      runIosWdaCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(3*1024*1024));'], {
        timeout: 2000,
      }),
      /OUTPUT_LIMIT/,
    );
  },
);
