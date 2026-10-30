package com.viberific.flix.car;

import android.annotation.SuppressLint;
import android.app.Presentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.car.app.AppManager;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.SurfaceCallback;
import androidx.car.app.SurfaceContainer;
import androidx.car.app.hardware.CarHardwareManager;
import androidx.car.app.hardware.common.CarValue;
import androidx.car.app.hardware.common.OnCarDataAvailableListener;
import androidx.car.app.hardware.info.Speed;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.CarColor;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.Template;
import androidx.car.app.navigation.model.NavigationTemplate;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.lifecycle.DefaultLifecycleObserver;
import androidx.lifecycle.LifecycleOwner;

import com.viberific.flix.R;

/**
 * The same Flix web app as on the phone, drawn onto the car's screen. Android Auto lets an app draw only onto a
 * surface it is handed, so the page runs in a WebView on a virtual display of the phone, that display's output is
 * the car's surface, and the car's taps and drags are replayed into the WebView as touches. Cookies and storage are
 * the process-wide ones, so whoever is signed in on the phone is signed in here.
 *
 * The car always draws a strip of at least one button over the top of the surface (NavigationTemplate refuses to build
 * without one). The page has the whole surface regardless and is told where the strip reaches (--car-t, --car-r and
 * --car-b, in CSS pixels), so nothing sits in a band cut off the top: the strip holds Flix's own header (the logo, search
 * and the account menu) over the page's top band, and while an episode is open, the Flix mark and Back, over the picture.
 *
 * Parked only: while the car reports that it is moving, the page is paused and covered. A car that reports no speed
 * at all cannot be told from a parked one, and is treated as parked.
 */
final class FlixScreen extends Screen implements SurfaceCallback {
    private static final String PREFS = "flix", KEY_URL = "server";
    private static final int BG = 0xFF090B0F, ACCENT = 0xFFFF3D71;
    /** The page is laid out about this many CSS pixels wide whatever the car's resolution, so tiles are finger-sized. */
    private static final int CSS_WIDTH = 960;
    private static final float MOVING_MPS = 0.5f;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final OnCarDataAvailableListener<Speed> speedListener = this::onSpeed;

    private SurfaceContainer container;
    private VirtualDisplay display;
    private Presentation presentation;
    private FrameLayout root;
    private WebView web;
    private TextView cover;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private String lastUrl;
    private Rect visible;
    private boolean moving;
    /** An episode is open (see Bridge): the strip shows the Flix mark and Back, since the player has its own controls. */
    private boolean immersive;
    /** The maximized picture's own bar has faded (see Bridge): the strip keeps only the Flix mark, the least it may show. */
    private boolean quiet;

    // A drag in progress: car scrolls arrive as distances, so they are replayed as one finger moving from the middle.
    private boolean dragging;
    private long downTime;
    private float fx, fy;
    private final Runnable endDrag = this::finishDrag;

    FlixScreen(@NonNull CarContext carContext) {
        super(carContext);
        getLifecycle().addObserver(new DefaultLifecycleObserver() {
            @Override
            public void onCreate(@NonNull LifecycleOwner owner) {
                getCarContext().getCarService(AppManager.class).setSurfaceCallback(FlixScreen.this);
                watchSpeed();
            }

            @Override
            public void onDestroy(@NonNull LifecycleOwner owner) {
                unwatchSpeed();
                teardown();
            }
        });
    }

    @NonNull
    @Override
    public Template onGetTemplate() {
        ActionStrip.Builder strip = new ActionStrip.Builder();
        // While an episode plays: the mark, which does nothing, and Back to Flix's home. The player's own panel has the rest.
        // Back goes with the player's own bar when it fades over the maximized picture: the strip cannot be emptied or hidden.
        if (immersive) {
            strip.addAction(icon(R.drawable.ic_car_flix).setOnClickListener(() -> { }).build());
            if (!quiet) strip.addAction(icon(R.drawable.ic_car_back).setOnClickListener(() -> header("back")).build());
            return new NavigationTemplate.Builder().setActionStrip(strip.build()).build();
        }
        // Otherwise the strip is Flix's header: the logo goes home, then search and the account menu, which open the page's own.
        strip.addAction(icon(R.drawable.ic_car_flix).setOnClickListener(() -> header("home")).build())
                .addAction(icon(R.drawable.ic_car_search).setOnClickListener(() -> header("search")).build());
        Action.Builder profile = icon(R.drawable.ic_car_profile).setOnClickListener(() -> header("menu"));
        // The one button a car lets an app colour: Flix's red, as the avatar is on every other screen. Hosts before API 4 ignore it.
        if (getCarContext().getCarAppApiLevel() >= 4) profile.setFlags(Action.FLAG_PRIMARY).setBackgroundColor(CarColor.createCustom(ACCENT, ACCENT));
        return new NavigationTemplate.Builder().setActionStrip(strip.addAction(profile.build()).build()).build();
    }

