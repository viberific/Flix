package com.viberific.flix;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Flix as an app: a full-screen WebView on the Flix server, so it is exactly the web app, with nothing to keep in step.
 * The first launch asks for the server's address and remembers it; the Menu key (or a server that cannot be reached)
 * brings that screen back. On a TV the web app is told it is on a TV, so it switches to its remote-friendly layout.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "flix", KEY_URL = "server";
    private static final int BG = 0xFF090B0F;

    private FrameLayout root;
    private FrameLayout stage;
    private WebView web;
    private View setup, fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        immersive();

        String url = prefs().getString(KEY_URL, null);
        if (url == null) showSetup(null);
        else openFlix(url, state);
    }

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    private boolean isTv() {
        UiModeManager ui = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void openFlix(String url, Bundle state) {
        if (setup != null) { root.removeView(setup); setup = null; }
        if (web == null) {
            web = new WebView(this);
            web.setBackgroundColor(BG);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false); // the intro chime and autoplay of the next episode
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
            web.setOverScrollMode(View.OVER_SCROLL_NEVER); // no glow at the ends of a long page
            // The page is drawn edge to edge (see the immersive flags further down), so on a phone it ran under the
            // status bar and the camera cutout and the search bar sat behind them. Padding the WebView itself does not
            // move its content -- a WebView lays the page out across its whole width whatever its padding -- so the
            // WebView goes inside a wrapper and the wrapper is padded: then the view really is narrower and the page is
            // laid out inside it. All four sides, because this app is used sideways as much as upright; on a television
            // every inset is zero, so the picture keeps the whole screen. The native video view is a sibling of the
            // wrapper, added straight to root, so a fullscreen film is never letterboxed.
            stage = new FrameLayout(this);
            stage.setBackgroundColor(BG);
            stage.setOnApplyWindowInsetsListener((view, insets) -> {
                int top, bottom, left, right;
                if (Build.VERSION.SDK_INT >= 30) {
                    // Ignoring visibility: a status bar swiped in over a fullscreen page must not re-lay out the page
                    // under it and back again, which is what made the picture jump on a phone.
                    android.graphics.Insets bars = insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars());
                    android.graphics.Insets cut = insets.getInsets(WindowInsets.Type.displayCutout());
                    top = Math.max(bars.top, cut.top);
                    bottom = Math.max(bars.bottom, cut.bottom);
                    left = Math.max(bars.left, cut.left);
                    right = Math.max(bars.right, cut.right);
                } else {
                    // Before Android 11 the cutout is asked for separately, and in fullscreen the system-bar inset is
                    // often zero where the cutout's is not.
                    top = insets.getSystemWindowInsetTop();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                    right = insets.getSystemWindowInsetRight();
                    if (Build.VERSION.SDK_INT >= 28 && insets.getDisplayCutout() != null) {
                        android.view.DisplayCutout c = insets.getDisplayCutout();
                        top = Math.max(top, c.getSafeInsetTop());
                        bottom = Math.max(bottom, c.getSafeInsetBottom());
                        left = Math.max(left, c.getSafeInsetLeft());
                        right = Math.max(right, c.getSafeInsetRight());
                    }
                }
                if (view.getPaddingTop() != top || view.getPaddingBottom() != bottom
                        || view.getPaddingLeft() != left || view.getPaddingRight() != right) {
                    view.setPadding(left, top, right, bottom);
                }
                return insets;
            });
            if (isTv()) s.setUserAgentString(s.getUserAgentString() + " Android TV FlixApp");
            else s.setUserAgentString(s.getUserAgentString() + " FlixApp");
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                    return false; // everything, sign-in links included, stays inside the app
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                    if (req.isForMainFrame()) showSetup("Couldn’t reach Flix at " + req.getUrl() + " (" + err.getDescription() + ").");
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                // Video fullscreen (requestFullscreen) shows the element's view over everything else.
                @Override
                public void onShowCustomView(View view, CustomViewCallback cb) {
                    if (fullscreenView != null) { cb.onCustomViewHidden(); return; }
                    fullscreenView = view; fullscreenCallback = cb;
                    root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    immersive();
                }

                @Override
                public void onHideCustomView() { leaveFullscreen(); }

                // A <video> with no picture of its own is given this one by the WebView: by default a low-res grey play button,
                // which showed through while an episode loaded. Fully transparent instead, so the player's own black is all there is.
                @Override
                public android.graphics.Bitmap getDefaultVideoPoster() {
                    return android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888);
                }
            });
            root.addView(stage, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            stage.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            stage.requestApplyInsets(); // the padding above is set the moment the window reports its insets
            web.requestFocus();
        }
        if (state == null || web.restoreState(state) == null) web.loadUrl(url);
    }

    private void leaveFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
        immersive();
    }

    /** The "where is your Flix?" screen: one field and a button, sized for a TV and usable with a remote. */
    private void showSetup(String error) {
        if (setup != null) root.removeView(setup);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(BG);
        int pad = dp(32);
        box.setPadding(pad, pad, pad, pad);

        TextView title = text("Flix", 40, Color.WHITE);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        box.addView(title);
        TextView hint = text("Enter the address of your Flix server, the same one you open in a browser.", 18, 0xFFB8BCC6);
        hint.setPadding(0, dp(12), 0, dp(20));
        box.addView(hint);
        if (error != null) {
            TextView err = text(error, 16, 0xFFFF8A80);
            err.setPadding(0, 0, 0, dp(16));
            box.addView(err);
        }

        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setImeOptions(EditorInfo.IME_ACTION_GO);
        field.setHint("http://umbrel.local:8096");
        field.setHintTextColor(0xFF6B7080);
        field.setTextColor(Color.WHITE);
        field.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        field.setText(prefs().getString(KEY_URL, ""));
        field.setBackground(rounded(0xFF1A1E27, 0xFF3A3F4B));
        field.setPadding(dp(16), dp(12), dp(16), dp(12));
        box.addView(field, new LinearLayout.LayoutParams(Math.min(dp(560), getResources().getDisplayMetrics().widthPixels - 2 * pad), ViewGroup.LayoutParams.WRAP_CONTENT));

        Button go = new Button(this);
        go.setText("Connect");
        go.setAllCaps(false);
        go.setTextColor(Color.WHITE);
        go.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        go.setBackground(rounded(0xFFFF3D6E, 0));
        go.setPadding(dp(32), dp(12), dp(32), dp(12));
        // On a television the remote's focus must be unmistakable: the button lifts and gains a white edge, not just a
        // slight dimming.
        go.setOnFocusChangeListener((v, focused) -> {
            v.setAlpha(focused ? 1f : 0.85f);
            v.setScaleX(focused ? 1.05f : 1f);
            v.setScaleY(focused ? 1.05f : 1f);
            v.setBackground(rounded(0xFFFF3D6E, focused ? 0xFFFFFFFF : 0));
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(20);
        box.addView(go, lp);

        Runnable connect = () -> {
            String url = normalize(field.getText().toString());
            if (url == null) { field.setError("Enter an address like http://umbrel.local:8096"); return; }
            prefs().edit().putString(KEY_URL, url).apply();
            if (web != null) web.clearHistory();
            openFlix(url, null);
        };
        go.setOnClickListener(v -> connect.run());
        field.setOnEditorActionListener((v, action, ev) -> { connect.run(); return true; });

        setup = box;
        root.addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        (field.getText().length() > 0 ? go : field).requestFocus();
    }

    private static String normalize(String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "http://" + s;
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return null;
        return s.endsWith("/") ? s : s + "/";
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    private GradientDrawable rounded(int fill, int stroke) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(12));
        if (stroke != 0) d.setStroke(dp(1), stroke);
        return d;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @SuppressWarnings("deprecation")
    private void immersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) immersive();
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_MENU && setup == null) { showSetup(null); return true; }
        return super.onKeyDown(code, e);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (fullscreenView != null) { leaveFullscreen(); return; }
        if (setup != null && web != null && prefs().getString(KEY_URL, null) != null) { root.removeView(setup); setup = null; web.requestFocus(); return; }
        if (web != null) {
            // The page gets Back first. A WebView never hands the Back key to the page as a key press, so with the
            // captions list open Back went straight past it and out of the episode, leaving the player's bar to be
            // cleared by opening the episode again. The player answers true when it used the press (it closed a list,
            // or left for the show's page); anything else is the browser's ordinary back.
            web.evaluateJavascript("(function(){try{return !!(window.__flixBack&&window.__flixBack())}catch(e){return false}})()", result -> {
                if ("true".equals(result)) return;
                if (web != null && web.canGoBack()) web.goBack();
                else defaultBack();
            });
            return;
        }
        super.onBackPressed();
    }

    @SuppressWarnings("deprecation")
    private void defaultBack() { super.onBackPressed(); }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush(); // keep the sign-in if the TV kills the app in the background
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        Updater.showPendingMessage(this);
        Updater.check(this);
    }

    @Override
    protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
