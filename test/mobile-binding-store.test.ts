import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BindingStore,
  BindingStoreError,
} from '../packages/core/src/mobile/devices/binding-store.ts';
import {
  parseDeviceBinding,
  type DeviceBinding,
} from '../packages/core/src/mobile/contracts/device.ts';
import * as publicCore from '../packages/core/src/index.ts';

const marker = 'synthetic-private-marker';
const android: DeviceBinding = {
  version: 1,
  identity: {
    platform: 'android',
    providerInstanceId: 'local-adb',
    routingId: `${marker}-serial`,
    kind: 'device',
    transportScope: 'local-adb',
    displayName: 'Synthetic Phone',
  },
  endpointId: `${marker}-endpoint`,
  displayNameAtBinding: 'Synthetic Phone',
};
const ios: DeviceBinding = {
  ...android,
  identity: {
    platform: 'ios',
    providerInstanceId: 'local-core-device',
    routingId: `${marker}-udid`,
    kind: 'device',
    transportScope: 'core-device',
  },
};
const fault = (code = 'EIO') => Object.assign(new Error(marker), { code, path: marker });

async function fixture(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'maat-binding-synthetic-'));
  try {
    await run(root, path.join(root, 'private', 'binding.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function failure(
  action: () => Promise<unknown>,
  category: BindingStoreError['category'],
  stage: BindingStoreError['stage'],
  cleanupFailures: BindingStoreError['cleanupFailures'] = [],
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof BindingStoreError);
    assert.equal(error.category, category);
    assert.equal(error.stage, stage);
    assert.deepEqual(error.cleanupFailures, cleanupFailures);
    const messages = {
      'invalid-format': 'Invalid device binding format.',
      'unsupported-version': 'Unsupported device binding version.',
      'read-failed': 'Device binding read failed.',
      'write-failed': 'Device binding write failed.',
    };
    assert.equal(error.message, messages[category]);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.doesNotMatch(
      `${error.stack}${JSON.stringify(error)}`,
      /synthetic-private-marker|maat-binding-synthetic-/,
    );
    return true;
  });
}

test('explicit store construction is inert and only missing reads are absent', async () => {
  await fixture(async (root, file) => {
    const store = new BindingStore(file);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await store.read(), { status: 'absent' });
    assert.deepEqual(await readdir(root), []);
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
      await failure(
        () =>
          new BindingStore(file, {
            readFile: async () => {
              throw fault(code);
            },
          }).read(),
        'read-failed',
        'read',
      );
    }
    await mkdir(path.dirname(file));
    await mkdir(file);
    await failure(() => store.read(), 'read-failed', 'read');
    await failure(
      () =>
        new BindingStore(file, {
          readFile: async () => {
            throw {
              get code() {
                throw fault();
              },
            };
          },
        }).read(),
      'read-failed',
      'read',
    );
  });
});

test('Android/iOS bindings persist across instances with private modes and no extra fields', async () => {
  await fixture(async (root, file) => {
    for (const binding of [android, ios]) {
      await new BindingStore(file).write(binding);
      assert.deepEqual(await new BindingStore(file).read(), parseDeviceBinding(binding));
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), binding);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
      assert.deepEqual(await readdir(path.dirname(file)), ['binding.json']);
    }
    assert.deepEqual(await readdir(root), ['private']);
  });
});

test('read format/type/version failures are not absent or silently rewritten', async () => {
  await fixture(async (_root, file) => {
    await mkdir(path.dirname(file));
    for (const [text, category] of [
      ['{broken', 'invalid-format'],
      ['null', 'invalid-format'],
      [JSON.stringify({ ...android, endpointId: 42 }), 'invalid-format'],
      [JSON.stringify({ ...android, key: marker }), 'invalid-format'],
      [
        JSON.stringify({ ...android, identity: { ...android.identity, routingId: '' } }),
        'invalid-format',
      ],
      [JSON.stringify({ ...android, version: '1' }), 'invalid-format'],
      [JSON.stringify({ ...android, version: 2 }), 'unsupported-version'],
    ] as const) {
      await writeFile(file, text);
      await failure(() => new BindingStore(file).read(), category, 'parse');
      assert.equal(await readFile(file, 'utf8'), text);
    }
  });
});

