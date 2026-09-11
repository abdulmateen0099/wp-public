import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAuthDirectory } from '../utils/authStorage.js';

test('local deployments preserve the existing auth directory', () => {
    const root = path.resolve('app');
    assert.equal(resolveAuthDirectory(root, {}), path.join(root, 'auth'));
});

test('new application releases reuse credentials from the same mounted volume', async () => {
    const volume = await fs.mkdtemp(path.join(os.tmpdir(), 'wp-auth-test-'));
    try {
        const env = { RAILWAY_VOLUME_MOUNT_PATH: volume };
        const oldRoot = resolveAuthDirectory(path.resolve('release-old'), env);
        await fs.mkdir(path.join(oldRoot, 'sessions', 'primary'), { recursive: true });
        await fs.writeFile(path.join(oldRoot, 'sessions', 'primary', 'creds.json'), '{"registered":true}');
        const newRoot = resolveAuthDirectory(path.resolve('release-new'), env);
        assert.equal(newRoot, oldRoot);
        assert.deepEqual(JSON.parse(await fs.readFile(path.join(newRoot, 'sessions', 'primary', 'creds.json'), 'utf8')), { registered: true });
    } finally {
        await fs.rm(volume, { recursive: true, force: true });
    }
});

test('explicit auth directory overrides automatic volume selection', () => {
    const root = path.resolve('app');
    assert.equal(resolveAuthDirectory(root, { AUTH_DIR: 'custom-auth', RAILWAY_VOLUME_MOUNT_PATH: '/data' }), path.join(root, 'custom-auth'));
});