    private Action.Builder icon(int res) {
        return new Action.Builder().setIcon(new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), res)).build());
    }

    /**
     * A tap on the strip's Flix header, handed to the page (window.__flixCar in public/app.js). A page that is not Flix, or
     * one that never finished loading, cannot answer, and the logo or Back then loads Flix afresh, as Home used to.
     */
    private void header(String what) {
        if (web == null) return;
        web.evaluateJavascript("!!(window.__flixCar&&window.__flixCar('" + what + "'))", r -> {
            String url = serverUrl();
            if (!"true".equals(r) && !"search".equals(what) && !"menu".equals(what) && web != null && url != null) web.loadUrl(url);
        });
    }

    private String serverUrl() {
        SharedPreferences p = getCarContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getString(KEY_URL, null);
    }

    // ---- speed ----

    private void watchSpeed() {
        try {
            getCarContext().getCarService(CarHardwareManager.class).getCarInfo()
                    .addSpeedListener(ContextCompat.getMainExecutor(getCarContext()), speedListener);
        } catch (Throwable ignored) {
            // No speed from this car or host: treated as parked (see the class comment).
        }
    }

    private void unwatchSpeed() {
        try {
            getCarContext().getCarService(CarHardwareManager.class).getCarInfo().removeSpeedListener(speedListener);
        } catch (Throwable ignored) {
        }
    }

    private void onSpeed(Speed speed) {
        CarValue<Float> v = speed.getRawSpeedMetersPerSecond();
        if (v.getStatus() != CarValue.STATUS_SUCCESS || v.getValue() == null) return;
        setMoving(v.getValue() > MOVING_MPS);
    }

    private void setMoving(boolean now) {
        if (moving == now) return;
        moving = now;
        applyCover();
    }

    /**
     * Pausing once when the car starts moving is not enough: the page plays on by itself (the Up next countdown opens the
     * next episode, which autoplays), and behind the cover that is sound with nobody meant to be watching. So the page is
     * told the car is moving, and while it is, anything that starts playing is paused at once. Sent again after every page
     * load, since a reload forgets it.
     */
    private static final String HOLD_JS = "(function(m){window.__flixCarMoving=m;"
            + "if(!window.__flixCarHold){window.__flixCarHold=1;document.addEventListener('play',function(e){if(window.__flixCarMoving&&e.target.pause)e.target.pause()},true)}"
            + "if(m)document.querySelectorAll('video,audio').forEach(function(x){x.pause()})})";

    private void applyCover() {
        if (cover == null) return;
        cover.setVisibility(moving ? View.VISIBLE : View.GONE);
        if (web != null) web.evaluateJavascript(HOLD_JS + "(" + moving + ")", null);
    }

    // ---- the surface ----

    @Override
    public void onSurfaceAvailable(@NonNull SurfaceContainer surface) {
        teardown();
        container = surface;
        if (surface.getSurface() == null) return;
        int w = surface.getWidth(), h = surface.getHeight();
        int dpi = Math.max(160, Math.min(320, w * 160 / CSS_WIDTH));
        DisplayManager dm = (DisplayManager) getCarContext().getSystemService(Context.DISPLAY_SERVICE);
        display = dm.createVirtualDisplay("FlixCar", w, h, dpi, surface.getSurface(), DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY);
        presentation = new Presentation(getCarContext(), display.getDisplay());
        root = new FrameLayout(presentation.getContext());
        root.setBackgroundColor(BG);
        presentation.setContentView(root);
        presentation.show();
        applyVisibleArea();

        String url = lastUrl != null ? lastUrl : serverUrl();
        if (url == null) {
            root.addView(message("Open Flix on your phone and enter your server's address first."));
            return;
        }
        openWeb(url);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void openWeb(String url) {
        Context c = presentation.getContext();
        web = new WebView(c);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " FlixApp FlixCar");
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new Bridge(), "FlixCar");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                // A new page has no player open: whatever the last one asked for is over.
                setImmersive(false);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                applyCover();
                applyVisibleArea();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (fullscreenView != null) { cb.onCustomViewHidden(); return; }
                fullscreenView = view; fullscreenCallback = cb;
                root.addView(view, 1, matchParent());
            }

            @Override
            public void onHideCustomView() {
                if (fullscreenView == null) return;
                root.removeView(fullscreenView);
                fullscreenView = null;
                if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
                fullscreenCallback = null;
            }

            @Override
            public android.graphics.Bitmap getDefaultVideoPoster() {
                return android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888);
            }
        });
        root.addView(web, matchParent());
        cover = message("Flix is for when the car is parked.");
        cover.setBackgroundColor(BG);
        root.addView(cover, matchParent());
        applyCover();
        web.loadUrl(url);
    }

    private TextView message(String text) {
        TextView t = new TextView(presentation.getContext());
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setTextSize(22);
        t.setGravity(Gravity.CENTER);
        t.setPadding(64, 64, 64, 64);
        return t;
    }

    private static FrameLayout.LayoutParams matchParent() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private void teardown() {
        main.removeCallbacks(endDrag);
        dragging = false;
        if (web != null) {
            lastUrl = web.getUrl();
            web.destroy();
            web = null;
        }
        fullscreenView = null;
        fullscreenCallback = null;
        immersive = false;
        quiet = false;
        cover = null;
        root = null;
        if (presentation != null) { presentation.dismiss(); presentation = null; }
        if (display != null) { display.release(); display = null; }
        container = null;
    }

    @Override
    public void onSurfaceDestroyed(@NonNull SurfaceContainer surface) {
        teardown();
    }

    @Override
    public void onVisibleAreaChanged(@NonNull Rect area) {
        visible = new Rect(area);
        applyVisibleArea();
    }

    /** What the page can ask of the car screen. Called on the WebView's own thread, so it is passed over to the main one. */
    private final class Bridge {
        @JavascriptInterface
        public void immersive(boolean on) {
            main.post(() -> setImmersive(on));
        }

        @JavascriptInterface
        public void quiet(boolean on) {
            main.post(() -> setQuiet(on));
        }
    }

    private void setQuiet(boolean on) {
        if (quiet == on) return;
        quiet = on;
        invalidate();
    }

    private void setImmersive(boolean on) {
        if (immersive == on) return;
        immersive = on;
        quiet = false;
        invalidate();
    }

    /**
     * Tells the page how far in the car's own buttons reach, so it can keep clear of them itself: the page always has the
     * whole surface, since padding it clear of them is what left a dark band across the top.
     */
    private void applyVisibleArea() {
        if (container == null || visible == null || web == null) return;
        int t = Math.max(0, visible.top);
        int r = Math.max(0, container.getWidth() - visible.right), b = Math.max(0, container.getHeight() - visible.bottom);
        web.evaluateJavascript("(function(t,r,b){var s=document.documentElement.style,d=window.devicePixelRatio||1;"
                + "s.setProperty('--car-t',t/d+'px');s.setProperty('--car-r',r/d+'px');s.setProperty('--car-b',b/d+'px')})(" + t + "," + r + "," + b + ")", null);
    }

    // ---- touch ----

    @Override
    public void onClick(float x, float y) {
        if (web == null || moving) return;
        finishDrag();
        long t = SystemClock.uptimeMillis();
        send(MotionEvent.ACTION_DOWN, t, t, x, y);
        main.postDelayed(() -> send(MotionEvent.ACTION_UP, t, SystemClock.uptimeMillis(), x, y), 50);
    }

    @Override
    public void onScroll(float distanceX, float distanceY) {
        if (web == null || container == null || moving) return;
        float w = container.getWidth(), h = container.getHeight();
        if (!dragging) {
            dragging = true;
            downTime = SystemClock.uptimeMillis();
            fx = w / 2;
            fy = h / 2;
            send(MotionEvent.ACTION_DOWN, downTime, downTime, fx, fy);
        }
        // The page follows the finger, and the car reports how far the content should move back.
        fx -= distanceX;
        fy -= distanceY;
        send(MotionEvent.ACTION_MOVE, downTime, SystemClock.uptimeMillis(), fx, fy);
        main.removeCallbacks(endDrag);
        // Near an edge the finger would run out of screen: lift it, and the next scroll starts again from the middle.
        if (fx < w * 0.1f || fx > w * 0.9f || fy < h * 0.1f || fy > h * 0.9f) finishDrag();
        else main.postDelayed(endDrag, 120);
    }

    @Override
    public void onFling(float velocityX, float velocityY) {
        finishDrag();
    }

    @Override
    public void onScale(float focusX, float focusY, float scaleFactor) {
    }

    private void finishDrag() {
        main.removeCallbacks(endDrag);
        if (!dragging) return;
        dragging = false;
        send(MotionEvent.ACTION_UP, downTime, SystemClock.uptimeMillis(), fx, fy);
    }

    private void send(int action, long down, long when, float x, float y) {
        if (web == null) return;
        MotionEvent e = MotionEvent.obtain(down, when, action, x, y, 0);
        e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        web.dispatchTouchEvent(e);
        e.recycle();
    }
}