test('invalid unknown writes reject before mkdir/open and preserve absent or existing state', async () => {
  await fixture(async (root, file) => {
    let io = 0;
    const store = new BindingStore(file, {
      mkdir: async () => {
        io++;
        throw fault();
      },
      open: async () => {
        io++;
        throw fault();
      },
    });
    const invalid = [
      undefined,
      null,
      [],
      'private-input',
      { ...android, version: '1' },
      { ...android, identity: { ...android.identity, connected: true } },
      ...['sessionId', 'job', 'grant', 'logs', 'key', 'credentials'].map((field) => ({
        ...android,
        [field]: marker,
      })),
      {
        ...android,
        get identity() {
          throw fault();
        },
      },
      new Proxy(android, {
        ownKeys() {
          throw fault();
        },
      }),
      {
        ...android,
        toJSON() {
          throw fault();
        },
      },
    ];
    for (const existing of [false, true]) {
      if (existing) await new BindingStore(file).write(android);
      for (const value of invalid)
        await failure(() => store.write(value), 'invalid-format', 'parse');
      await failure(() => store.write({ ...android, version: 2 }), 'unsupported-version', 'parse');
      assert.equal(io, 0);
      if (existing)
        assert.deepEqual(await new BindingStore(file).read(), parseDeviceBinding(android));
      else assert.deepEqual(await readdir(root), []);
    }
  });
});

test('write serializes one detached snapshot despite getters, parser reentry and later mutation', async () => {
  await fixture(async (_root, file) => {
    let reads = 0;
    const identity = { ...android.identity };
    const value = {
      ...android,
      identity,
      get endpointId() {
        reads++;
        assert.equal(parseDeviceBinding(ios).status, 'valid');
        return reads === 1 ? android.endpointId : 'unexpected-second-read';
      },
    };
    const store = new BindingStore(file, {
      mkdir: async (directory, options) => {
        identity.routingId = 'changed-after-validation';
        await mkdir(directory, options);
      },
    });
    await store.write(value);
    assert.equal(reads, 1);
    assert.deepEqual(await new BindingStore(file).read(), parseDeviceBinding(android));
  });
});

test('unique same-directory wx temporaries are closed before commit; existing directories stay unchanged', async () => {
  await fixture(async (_root, file) => {
    await mkdir(path.dirname(file), { mode: 0o755 });
    await chmod(path.dirname(file), 0o755);
    const temporaries = new Set<string>();
    let closed = false;
    let commits = 0;
    const store = new BindingStore(file, {
      open: async (temporary, flags, mode) => {
        assert.equal(path.dirname(temporary), path.dirname(file));
        assert.equal(flags, 'wx');
        assert.equal(mode, 0o600);
        assert.equal(temporaries.has(temporary), false);
        temporaries.add(temporary);
        closed = false;
        const handle = await open(temporary, flags, mode);
        return {
          writeFile: (text) => handle.writeFile(text),
          close: async () => {
            await handle.close();
            closed = true;
          },
        };
      },
      rename: async (from, to) => {
        assert.equal(closed, true);
        assert.equal(to, file);
        assert.deepEqual(await readFile(from, 'utf8').then(JSON.parse), commits ? ios : android);
        await rename(from, to);
        commits++;
      },
      unlink: async () => {
        assert.fail('No post-commit cleanup');
      },
    });
    await store.write(android);
    await store.write(ios);
    assert.equal(commits, 2);
    assert.equal(temporaries.size, 2);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o755);
  });
});

test('pre-commit mkdir/open/write/close/rename failures preserve old bytes and clean owned resources', async (t) => {
  for (const stage of ['mkdir', 'open', 'write', 'close', 'rename'] as const) {
    await t.test(stage, async () => {
      await fixture(async (_root, file) => {
        await new BindingStore(file).write(android);
        const before = await readFile(file);
        const outside = path.join(path.dirname(file), 'external-marker.tmp');
        await writeFile(outside, marker);
        let opened = 0;
        let closed = 0;
        let writes = 0;
        let renames = 0;
        const store = new BindingStore(file, {
          mkdir: async (directory, options) => {
            if (stage === 'mkdir') throw fault();
            return mkdir(directory, options);
          },
          open: async (temporary, flags, mode) => {
            if (stage === 'open') throw fault();
            const handle = await open(temporary, flags, mode);
            opened++;
            return {
              writeFile: async (text) => {
                writes++;
                if (stage === 'write') {
                  await handle.writeFile(text.slice(0, 15));
                  throw fault();
                }
                await handle.writeFile(text);
              },
              close: async () => {
                if (stage === 'close' && closed === 0) {
                  closed++;
                  throw fault();
                }
                await handle.close();
                closed++;
              },
            };
          },
          rename: async (from, to) => {
            renames++;
            if (stage === 'rename') throw fault();
            await rename(from, to);
          },
        });
        await failure(() => store.write(ios), 'write-failed', stage);
        assert.deepEqual(await readFile(file), before);
        assert.equal(await readFile(outside, 'utf8'), marker);
        assert.deepEqual((await readdir(path.dirname(file))).sort(), [
          'binding.json',
          'external-marker.tmp',
        ]);
        assert.equal(closed, stage === 'close' ? 2 : opened);
        assert.equal(writes, opened);
        assert.equal(renames, stage === 'rename' ? 1 : 0);
      });
    });
  }
});

