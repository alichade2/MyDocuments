package com.alichade.mydocs;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentSender;
import android.net.Uri;
import android.os.StatFs;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;

/**
 * Native helpers for backup and restore. Nothing here sees document contents beyond copying a file:
 *  - saveToDevice: Android's "create document" screen (Storage Access Framework) and a streaming copy into the chosen place
 *  - importFromUri: streaming copy of a picked content:// file into the app's cache folder (for restoring)
 *  - storageInfo: free space, so a restore can be refused before it starts
 *  - authorizeDrive: Google's Authorization API for the narrow drive.file scope. The access token is returned to the page in
 *    memory only; this class never stores it. Needs the app registered in Google Cloud (see PROJECT_STATUS.md).
 */
@CapacitorPlugin(name = "Backup")
public class BackupPlugin extends Plugin {
    private static final String DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    private ActivityResultLauncher<IntentSenderRequest> driveLauncher;
    private PluginCall pendingDriveCall;

    @Override
    public void load() {
        driveLauncher = getBridge().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onDriveConsent);
    }

    /** Copies a file from the app's cache folder to a place the user picks. Rejects with CANCELED when they back out. */
    @PluginMethod
    public void saveToDevice(PluginCall call) {
        String path = call.getString("path");
        String fileName = call.getString("fileName", "MyDocs_Backup.mydocsbackup");
        File source = cacheFile(path);
        if (source == null || !source.isFile()) {
            call.reject("The backup file is not available", "NOT_FOUND");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        call.getData().put("_source", source.getAbsolutePath());
        startActivityForResult(call, intent, "saveToDeviceResult");
    }

    @ActivityCallback
    private void saveToDeviceResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Cancelled", "CANCELED");
            return;
        }
        final Uri target = result.getData().getData();
        final File source = new File(call.getString("_source", ""));
        getBridge().execute(() -> {
            try (InputStream in = new FileInputStream(source); OutputStream out = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new java.io.IOException("No output stream");
                byte[] buffer = new byte[64 * 1024];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                out.flush();
                JSObject res = new JSObject();
                res.put("saved", true);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("The backup could not be saved", "SAVE_FAILED");
            }
        });
    }

    /** Streams a content:// (or file://) document into the cache folder: { uri, to } -> { size }. */
    @PluginMethod
    public void importFromUri(final PluginCall call) {
        final String uriText = call.getString("uri");
        final File target = cacheFile(call.getString("to"));
        if (uriText == null || target == null) {
            call.reject("Invalid request", "INVALID");
            return;
        }
        getBridge().execute(() -> {
            try {
                File parent = target.getParentFile();
                if (parent != null) parent.mkdirs();
                long total = 0;
                try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uriText));
                     OutputStream out = new java.io.FileOutputStream(target, false)) {
                    if (in == null) throw new java.io.IOException("No input stream");
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buffer)) > 0) { out.write(buffer, 0, n); total += n; }
                }
                JSObject res = new JSObject();
                res.put("size", total);
                call.resolve(res);
            } catch (Exception e) {
                target.delete();
                call.reject("The file could not be read", "READ_FAILED");
            }
        });
    }

    @PluginMethod
    public void storageInfo(PluginCall call) {
        try {
            StatFs stat = new StatFs(getContext().getFilesDir().getAbsolutePath());
            JSObject res = new JSObject();
            res.put("freeBytes", stat.getAvailableBytes());
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Unavailable", "UNAVAILABLE");
        }
    }

    /** Asks Google for an access token with the drive.file scope only. Resolves { accessToken }; the token is not stored. */
    @PluginMethod
    public void authorizeDrive(final PluginCall call) {
        if (pendingDriveCall != null) {
            call.reject("Sign-in is already in progress", "BUSY");
            return;
        }
        AuthorizationRequest request = AuthorizationRequest.builder()
            .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_SCOPE)))
            .build();
        Identity.getAuthorizationClient(getActivity())
            .authorize(request)
            .addOnSuccessListener((AuthorizationResult result) -> {
                if (result.hasResolution() && result.getPendingIntent() != null) {
                    pendingDriveCall = call;
                    try {
                        driveLauncher.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                    } catch (Exception e) {
                        pendingDriveCall = null;
                        call.reject("Sign-in could not be started", "AUTH_FAILED");
                    }
                } else {
                    resolveToken(call, result);
                }
            })
            .addOnFailureListener((Exception e) -> call.reject("Google sign-in is not available", "AUTH_FAILED"));
    }

    private void onDriveConsent(ActivityResult result) {
        PluginCall call = pendingDriveCall;
        pendingDriveCall = null;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Permission was not granted", "CANCELED");
            return;
        }
        try {
            AuthorizationResult authorization = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(result.getData());
            resolveToken(call, authorization);
        } catch (Exception e) {
            call.reject("Google sign-in failed", "AUTH_FAILED");
        }
    }

    private void resolveToken(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null || token.isEmpty()) {
            call.reject("Google did not return an access token", "AUTH_FAILED");
            return;
        }
        JSObject res = new JSObject();
        res.put("accessToken", token);
        call.resolve(res);
    }

    /** Only files inside the app's own cache folder, never outside it. */
    private File cacheFile(String relative) {
        if (relative == null || relative.isEmpty() || relative.contains("..") || relative.startsWith("/")) return null;
        File root = getContext().getCacheDir();
        File file = new File(root, relative);
        try {
            return file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator) ? file : null;
        } catch (Exception e) {
            return null;
        }
    }
}
