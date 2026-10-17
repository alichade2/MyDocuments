// Browser-preview stand-ins for backup, restore, saving and Google Drive (no real files, nothing leaves the page).
// A tester can steer them with globalThis.__mydocsPreviewBackup = { saveCancelled, driveError, inspectError, restoreError, missingFiles }.
import { BackupError, backupFileName } from './backup.js';
import { DriveError } from './drive.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const knob = () => globalThis.__mydocsPreviewBackup ?? {};

export function createMockBackup() {
  const scratchFiles = new Map();
  const scratch = {
    read: async (path, offset, length) => new Uint8Array(Math.max(0, Math.min(length, 1_234_567 - offset))),
    remove: async (path) => { scratchFiles.delete(path); },
  };
  const backup = {
    async createBackup({ onProgress = () => {}, shouldCancel = () => false } = {}) {
      onProgress({ stage: 'prepare' });
      await wait(250);
      onProgress({ stage: 'collect' });
      await wait(250);
      for (let i = 0; i < 6; i++) {
        if (shouldCancel()) throw new BackupError('BACKUP_CANCELLED', 'The operation was cancelled.');
        onProgress({ stage: 'create', done: i, total: 6 });
        await wait(180);
      }
      onProgress({ stage: 'validate' });
      await wait(250);
      const path = `backup/${backupFileName()}`;
      scratchFiles.set(path, true);
      const missing = Number(knob().missingFiles ?? 0);
      return {
        path, fileName: backupFileName(), size: 1_234_567, createdAt: new Date().toISOString(), missingFiles: missing,
        summary: { createdAt: new Date().toISOString(), formatVersion: 1, schemaVersion: 5, size: 1_234_567, categories: 13, customCategories: 0, documents: 58, files: 0, withoutFile: missing },
      };
    },
    async inspect() {
      await wait(300);
      if (knob().inspectError) throw new BackupError(knob().inspectError, 'This file is not a valid MyDocs backup.');
      return { createdAt: '2026-10-01T09:30:00.000Z', formatVersion: 1, schemaVersion: 5, size: 1_234_567, categories: 15, customCategories: 2, documents: 64, files: 6, withoutFile: Number(knob().missingFiles ?? 0) };
    },
    async restore(path, { mode = 'replace', onProgress = () => {} } = {}) {
      onProgress({ stage: 'validate' });
      await wait(300);
      for (let i = 0; i <= 6; i++) { onProgress({ stage: 'restore', done: i, total: 6 }); await wait(150); }
      if (knob().restoreError) throw new BackupError(knob().restoreError, 'The restore failed. Your existing data has been kept unchanged.');
      return mode === 'merge'
        ? { mode, categories: 15, documents: 64, addedCategories: 2, addedDocuments: 6, files: 6 }
        : { mode, categories: 15, documents: 64, addedCategories: 15, addedDocuments: 64, files: 6 };
    },
  };
  const native = {
    scratch,
    async saveToDevice() { await wait(200); return !knob().saveCancelled; },
    async pickBackup() { await wait(150); return { name: 'MyDocs_Backup_2026-10-01.mydocsbackup', size: 1_234_567, path: 'restore/incoming.mydocsbackup' }; },
  };
  const drive = {
    async upload({ name, onProgress, shouldCancel }) {
      onProgress?.({ stage: 'sign-in' }); await wait(250);
      if (knob().driveError) throw new DriveError(knob().driveError, 'Could not reach Google Drive. Check your internet connection and try again. Your backup file has been kept.');
      onProgress?.({ stage: 'folder' }); await wait(250);
      for (let i = 1; i <= 5; i++) {
        if (shouldCancel?.()) throw new DriveError('DRIVE_CANCELED', 'The upload was cancelled.');
        onProgress?.({ stage: 'upload', done: i, total: 5 }); await wait(200);
      }
      return { id: 'preview', name, folder: 'MyDocs Backups' };
    },
  };
  return { backup, native, drive };
}
