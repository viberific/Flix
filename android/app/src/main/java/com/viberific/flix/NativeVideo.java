package com.viberific.flix;

import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioCapabilities;
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * The TV's own player, under the web app's controls (see public/nativevideo.js for the page's half).
 *
 * A WebView has no AC-3 / E-AC-3 decoder, so every 5.1 WEB-DL used to be served as a playlist with its sound converted to
 * stereo on the box -- slow to start from a cold drive, and the surround thrown away. ExoPlayer hands the untouched Dolby
 * track to the television (passthrough), or decodes it with the device's own Dolby decoder, so the box sends the file as
 * it is and does no work at all.
 *
 * The picture is drawn on a SurfaceView BEHIND the WebView; the page makes itself transparent over it while it plays, so
 * the controls, the wait screen and the subtitles are exactly the web app's. Calls arrive from the page on a binder thread
 * and are posted to the main thread, which is the only one ExoPlayer may be touched from. The player's state goes back to
 * the page as a small JSON snapshot on every change and twice a second while something is loaded.
 *
 * Only on a television: caps() reports nothing anywhere else, so a phone's page never asks the box for a native play.
 */
final class NativeVideo {
    private final Activity act;
    private final FrameLayout root;
    private final View stage;
    private final WebView web;
    private final int bg;
    private final boolean tv;
    private final Handler main = new Handler(Looper.getMainLooper());

    private ExoPlayer player;
    private FrameLayout holder;
    private SurfaceView surface;
    private int videoW, videoH;
    private int seekAsked, seekArrived, seekDone;
    private String error;

    NativeVideo(Activity act, FrameLayout root, View stage, WebView web, int bg, boolean tv) {
        this.act = act; this.root = root; this.stage = stage; this.web = web; this.bg = bg; this.tv = tv;
    }

    private final Runnable pump = new Runnable() {
        @Override public void run() {
            if (player == null) return;
            send();
            main.postDelayed(this, 500);
        }
    };

    // ---- what the page calls --------------------------------------------------------------------------------------------

    /** The sound codecs this device plays as they are: passed through to the television, or a Dolby decoder of its own. */
    @JavascriptInterface
    public String caps() {
        JSONArray audio = new JSONArray();
        if (tv) {
            AudioCapabilities ac = null;
            try { ac = audioCapabilities(); } catch (Throwable ignored) { /* none known */ }
            if (takes(ac, C.ENCODING_AC3, MimeTypes.AUDIO_AC3)) audio.put("ac3");
            if (takes(ac, C.ENCODING_E_AC3, MimeTypes.AUDIO_E_AC3)) audio.put("eac3");
        }
        try { return new JSONObject().put("audio", audio).toString(); } catch (Exception e) { return "{\"audio\":[]}"; }
    }

    @SuppressWarnings("deprecation")
    private AudioCapabilities audioCapabilities() { return AudioCapabilities.getCapabilities(act); }

    private static boolean takes(AudioCapabilities ac, int encoding, String mime) {
        if (ac != null && ac.supportsEncoding(encoding)) return true;
        try { return !MediaCodecUtil.getDecoderInfos(mime, false, false).isEmpty(); } catch (Throwable e) { return false; }
    }

    @JavascriptInterface public void load(String url, double startSec, boolean play) { main.post(() -> doLoad(url, startSec, play)); }
    @JavascriptInterface public void play() { main.post(() -> { if (player != null) { player.play(); send(); } }); }
    @JavascriptInterface public void pause() { main.post(() -> { if (player != null) { player.pause(); send(); } }); }
    @JavascriptInterface public void seek(double sec, int id) {
        main.post(() -> {
            if (player == null) return;
            seekAsked = id;
            player.seekTo(Math.max(0, Math.round(sec * 1000)));
            send();
        });
    }
    @JavascriptInterface public void stop() { main.post(this::release); }

    // ---- the activity ---------------------------------------------------------------------------------------------------

    void onPause() { if (player != null) { player.pause(); send(); } }

    void release() {
        main.removeCallbacks(pump);
        if (player != null) { player.release(); player = null; }
        if (holder != null) { root.removeView(holder); holder = null; surface = null; }
        videoW = videoH = 0; error = null; seekAsked = seekArrived = seekDone = 0;
        // The page is opaque again: the WebView and its frame go back to the app's own background.
        web.setBackgroundColor(bg);
        stage.setBackgroundColor(bg);
    }

    // ---- inside ---------------------------------------------------------------------------------------------------------

    private void doLoad(String url, double startSec, boolean play) {
        release();
        // Only the server this app is pointed at: the bridge is open to the page, and the page is that server's.
        Uri page = Uri.parse(String.valueOf(web.getUrl()));
        Uri media = Uri.parse(url);
        if (page.getHost() == null || !page.getHost().equalsIgnoreCase(media.getHost())) {
            error = "refused a link to another host";
            send();
            return;
        }
        holder = new FrameLayout(act);
        holder.setBackgroundColor(Color.BLACK);
        surface = new SurfaceView(act);
        holder.addView(surface, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        root.addView(holder, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        holder.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> { if (r - l != or - ol || b - t != ob - ot) fit(); });
        web.setBackgroundColor(Color.TRANSPARENT);
        stage.setBackgroundColor(Color.TRANSPARENT);

        Map<String, String> headers = new HashMap<>();
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) headers.put("Cookie", cookie);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
            .setUserAgent("FlixApp")
            .setConnectTimeoutMs(30_000)
            .setReadTimeoutMs(60_000)
            .setDefaultRequestProperties(headers);
        player = new ExoPlayer.Builder(act).setMediaSourceFactory(new DefaultMediaSourceFactory(http)).build();
        player.setVideoSurfaceView(surface);
        player.addListener(new Player.Listener() {
            @Override public void onEvents(Player p, Player.Events events) { send(); }
            @Override public void onPlayerError(PlaybackException e) {
                error = e.getErrorCodeName() + ": " + e.getMessage();
                send();
            }
            @Override public void onVideoSizeChanged(VideoSize size) {
                videoW = Math.round(size.width * (size.pixelWidthHeightRatio > 0 ? size.pixelWidthHeightRatio : 1f));
                videoH = size.height;
                fit();
            }
            @Override public void onPositionDiscontinuity(Player.PositionInfo o, Player.PositionInfo n, int reason) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK) seekArrived = seekAsked;
            }
        });
        player.setMediaItem(MediaItem.fromUri(media), Math.max(0, Math.round(startSec * 1000)));
        player.setPlayWhenReady(play);
        player.prepare();
        main.post(pump);
    }

    /** The picture as large as fits, its own shape kept, centred: what object-fit: contain did for the page's <video>. */
    private void fit() {
        if (holder == null || surface == null || videoW <= 0 || videoH <= 0) return;
        int w = holder.getWidth(), h = holder.getHeight();
        if (w <= 0 || h <= 0) return;
        int fw = w, fh = Math.round((float) w * videoH / videoW);
        if (fh > h) { fh = h; fw = Math.round((float) h * videoW / videoH); }
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(fw, fh, Gravity.CENTER);
        surface.setLayoutParams(lp);
    }

    private void send() {
        if (web == null) return;
        try {
            JSONObject o = new JSONObject();
            if (player != null) {
                int st = player.getPlaybackState();
                if (st == Player.STATE_READY) seekDone = seekArrived;
                long dur = player.getDuration();
                o.put("pos", player.getCurrentPosition() / 1000.0)
                    .put("dur", dur == C.TIME_UNSET ? 0 : dur / 1000.0)
                    .put("buf", player.getBufferedPosition() / 1000.0)
                    .put("st", st)
                    .put("playing", player.isPlaying())
                    .put("pwr", player.getPlayWhenReady())
                    .put("w", videoW).put("h", videoH)
                    .put("seekDone", seekDone);
            }
            if (error != null) o.put("err", error);
            web.evaluateJavascript("window.__flixNative&&window.__flixNative(" + o + ")", null);
        } catch (Exception ignored) { /* a snapshot that could not be made is skipped; the next one follows */ }
    }
}