test('primary failure retains both cleanup categories without raw errors, then permits another write', async () => {
  await fixture(async (_root, file) => {
    await new BindingStore(file).write(android);
    const before = await readFile(file);
    let closes = 0;
    let removes = 0;
    let failing = true;
    const store = new BindingStore(file, {
      open: async (temporary, flags, mode) => {
        const handle = await open(temporary, flags, mode);
        return {
          writeFile: async (text) => {
            await handle.writeFile(failing ? text.slice(0, 15) : text);
            if (failing) throw fault();
          },
          close: async () => {
            closes++;
            await handle.close();
            if (failing) throw fault();
          },
        };
      },
      unlink: async (temporary) => {
        removes++;
        await unlink(temporary);
        if (failing) throw fault();
      },
    });
    await failure(() => store.write(ios), 'write-failed', 'write', [
      'close-failed',
      'remove-failed',
    ]);
    assert.equal(closes, 1);
    assert.equal(removes, 1);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(path.dirname(file)), ['binding.json']);
    failing = false;
    await store.write(ios);
    assert.deepEqual(await store.read(), parseDeviceBinding(ios));
  });
});

test('failed close and failed removal report retained owned resources without touching other files', async () => {
  await fixture(async (_root, file) => {
    await new BindingStore(file).write(android);
    const before = await readFile(file);
    const external = path.join(path.dirname(file), 'external-marker.tmp');
    await writeFile(external, marker);
    let owned: Awaited<ReturnType<typeof open>> | undefined;
    let temporary: string | undefined;
    let closes = 0;
    let removes = 0;
    const store = new BindingStore(file, {
      open: async (name, flags, mode) => {
        temporary = name;
        const handle = await open(name, flags, mode);
        owned = handle;
        return {
          writeFile: (text) => handle.writeFile(text),
          close: async () => {
            closes++;
            throw fault();
          },
        };
      },
      unlink: async (name) => {
        assert.equal(name, temporary);
        removes++;
        throw fault();
      },
    });
    try {
      await failure(() => store.write(ios), 'write-failed', 'close', [
        'close-failed',
        'remove-failed',
      ]);
      assert.equal(closes, 2);
      assert.equal(removes, 1);
      assert.ok(temporary);
      assert.deepEqual(JSON.parse(await readFile(temporary, 'utf8')), ios);
      assert.deepEqual(await readFile(file), before);
      assert.equal(await readFile(external, 'utf8'), marker);
    } finally {
      await owned?.close(); // The injected primitive refused cleanup; release the real test handle.
    }
  });
});

test('wx collision never grants ownership or removes a foreign temporary', async () => {
  await fixture(async (_root, file) => {
    await new BindingStore(file).write(android);
    let collision: string | undefined;
    const store = new BindingStore(file, {
      open: async (temporary, flags, mode) => {
        collision = temporary;
        await writeFile(temporary, marker);
        return open(temporary, flags, mode);
      },
      unlink: async () => {
        assert.fail('Foreign file must not be removed');
      },
    });
    await failure(() => store.write(ios), 'write-failed', 'open');
    assert.ok(collision);
    assert.equal(await readFile(collision, 'utf8'), marker);
    assert.deepEqual(await store.read(), parseDeviceBinding(android));
  });
});

test('missing owned temporary cleanup is idempotent and source-internal exports stay private', async () => {
  await fixture(async (_root, file) => {
    await new BindingStore(file).write(android);
    const store = new BindingStore(file, {
      rename: async (temporary) => {
        await unlink(temporary);
        throw fault();
      },
    });
    await failure(() => store.write(ios), 'write-failed', 'rename');
    assert.deepEqual(await readdir(path.dirname(file)), ['binding.json']);
    assert.deepEqual(await store.read(), parseDeviceBinding(android));
  });
  for (const name of ['BindingStore', 'BindingStoreError']) {
    assert.equal(Object.hasOwn(publicCore, name), false);
  }
});
