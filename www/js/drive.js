// Google Drive upload for backups (REST API v3, resumable upload over HTTPS).
//  - Scope: drive.file only (the app sees just the files and folders it creates itself).
//  - The access token comes from Android's Authorization API for this one operation and is kept in memory only.
//  - A folder "MyDocs Backups" is reused when it exists; an existing backup is never overwritten (a unique name is used).
//  - Success is reported only after Drive confirms the finished file (id + size verified).

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const BACKUP_FOLDER_NAME = 'MyDocs Backups';
export const BACKUP_MIME = 'application/octet-stream';
export const UPLOAD_CHUNK_BYTES = 256 * 1024 * 20; // a multiple of 256 KiB, as Drive requires (5 MiB)
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=false';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'DriveError'; this.code = code; Object.assign(this, details); }
}

const MSG = {
  offline: 'Could not reach Google Drive. Check your internet connection and try again. Your backup file has been kept.',
  auth: 'Google Drive sign-in was not completed. Your backup file has been kept.',
  denied: 'Permission to use Google Drive was not granted. Your backup file has been kept.',
  signInCancelled: 'Google Drive sign-in was cancelled. Your backup file has been kept.',
  unavailable: 'Google Drive sign-in is not available in this build of MyDocs. Save the backup to your device instead.',
  failed: 'The upload to Google Drive failed. Your backup file has been kept; you can try again.',
  quota: 'Google Drive has no free space left for this backup.',
  unverified: 'Google Drive did not confirm the uploaded file. Please try again.',
};

const escapeQuery = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** A fetch that turns "no network" into a DriveError('DRIVE_OFFLINE'). */
async function call(fetchImpl, url, options) {
  try { return await fetchImpl(url, options); } catch { throw new DriveError('DRIVE_OFFLINE', MSG.offline); }
}

function httpError(status) {
  if (status === 401) return new DriveError('DRIVE_AUTH', MSG.auth, { status });
  if (status === 403 || status === 429) return new DriveError(status === 403 ? 'DRIVE_DENIED' : 'DRIVE_FAILED', status === 403 ? MSG.denied : MSG.failed, { status });
  if (status === 507) return new DriveError('DRIVE_QUOTA', MSG.quota, { status });
  return new DriveError('DRIVE_FAILED', MSG.failed, { status });
}

