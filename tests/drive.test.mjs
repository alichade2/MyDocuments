// Google Drive upload: folder reuse, unique names, chunked resumable upload, retries, confirmation, errors. The Drive
// service is a small fake; no network and no Google account are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDriveClient, DriveError, DRIVE_SCOPE, BACKUP_FOLDER_NAME, UPLOAD_CHUNK_BYTES } from '../www/js/drive.js';
import { errorText, setLanguage } from '../www/js/i18n.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TOKEN = 'ya29.test-token';

/** A tiny Drive: folders, files, resumable sessions. Options inject failures. */
function fakeDrive({ folders = [], files = [], offline = false, failFirstChunk = 0, listStatus = null, putStatus = null, finalSize = null, trashed = false } = {}) {
  const calls = [];
  const state = { folders: [...folders], files: [...files], uploaded: [], sessions: new Map(), chunkFails: failFirstChunk, listStatuses: listStatus ? [...listStatus] : [] };
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    if (offline) throw new TypeError('Failed to fetch');
    const u = new URL(url);
    const q = u.searchParams.get('q') ?? '';
    const auth = options.headers?.Authorization;
    if (u.pathname === '/drive/v3/files' && (options.method ?? 'GET') === 'GET') {
      if (state.listStatuses.length) { const s = state.listStatuses.shift(); if (s !== 200) return json({}, s); }
      if (q.includes('google-apps.folder')) return json({ files: state.folders.map((id) => ({ id, name: BACKUP_FOLDER_NAME })) });
      const m = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
      const name = m?.[1].replace(/\\(.)/g, '$1');
      return json({ files: state.files.filter((f) => f.name === name).map((f) => ({ id: f.id })) });
    }
    if (u.pathname === '/drive/v3/files' && options.method === 'POST') { state.folders.push('folder-new'); return json({ id: 'folder-new' }); }
    if (u.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      const meta = JSON.parse(options.body);
      state.sessions.set('s1', { meta, size: Number(options.headers['X-Upload-Content-Length']), got: 0, parts: [] });
      return new Response('', { status: 200, headers: { Location: 'https://www.googleapis.com/upload/session/s1' } });
    }
    if (u.pathname === '/upload/session/s1') {
      const s = state.sessions.get('s1');
      const range = /bytes (?:\*|(\d+)-(\d+))\/(\d+)/.exec(options.headers['Content-Range']);
      if (!range[1]) return new Response('', { status: 308, headers: s.got ? { Range: `bytes=0-${s.got - 1}` } : {} });
      if (putStatus && s.parts.length === 0 && state.chunkFails > 0) { state.chunkFails--; return new Response('', { status: putStatus }); }
      if (state.chunkFails > 0) { state.chunkFails--; return new Response('', { status: 503 }); }
      const start = Number(range[1]);
      if (start !== s.got) return new Response('', { status: 400 });
      const body = options.body;
      s.got += body.length;
      s.parts.push(body.length);
      if (s.got < s.size) return new Response('', { status: 308, headers: { Range: `bytes=0-${s.got - 1}` } });
      state.uploaded.push({ name: s.meta.name, parents: s.meta.parents, size: s.got, parts: s.parts });
      state.files.push({ id: 'file-1', name: s.meta.name, size: s.got });
      return json({ id: 'file-1', name: s.meta.name });
    }
    if (u.pathname === '/drive/v3/files/file-1') {
      const f = state.files.find((x) => x.id === 'file-1');
      return json({ id: 'file-1', name: f.name, size: String(finalSize ?? f.size), trashed });
    }
    return json({}, 404);
  };
  return { fetchImpl, state, calls };
}

const bytes = (n) => new Uint8Array(n).fill(7);
const readRangeOf = (size) => async (offset, length) => bytes(Math.min(length, size - offset));
const client = (drive, authorize = async () => ({ accessToken: TOKEN })) => createDriveClient({ authorize, fetchImpl: drive.fetchImpl });
const upload = (c, size = 1_000_000, extra = {}) => c.upload({ name: 'MyDocs_Backup_2026-10-17.mydocsbackup', size, readRange: readRangeOf(size), ...extra });

