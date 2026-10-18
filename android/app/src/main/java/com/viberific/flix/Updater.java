package com.viberific.flix;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps the APK current without a reinstall: asks GitHub for the latest release, and when the update.json attached
 * by the build workflow names a newer versionCode than the one running, downloads that APK and hands it to the
 * system installer. Installing over the running app needs the same signing key as the build that is installed.
 */
public class Updater {
    private static final String LATEST = "https://api.github.com/repos/viberific/flix/releases/latest";
    private static final long EVERY_MS = 15 * 60 * 1000;
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
            try { run(a); } catch (Exception ignored) { /* offline or GitHub unreachable: try again later */ }
            finally { synchronized (Updater.class) { busy = false; } }
        });
        t.setDaemon(true);
        t.start();
    }

    @SuppressWarnings("deprecation")
    private static long installedCode(Context c) throws Exception {
        PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
    }

    private static void run(Activity a) throws Exception {
        JSONArray assets = new JSONObject(readText(LATEST)).getJSONArray("assets");
        String infoUrl = assetUrl(assets, "update.json");
        if (infoUrl == null) return;
        JSONObject info = new JSONObject(readText(infoUrl));
        if (info.getLong("versionCode") <= installedCode(a)) return;
        String apkUrl = assetUrl(assets, info.getString("apk"));
        if (apkUrl == null) return;

        // Installing from inside the app is a permission the user grants once ("install unknown apps").
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            a.runOnUiThread(() -> {
                try {
                    a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName())));
                } catch (Exception ignored) { }
            });
            synchronized (Updater.class) { lastCheck = 0; } // look again as soon as the user is back
            return;
        }
        install(a, apkUrl);
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
    private static void install(Context c, String apkUrl) throws Exception {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = pi.createSession(params);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            HttpURLConnection conn = open(apkUrl);
            conn.setRequestProperty("Accept", "application/octet-stream");
            try (InputStream in = conn.getInputStream(); OutputStream out = s.openWrite("flix.apk", 0, -1)) {
                byte[] buf = new byte[65536];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            } finally { conn.disconnect(); }
            Intent cb = new Intent(c, Result.class).setPackage(c.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(c, id, cb, flags).getIntentSender());
        } catch (Exception e) {
            pi.abandonSession(id);
            throw e;
        }
    }

    /** The installer's verdict. When it needs a tap from the user (first update, or an older Android) it shows its prompt. */
    public static class Result extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            if (i.getIntExtra(PackageInstaller.EXTRA_STATUS, -1) != PackageInstaller.STATUS_PENDING_USER_ACTION) return;
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }
}