/**
 * @param {object} deps
 * @param {()=>Promise<{accessToken:string}>} deps.authorize   native Google authorization (drive.file)
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createDriveClient({ authorize, fetchImpl = (...a) => globalThis.fetch(...a), access = { requirePro() {} } }) {
  async function token() {
    let res;
    try { res = await authorize(); } catch (e) {
      const code = String(e?.code ?? '');
      if (code === 'CANCELED') throw new DriveError('DRIVE_CANCELED', MSG.signInCancelled);
      if (code === 'UNIMPLEMENTED' || /not implemented/i.test(String(e?.message))) throw new DriveError('DRIVE_UNAVAILABLE', MSG.unavailable);
      throw new DriveError('DRIVE_UNAVAILABLE', MSG.unavailable);
    }
    if (!res?.accessToken) throw new DriveError('DRIVE_AUTH', MSG.auth);
    return res.accessToken;
  }

  async function json(url, accessToken, options = {}) {
    const response = await call(fetchImpl, url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers ?? {}) } });
    if (!response.ok) throw httpError(response.status);
    return response.json();
  }

  /** The "MyDocs Backups" folder created by this app (drive.file only lists what the app made); created when missing. */
  async function ensureFolder(accessToken) {
    const q = `name = '${escapeQuery(BACKUP_FOLDER_NAME)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const found = await json(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10&spaces=drive`, accessToken);
    if (found.files?.length) return found.files[0].id;
    const created = await json(`${API}/files?fields=id`, accessToken, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    if (!created.id) throw new DriveError('DRIVE_FAILED', MSG.failed);
    return created.id;
  }

  /** `name`, or `name (2)`, `name (3)`... so an existing backup in the folder is never replaced. */
  async function uniqueName(accessToken, folderId, name) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; n < 1000; n++) {
      const q = `'${escapeQuery(folderId)}' in parents and trashed = false and name = '${escapeQuery(candidate)}'`;
      const found = await json(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&spaces=drive`, accessToken);
      if (!found.files?.length) return candidate;
      candidate = `${stem} (${n})${ext}`;
    }
    throw new DriveError('DRIVE_FAILED', MSG.failed);
  }

  /** Starts a resumable session and returns its upload URL. */
  async function startSession(accessToken, { name, folderId, size }) {
    const response = await call(fetchImpl, UPLOAD, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': BACKUP_MIME, 'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name, parents: [folderId], mimeType: BACKUP_MIME }),
    });
    if (!response.ok) throw httpError(response.status);
    const location = response.headers.get('Location');
    if (!location || !location.startsWith('https://www.googleapis.com/')) throw new DriveError('DRIVE_FAILED', MSG.failed);
    return location;
  }

  /** Sends the file in chunks; a failed chunk is retried a few times after asking Drive how much it already has. */
  async function sendChunks(sessionUrl, size, readRange, onProgress, shouldCancel) {
    let offset = 0;
    let attempts = 0;
    while (offset < size) {
      if (shouldCancel?.()) throw new DriveError('DRIVE_CANCELED', 'The upload was cancelled.');
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, size);
      const chunk = await readRange(offset, end - offset);
      let response;
      try {
        response = await call(fetchImpl, sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${size}` }, body: chunk });
      } catch (err) {
        if (++attempts > 3) throw err;
        offset = await resumeOffset(sessionUrl, size).catch(() => offset);
        continue;
      }
      if (response.status === 308) { // Drive has everything up to Range: bytes=0-N
        const range = /bytes=0-(\d+)/.exec(response.headers.get('Range') ?? '');
        offset = range ? Number(range[1]) + 1 : offset;
        attempts = 0;
        onProgress?.(offset, size);
        continue;
      }
      if (response.status === 200 || response.status === 201) {
        onProgress?.(size, size);
        return response.json();
      }
      if (response.status >= 500 && response.status !== 507 && ++attempts <= 3) { // transient server errors are retried; "insufficient storage" is final
        offset = await resumeOffset(sessionUrl, size).catch(() => offset);
        continue;
      }
      throw httpError(response.status);
    }
    throw new DriveError('DRIVE_FAILED', MSG.failed);
  }

  async function resumeOffset(sessionUrl, size) {
    const response = await call(fetchImpl, sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` } });
    if (response.status === 308) {
      const range = /bytes=0-(\d+)/.exec(response.headers.get('Range') ?? '');
      return range ? Number(range[1]) + 1 : 0;
    }
    throw new DriveError('DRIVE_FAILED', MSG.failed);
  }

  return {
    /**
     * Uploads one backup file. Resolves { id, name, folder } only after Drive has confirmed the stored file.
     * @param {{name:string, size:number, readRange:(offset:number,length:number)=>Promise<Uint8Array>, onProgress?:Function, shouldCancel?:Function}} file
     */
    async upload({ name, size, readRange, onProgress, shouldCancel }) {
      access.requirePro('drive'); // Pro only: no sign-in or request is made without the entitlement
      onProgress?.({ stage: 'sign-in' });
      let accessToken = await token();
      onProgress?.({ stage: 'folder' });
      let folderId;
      try { folderId = await ensureFolder(accessToken); } catch (err) {
        if (err.code !== 'DRIVE_AUTH') throw err;
        accessToken = await token(); // the token had expired: ask once more
        folderId = await ensureFolder(accessToken);
      }
      const finalName = await uniqueName(accessToken, folderId, name);
      const session = await startSession(accessToken, { name: finalName, folderId, size });
      const result = await sendChunks(session, size, readRange, (done, total) => onProgress?.({ stage: 'upload', done, total }), shouldCancel);
      if (!result?.id) throw new DriveError('DRIVE_UNVERIFIED', MSG.unverified);
      // confirm with Drive itself that the file exists and has the right size
      const meta = await json(`${API}/files/${encodeURIComponent(result.id)}?fields=id,name,size,trashed`, accessToken);
      if (meta.id !== result.id || Number(meta.size) !== size || meta.trashed) throw new DriveError('DRIVE_UNVERIFIED', MSG.unverified);
      return { id: meta.id, name: meta.name ?? finalName, folder: BACKUP_FOLDER_NAME };
    },
  };
}
