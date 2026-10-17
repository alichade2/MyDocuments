package com.alichade.mydocs;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

import static androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG;
import static androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL;

/**
 * App Lock bridge: shows Android's own authentication prompt (BiometricPrompt) and nothing else.
 * It never sees, stores or compares a PIN, pattern, password or biometric template - the system answers
 * only "authenticated" or an error code.
 *
 * Authenticators: Android 11+ (API 30) allows BIOMETRIC_STRONG | DEVICE_CREDENTIAL together. Android 7-10
 * does not support that combination, so there the deprecated-but-equivalent setDeviceCredentialAllowed(true) is
 * used (same behaviour: fingerprint/face if enrolled, otherwise the screen-lock PIN/pattern/password).
 * Both paths allow only strong biometrics plus the device credential, never weaker ones.
 */
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {
    private boolean protectRecents = false;
    private boolean prompting = false;

    /** { secure: device has a PIN/pattern/password, available: the prompt can be shown, biometric: strong biometric enrolled } */
    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        KeyguardManager km = (KeyguardManager) ctx.getSystemService(Context.KEYGUARD_SERVICE);
        boolean secure = km != null && km.isDeviceSecure();
        BiometricManager bm = BiometricManager.from(ctx);
        boolean biometric = bm.canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
        boolean available = secure;
        if (secure && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            available = bm.canAuthenticate(BIOMETRIC_STRONG | DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS;
        }
        JSObject res = new JSObject();
        res.put("secure", secure);
        res.put("available", available);
        res.put("biometric", biometric);
        res.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(res);
    }

    /** Resolves { success: true } only after the system confirms authentication; otherwise rejects with a code. */
    @PluginMethod
    public void authenticate(final PluginCall call) {
        final FragmentActivity activity = (FragmentActivity) getActivity();
        if (activity == null) {
            call.reject("No activity", "NOT_AVAILABLE");
            return;
        }
        final String title = call.getString("title", "Unlock MyDocs");
        final String subtitle = call.getString("subtitle", "Use your fingerprint, face or screen lock");
        activity.runOnUiThread(() -> {
            if (prompting) {
                call.reject("An authentication prompt is already open", "BUSY");
                return;
            }
            prompting = true;
            Executor executor = ContextCompat.getMainExecutor(activity);
            BiometricPrompt prompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    prompting = false;
                    JSObject res = new JSObject();
                    res.put("success", true);
                    call.resolve(res);
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                    prompting = false;
                    call.reject(String.valueOf(errString), mapError(errorCode));
                }
                // onAuthenticationFailed (a non-matching finger) is handled by the system dialog, which lets the user retry.
            });
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setConfirmationRequired(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                info.setAllowedAuthenticators(BIOMETRIC_STRONG | DEVICE_CREDENTIAL);
            } else {
                // API 24-29: the combination above is unsupported; this is the equivalent for those versions.
                // (No negative button may be set together with device credentials.)
                info.setDeviceCredentialAllowed(true);
            }
            try {
                prompt.authenticate(info.build());
            } catch (RuntimeException e) {
                prompting = false;
                call.reject("Authentication is not available", "NOT_AVAILABLE");
            }
        });
    }

    /** While enabled, the window is marked secure whenever the app is paused, so Android Recents shows no content. */
    @PluginMethod
    public void setProtectRecents(PluginCall call) {
        protectRecents = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        if (!protectRecents) clearSecure();
        call.resolve();
    }

    /** Opens Android's security settings so the user can set up a screen lock. */
    @PluginMethod
    public void openSecuritySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("Could not open Android Settings", "ERROR");
        }
    }

    @Override
    protected void handleOnPause() {
        if (protectRecents && getActivity() != null) {
            getActivity().getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    @Override
    protected void handleOnResume() {
        clearSecure();
    }

    /** Window flags may only change on the main thread (plugin methods run on a background thread). */
    private void clearSecure() {
        final android.app.Activity activity = getActivity();
        if (activity != null) activity.runOnUiThread(() -> activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE));
    }

    private static String mapError(int code) {
        switch (code) {
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
            case BiometricPrompt.ERROR_CANCELED:
                return "CANCELED";
            case BiometricPrompt.ERROR_LOCKOUT:
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return "LOCKOUT";
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
                return "NO_SCREEN_LOCK";
            case BiometricPrompt.ERROR_HW_UNAVAILABLE:
            case BiometricPrompt.ERROR_HW_NOT_PRESENT:
            case BiometricPrompt.ERROR_NO_BIOMETRICS:
            case BiometricPrompt.ERROR_UNABLE_TO_PROCESS:
            case BiometricPrompt.ERROR_TIMEOUT:
            case BiometricPrompt.ERROR_VENDOR:
                return "NOT_AVAILABLE";
            default:
                return "ERROR";
        }
    }
}