test('Drive scope is drive.file only, the folder is "MyDocs Backups", chunks are multiples of 256 KiB', () => {
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(BACKUP_FOLDER_NAME, 'MyDocs Backups');
  assert.equal(UPLOAD_CHUNK_BYTES % (256 * 1024), 0);
});

test('first upload creates the folder, sends the file in chunks and reports success only after Drive confirms it', async () => {
  const drive = fakeDrive();
  const size = UPLOAD_CHUNK_BYTES * 2 + 1234;
  const stages = [];
  const res = await upload(client(drive), size, { onProgress: (p) => stages.push(p.stage) });
  assert.deepEqual(res, { id: 'file-1', name: 'MyDocs_Backup_2026-10-17.mydocsbackup', folder: 'MyDocs Backups' });
  assert.deepEqual(drive.state.uploaded[0].parts, [UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES, 1234]);
  assert.equal(drive.state.uploaded[0].size, size);
  assert.deepEqual(drive.state.uploaded[0].parents, ['folder-new']);
  assert.ok(stages.includes('sign-in') && stages.includes('folder') && stages.includes('upload'));
  assert.equal(drive.calls.at(-1).url.includes('/drive/v3/files/file-1'), true, 'the last request is the confirmation');
});

test('only HTTPS Google API addresses are used, the token only travels in the Authorization header', async () => {
  const drive = fakeDrive({ folders: ['f1'] });
  await upload(client(drive));
  for (const c of drive.calls) {
    assert.match(c.url, /^https:\/\/www\.googleapis\.com\//);
    assert.ok(!c.url.includes(TOKEN));
  }
  assert.ok(drive.calls.filter((c) => !c.url.includes('/upload/session/')).every((c) => c.headers.Authorization === `Bearer ${TOKEN}`));
});

test('an existing "MyDocs Backups" folder is reused (no duplicate folder)', async () => {
  const drive = fakeDrive({ folders: ['existing-folder'] });
  await upload(client(drive));
  assert.ok(!drive.calls.some((c) => c.method === 'POST' && c.url.includes('/drive/v3/files') && !c.url.includes('upload')));
  assert.deepEqual(drive.state.uploaded[0].parents, ['existing-folder']);
});

test('an existing backup with the same name is never replaced: a unique name is used', async () => {
  const name = 'MyDocs_Backup_2026-10-17.mydocsbackup';
  const drive = fakeDrive({ folders: ['f'], files: [{ id: 'old1', name }, { id: 'old2', name: 'MyDocs_Backup_2026-10-17 (2).mydocsbackup' }] });
  const res = await upload(client(drive));
  assert.equal(res.name, 'MyDocs_Backup_2026-10-17 (3).mydocsbackup');
  assert.equal(drive.state.files.filter((f) => f.id.startsWith('old')).length, 2);
  assert.ok(!drive.calls.some((c) => c.method === 'DELETE' || /files\/old/.test(c.url)));
});

test('offline: nothing is reported as uploaded and the error says the local backup is kept', async () => {
  const drive = fakeDrive({ offline: true });
  const err = await upload(client(drive)).catch((e) => e);
  assert.ok(err instanceof DriveError);
  assert.equal(err.code, 'DRIVE_OFFLINE');
  assert.match(err.message, /backup file has been kept/);
  assert.equal(drive.state.uploaded.length, 0);
});

test('a chunk that fails is retried after asking Drive how much it has; the upload still completes', async () => {
  const drive = fakeDrive({ folders: ['f'], failFirstChunk: 2 });
  const size = UPLOAD_CHUNK_BYTES + 500;
  const res = await upload(client(drive), size);
  assert.equal(res.id, 'file-1');
  assert.equal(drive.state.uploaded[0].size, size);
});

test('an upload that keeps failing ends with an error, not with success', async () => {
  const drive = fakeDrive({ folders: ['f'], failFirstChunk: 99 });
  const err = await upload(client(drive), 4000).catch((e) => e);
  assert.equal(err.code, 'DRIVE_FAILED');
  assert.equal(drive.state.uploaded.length, 0);
});

test('Drive must confirm the finished file: a wrong size or a trashed file is not a success', async () => {
  await assert.rejects(upload(client(fakeDrive({ folders: ['f'], finalSize: 1 })), 5000), { code: 'DRIVE_UNVERIFIED' });
  await assert.rejects(upload(client(fakeDrive({ folders: ['f'], trashed: true })), 5000), { code: 'DRIVE_UNVERIFIED' });
});

test('sign-in: cancelling, an unavailable Google service and a missing token are handled without uploading anything', async () => {
  const drive = fakeDrive();
  const cancelled = await upload(client(drive, async () => { throw Object.assign(new Error('x'), { code: 'CANCELED' }); })).catch((e) => e);
  assert.equal(cancelled.code, 'DRIVE_CANCELED');
  assert.match(cancelled.message, /sign-in was cancelled/);
  const broken = await upload(client(drive, async () => { throw Object.assign(new Error('Developer error'), { code: 'AUTH_FAILED' }); })).catch((e) => e);
  assert.equal(broken.code, 'DRIVE_UNAVAILABLE');
  const empty = await upload(client(drive, async () => ({}))).catch((e) => e);
  assert.equal(empty.code, 'DRIVE_AUTH');
  assert.equal(drive.calls.length, 0, 'no request is sent without a token');
});

test('an expired token is replaced once; a second rejection is reported', async () => {
  let n = 0;
  const authorize = async () => ({ accessToken: `t${++n}` });
  const ok = fakeDrive({ folders: ['f'], listStatus: [401, 200, 200] });
  assert.equal((await upload(client(ok, authorize))).id, 'file-1');
  assert.equal(n, 2);
  n = 0;
  const bad = fakeDrive({ folders: ['f'], listStatus: [401, 401] });
  await assert.rejects(upload(client(bad, authorize)), { code: 'DRIVE_AUTH' });
});

test('permission and quota problems have their own messages', async () => {
  await assert.rejects(upload(client(fakeDrive({ listStatus: [403] }))), { code: 'DRIVE_DENIED' });
  const quota = fakeDrive({ folders: ['f'], failFirstChunk: 1, putStatus: 507 });
  await assert.rejects(upload(client(quota), 5000), { code: 'DRIVE_QUOTA' });
});

test('the user can cancel between chunks', async () => {
  const drive = fakeDrive({ folders: ['f'] });
  let chunks = 0;
  const err = await upload(client(drive), UPLOAD_CHUNK_BYTES * 3, { shouldCancel: () => chunks++ >= 1 }).catch((e) => e);
  assert.equal(err.code, 'DRIVE_CANCELED');
  assert.equal(drive.state.uploaded.length, 0);
});

test('every Drive message has a Hindi translation and the English text is unchanged', () => {
  const messages = [...read('www/js/drive.js').match(/const MSG = \{([\s\S]*?)\n\};/)[1].matchAll(/^\s+\w+: '((?:[^'\\]|\\.)*)',?$/gm)].map((m) => m[1].replace(/\\'/g, "'"));
  messages.push('The upload was cancelled.');
  assert.ok(messages.length >= 8);
  for (const m of messages) assert.equal(errorText({ message: m }), m, 'English unchanged');
  setLanguage('hi');
  try { for (const m of messages) assert.match(errorText({ message: m }), /[ऀ-ॿ]/, m); } finally { setLanguage('en'); }
});

test('security: no client secret, no stored tokens, only the drive.file scope in the app', () => {
  const sources = ['www/js/drive.js', 'www/js/backup-native.js', 'www/js/app.js', 'android/app/src/main/java/com/alichade/mydocs/BackupPlugin.java'].map(read).join('\n');
  assert.doesNotMatch(sources, /client_secret|clientSecret|refresh_token|refreshToken/);
  assert.doesNotMatch(sources, /localStorage\.setItem\([^)]*(token|accessToken)/i);
  assert.match(read('android/app/src/main/java/com/alichade/mydocs/BackupPlugin.java'), /https:\/\/www\.googleapis\.com\/auth\/drive\.file/);
  assert.doesNotMatch(sources, /auth\/drive['"`](?!\.file)/); // never the full-Drive scope
  assert.doesNotMatch(sources, /auth\/drive\.readonly|auth\/drive\.appdata|auth\/drive\.metadata/);
});
