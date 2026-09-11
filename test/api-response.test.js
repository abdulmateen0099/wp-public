import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(0, source.indexOf('// ─── DOM Elements')), context);
const read = context.readApiResponse;

test('login API preserves valid success and invalid-credentials responses', async () => {
    assert.equal((await read(new Response('{"success":true,"token":"test"}'))).token, 'test');
    assert.equal((await read(new Response('{"error":"Invalid credentials"}', { status: 401 }))).error, 'Invalid credentials');
});

test('Vercel 404 and Railway gateway errors have actionable messages', async () => {
    await assert.rejects(read(new Response('The page could not be found', { status: 404 })), /API route not found.*HTTP 404/);
    await assert.rejects(read(new Response('<html>Bad Gateway</html>', { status: 502 })), /Backend unavailable.*HTTP 502/);
    await assert.rejects(read(new Response('<html>Dashboard</html>')), /Expected JSON/);
    await assert.rejects(read(new Response('null')), /Invalid API response/);
});
