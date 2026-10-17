// Android adapters for backup and restore: the cache folder as scratch space, "save to device" (create-document screen),
// picking a backup file (Storage Access Framework), free-space check and Google authorization. Used on a device only.
import { base64ToBytes } from './zip.js';
import { RESTORE_FILE } from './backup.js';

const nameOf = (e) => String(e?.message ?? e);

export function nativeBackupAdapters(plugins = globalThis.Capacitor?.Plugins, external = (fn) => fn()) {
  const fs = plugins?.Filesystem;
  const native = plugins?.Backup;
  const dir = 'CACHE';

  /** Files in the app's cache folder: the archive being built, or the archive being restored. */
  const scratch = fs && {
    async write(path, data) {
      if (data === '') await fs.writeFile({ path, data: '', directory: dir, encoding: 'utf8', recursive: true });
      else await fs.writeFile({ path, data, directory: dir, recursive: true });
    },
    append: (path, data) => fs.appendFile({ path, data, directory: dir }),
    async size(path) { return (await fs.stat({ path, directory: dir })).size; },
    async read(path, offset, length) {
      const { data } = await fs.readFile({ path, directory: dir, offset, length });
      return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer());
    },
    async remove(path) { await fs.deleteFile({ path, directory: dir }); },
    async exists(path) {
      try { await fs.stat({ path, directory: dir }); return true; } catch (e) { if (/not exist|not found|ENOENT/i.test(nameOf(e))) return false; throw e; }
    },
  };

  return {
    scratch,
    /** Removes temporary files from an interrupted backup or restore (best effort). */
    async cleanup() {
      for (const path of ['backup', 'restore', 'backup-tmp']) await fs?.rmdir({ path, directory: dir, recursive: true }).catch(() => {});
    },
    freeSpace: native && (async () => (await native.storageInfo()).freeBytes),

    /** Asks the user where to keep the backup. Resolves true when saved, false when they cancelled. */
    async saveToDevice({ path, fileName }) {
      if (!native) throw Object.assign(new Error('Saving is not available'), { code: 'UNAVAILABLE' });
      try {
        await external(() => native.saveToDevice({ path, fileName }));
        return true;
      } catch (e) {
        if (e?.code === 'CANCELED') return false;
        throw e;
      }
    },

    /**
     * Lets the user pick a backup file and copies it into the cache folder (a streaming copy, no filesystem path of the
     * original is needed). Resolves null when they cancel, otherwise { name, size, path }.
     */
    async pickBackup() {
      if (!plugins?.FilePicker || !native) throw Object.assign(new Error('Picking is not available'), { code: 'UNAVAILABLE' });
      let files;
      try {
        ({ files } = await external(() => plugins.FilePicker.pickFiles({ limit: 1, readData: false, types: ['*/*'] })));
      } catch (e) {
        if (/cancel/i.test(nameOf(e))) return null;
        throw e;
      }
      const picked = files?.[0];
      if (!picked?.path) return null;
      await scratch.remove(RESTORE_FILE).catch(() => {});
      const { size } = await native.importFromUri({ uri: picked.path, to: RESTORE_FILE });
      return { name: picked.name, size, path: RESTORE_FILE };
    },

    /** Google authorization for the drive.file scope only. Resolves { accessToken } (kept in memory by the caller). */
    authorizeDrive: () => external(() => native.authorizeDrive()),
  };
}
