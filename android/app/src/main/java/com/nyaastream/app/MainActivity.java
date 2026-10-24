package com.nyaastream.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * The app's main screen: starts the bundled server and shows the same web UI
 * as the desktop version in a WebView. Video plays in {@link PlayerActivity}.
 */
public class MainActivity extends Activity {
    /** Intent extra: a page (URL hash) to show, e.g. from the download notification. */
    public static final String EXTRA_OPEN = "open";
    private static final int REQ_PLAYER = 1;
    private static final int REQ_SAVE_FILE = 2;
    private static final int REQ_PICK_FILE = 3;
    private static final int REQ_NOTIFICATIONS = 4;

    private WebView webView;
    private TextView splash;
    private ValueCallback<Uri[]> pendingFileChooser;
    private String pendingSaveContent;
    private final Handler main = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0f0d16"));
        getWindow().setNavigationBarColor(Color.parseColor("#0f0d16"));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0f0d16"));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0f0d16"));
        webView.setVisibility(View.INVISIBLE);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        splash = new TextView(this);
        splash.setText("Starting Nyaa Stream…");
        splash.setTextColor(Color.parseColor("#9c95ad"));
        splash.setTextSize(16);
        splash.setGravity(Gravity.CENTER);
        root.addView(splash, new FrameLayout.LayoutParams(-1, -1));
        // Android 15 draws apps edge to edge; keep the page clear of the status
        // bar, navigation bar and keyboard.
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            root.setFitsSystemWindows(true);
        }
        setContentView(root);

        // Debug builds only: lets Chrome DevTools (chrome://inspect) attach to the UI.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the library and progress live in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new Bridge(), "NyaaAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("127.0.0.1".equals(uri.getHost())) return false;
                // AniList / nyaa links open in the browser.
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                webView.setVisibility(View.VISIBLE);
                splash.setVisibility(View.GONE);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileChooser != null) pendingFileChooser.onReceiveValue(null);
                pendingFileChooser = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                startActivityForResult(Intent.createChooser(pick, "Import library"), REQ_PICK_FILE);
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            NodeRunner.start(this);
            waitForServerThenLoad();
        }
    }

    /** The server takes a few seconds to start; poll it, then show the UI. */
    private void waitForServerThenLoad() {
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + 60_000;
            while (System.currentTimeMillis() < deadline) {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(NodeRunner.BASE_URL + "/addon/manifest.json").openConnection();
                    c.setConnectTimeout(1000);
                    c.setReadTimeout(1000);
                    if (c.getResponseCode() == 200) {
                        String open = getIntent().getStringExtra(EXTRA_OPEN);
                        main.post(() -> webView.loadUrl(NodeRunner.BASE_URL + "/" + (open != null ? open : "")));
                        // Downloads left running when the app was last closed carry on.
                        DownloadService.startIfActive(this);
                        return;
                    }
                } catch (Exception ignored) {
                    // not up yet
                }
                try { Thread.sleep(300); } catch (InterruptedException e) { return; }
            }
            main.post(() -> splash.setText("The app's server did not start.\nPlease close and reopen Nyaa Stream."));
        }).start();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String open = intent.getStringExtra(EXTRA_OPEN);
        if (open != null && open.matches("#/[a-z]+")) webView.evaluateJavascript("location.hash = '" + open + "'", null);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PLAYER) {
            JSONObject r = new JSONObject();
            try {
                r.put("position", data != null ? data.getLongExtra("position", 0) : 0);
                r.put("duration", data != null ? data.getLongExtra("duration", 0) : 0);
                r.put("finished", data != null && data.getBooleanExtra("finished", false));
                r.put("error", data != null ? data.getStringExtra("error") : null);
            } catch (Exception ignored) {
                // JSONObject.put only throws for NaN keys
            }
            webView.evaluateJavascript("window.nyaaNativeResult && window.nyaaNativeResult(" + r + ")", null);
        } else if (requestCode == REQ_PICK_FILE) {
            if (pendingFileChooser != null) {
                pendingFileChooser.onReceiveValue(resultCode == RESULT_OK && data != null && data.getData() != null
                    ? new Uri[] { data.getData() } : null);
                pendingFileChooser = null;
            }
        } else if (requestCode == REQ_SAVE_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingSaveContent != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    out.write(pendingSaveContent.getBytes(StandardCharsets.UTF_8));
                    Toast.makeText(this, "Library exported", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(this, "Could not save the file: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
            pendingSaveContent = null;
        }
    }

    /** What the web UI can ask of Android (window.NyaaAndroid). */
    private class Bridge {
        @JavascriptInterface
        public void play(String json) {
            main.post(() -> {
                try {
                    JSONObject o = new JSONObject(json);
                    Intent i = new Intent(MainActivity.this, PlayerActivity.class)
                        .putExtra("url", o.getString("url"))
                        .putExtra("title", o.optString("title", "Nyaa Stream"))
                        .putExtra("startMs", o.optLong("startMs", 0))
                        .putExtra("subLang", o.optString("subLang", "eng"));
                    startActivityForResult(i, REQ_PLAYER);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Could not start playback", Toast.LENGTH_LONG).show();
                }
            });
        }

        @JavascriptInterface
        public void saveFile(String name, String content) {
            main.post(() -> {
                pendingSaveContent = content;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/json")
                    .putExtra(Intent.EXTRA_TITLE, name);
                startActivityForResult(i, REQ_SAVE_FILE);
            });
        }

        /** A download was added to the Offline Catalog: keep the app running until it finishes. */
        @JavascriptInterface
        public void watchDownloads() {
            main.post(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFICATIONS);
                }
                DownloadService.start(MainActivity.this);
            });
        }

        @JavascriptInterface
        public void copyText(String text) {
            main.post(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Nyaa Stream", text));
                Toast.makeText(MainActivity.this, "Copied", Toast.LENGTH_SHORT).show();
            });
        }
    }
}
