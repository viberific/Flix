package com.viberific.flix;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Keeps the APK current without a reinstall: asks GitHub for the latest release, and when the update.json attached
 * by the build workflow names a newer versionCode than the one running, downloads that APK and hands it to the
 * system installer. Installing over the running app needs the same signing key as the build that is installed, so
 * the release publishes the fingerprint of the key it was signed with and this class compares it before it tries:
 * a build signed with a different key can only ever land by hand, and saying so beats failing in silence.
 */
public class Updater {
    private static final String TAG = "FlixUpdater";
    private static final String LATEST = "https://api.github.com/repos/viberific/flix/releases/latest";
    private static final long EVERY_MS = 15 * 60 * 1000;
    /** After a failed install, leave that version alone for a while instead of offering it again on every launch. */
    private static final long RETRY_MS = 6 * 60 * 60 * 1000;
    private static final String PREFS = "updater";
    private static final String KEY_MESSAGE = "message";
    private static final String KEY_FAILED_CODE = "failed_code";
    private static final String KEY_FAILED_AT = "failed_at";
    private static final String KEY_PENDING_CODE = "pending_code";
    private static long lastCheck;
    private static boolean busy;

    public static void check(Activity a) {
        long now = System.currentTimeMillis();
        synchronized (Updater.class) {
            if (busy || now - lastCheck < EVERY_MS) return;
            busy = true;
            lastCheck = now;
        }
        Thread t = new Thread(() -> {
            try { run(a); } catch (Exception e) { Log.w(TAG, "update check failed: " + e); }
            finally { synchronized (Updater.class) { busy = false; } }
        });
        t.setDaemon(true);
        t.start();
    }

    /** Shows whatever the last install attempt said, once. */
    public static void showPendingMessage(Context c) {
        String message = prefs(c).getString(KEY_MESSAGE, null);
        if (message == null) return;
        prefs(c).edit().remove(KEY_MESSAGE).apply();
        toast(c, message);
    }

    @SuppressWarnings("deprecation")
    private static long installedCode(Context c) throws Exception {
        PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    /** SHA-256 of the certificate the installed app is signed with, or null when it cannot be read. */
    @SuppressWarnings("deprecation")
    private static String certSha256(Context c) throws Exception {
        PackageManager pm = c.getPackageManager();
        Signature[] sigs;
        if (Build.VERSION.SDK_INT >= 28) {
            PackageInfo p = pm.getPackageInfo(c.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            sigs = p.signingInfo == null ? null : p.signingInfo.getApkContentsSigners();
        } else {
            sigs = pm.getPackageInfo(c.getPackageName(), PackageManager.GET_SIGNATURES).signatures;
        }
        if (sigs == null || sigs.length == 0) return null;
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(sigs[0].toByteArray());
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format(Locale.US, "%02x", b));
        return hex.toString();
    }

    private static void run(Activity a) throws Exception {
        JSONArray assets = new JSONObject(readText(LATEST)).getJSONArray("assets");
        String infoUrl = assetUrl(assets, "update.json");
        if (infoUrl == null) return;
        JSONObject info = new JSONObject(readText(infoUrl));
        long remote = info.getLong("versionCode");
        if (remote <= installedCode(a)) {
            forget(a);
            return;
        }
        String apkUrl = assetUrl(assets, info.getString("apk"));
        if (apkUrl == null) return;
        if (recentlyFailed(a, remote)) return;

        // An APK signed with another key cannot install over this one: Android refuses it whatever the user taps.
        String remoteCert = info.optString("cert", "");
        String myCert = certSha256(a);
        if (!remoteCert.isEmpty() && myCert != null && !remoteCert.equalsIgnoreCase(myCert)) {
            failed(a, remote, "Update " + info.optString("versionName", "") + " is signed with a different key than the app on this device, "
                    + "so Android cannot install it over the old one. Install " + info.optString("apk", "the APK")
                    + " by hand once from the GitHub release; after that the app updates itself again.");
            return;
        }

        // Installing from inside the app is a permission the user grants once ("install unknown apps").
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            a.runOnUiThread(() -> {
                try {
                    a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
                } catch (Exception e) { Log.w(TAG, "cannot open the install-permission screen: " + e); }
            });
            synchronized (Updater.class) { lastCheck = 0; } // look again as soon as the user is back
            return;
        }
        install(a, apkUrl, remote);
    }

    private static String assetUrl(JSONArray assets, String name) throws Exception {
        for (int i = 0; i < assets.length(); i++) {
            JSONObject o = assets.getJSONObject(i);
            if (name.equals(o.getString("name"))) return o.getString("browser_download_url");
        }
        return null;
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setRequestProperty("User-Agent", "FlixApp");
        c.setRequestProperty("Accept", "application/vnd.github+json");
        return c;
    }

    private static String readText(String url) throws Exception {
        HttpURLConnection c = open(url);
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally { c.disconnect(); }
    }

    /** Streams the download straight into an install session, so no file or FileProvider is needed. */
    private static void install(Context c, String apkUrl, long remote) throws Exception {
        HttpURLConnection conn = open(apkUrl);
        conn.setRequestProperty("Accept", "application/octet-stream");
        try {
            int code = conn.getResponseCode();
            long length = conn.getContentLength();
            if (code < 200 || code >= 300) throw new java.io.IOException("the APK download answered HTTP " + code);

            PackageInstaller pi = c.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            if (length > 0) params.setSize(length);
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            int id = pi.createSession(params);
            try (PackageInstaller.Session s = pi.openSession(id)) {
                long total = 0;
                try (InputStream in = conn.getInputStream(); OutputStream out = s.openWrite("flix.apk", 0, length)) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) { out.write(buf, 0, n); total += n; }
                    s.fsync(out);
                }
                // A truncated or error-page download would fail later with a message that says nothing useful.
                if (total < 4096 || (length > 0 && total != length)) {
                    pi.abandonSession(id);
                    failed(c, remote, "Flix could not download the update: the APK came back as " + total + " bytes.");
                    return;
                }
                Intent cb = new Intent(c, Result.class).setPackage(c.getPackageName());
                // The installer's verdict arrives in another process state: remember which version was being installed.
                prefs(c).edit().putLong(KEY_PENDING_CODE, remote).apply();
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(c, id, cb, flags).getIntentSender());
            } catch (Exception e) {
                pi.abandonSession(id);
                throw e;
            }
        } finally { conn.disconnect(); }
    }

    /**
     * The installer's verdict. When it needs a tap from the user it shows its prompt; every other outcome -- a
     * success, a refusal, a cancelled session -- is said out loud, because a silent failure looks like a bug.
     */
    public static class Result extends BroadcastReceiver {
        @SuppressWarnings("deprecation")
        @Override
        public void onReceive(Context c, Intent i) {
            int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -1);
            String message = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return;
            }
            if (status == PackageInstaller.STATUS_SUCCESS) {
                Log.i(TAG, "update installed");
                forget(c);
                return;
            }
            Log.w(TAG, "install status " + status + ": " + message);
            String said = message == null ? "" : message;
            long code = prefs(c).getLong(KEY_PENDING_CODE, 0);
            if (said.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE") || said.contains("INSTALL_FAILED_ALREADY_EXISTS")) {
                said = "This update is signed with a different key than the Flix on this device, so Android will not install it. Install the APK by hand once from the GitHub release.";
            } else if (said.isEmpty()) {
                said = "Android refused the update (status " + status + ").";
            }
            failed(c, code, said);
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean recentlyFailed(Context c, long remote) {
        SharedPreferences p = prefs(c);
        return p.getLong(KEY_FAILED_CODE, 0) == remote && System.currentTimeMillis() - p.getLong(KEY_FAILED_AT, 0) < RETRY_MS;
    }

    private static void forget(Context c) {
        prefs(c).edit().remove(KEY_FAILED_CODE).remove(KEY_FAILED_AT).remove(KEY_MESSAGE).remove(KEY_PENDING_CODE).apply();
    }

    /** Records why an update did not land: shown now, and again on the next launch if this one is missed. */
    private static void failed(Context c, long remote, String message) {
        prefs(c).edit().putLong(KEY_FAILED_CODE, remote).putLong(KEY_FAILED_AT, System.currentTimeMillis())
                .putString(KEY_MESSAGE, message).apply();
        Log.w(TAG, message);
        toast(c, message);
    }

    private static void toast(Context c, String message) {
        Context app = c.getApplicationContext();
        new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(app, message, Toast.LENGTH_LONG).show());
    }
}
