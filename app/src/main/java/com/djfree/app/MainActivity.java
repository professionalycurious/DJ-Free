package com.djfree.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.Dialog;
import android.content.ContentValues;
import android.content.Intent;
import android.content.res.AssetManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * Native shell for DJ Free. The whole DJ engine lives in assets/www and runs on the
 * Web Audio API inside a WebView. Assets are served from a virtual https origin so that
 * AudioWorklets (secure context only) and MusicKit JS work.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    private static final int FILE_REQ = 4242;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Dialog popupDialog;
    private final Map<String, ByteArrayOutputStream> pendingSaves = new HashMap<>();

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setVolumeControlStream(AudioManager.STREAM_MUSIC); // volume keys = media volume
        hideSystemUi();

        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0D12);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " DJFreeApp/1.0");
        WebView.setWebContentsDebuggingEnabled(true);

        web.addJavascriptInterface(new Bridge(), "DJNative");
        web.setWebViewClient(new LocalClient());
        web.setWebChromeClient(new Chrome());
        setContentView(web);

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(ORIGIN + "/index.html");
    }

    private void hideSystemUi() {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    // Keep audio running when the screen turns off / app goes to background:
    // we intentionally do NOT call web.onPause() / pauseTimers().
    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.DJ && window.DJ.onBack ? window.DJ.onBack() : false", v -> {
            if (!"true".equals(v)) {
                if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_REQ && fileCallback != null) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** Serves assets/www on https://appassets.androidplatform.net and a small CORS proxy for Apple preview audio. */
    private class LocalClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.equals("/__proxy")) return proxy(u.getQueryParameter("url"));
            if (path.equals("/")) path = "/index.html";
            try {
                AssetManager am = getAssets();
                InputStream in = am.open("www" + path);
                WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "no-cache");
                h.put("Access-Control-Allow-Origin", "*");
                r.setResponseHeaders(h);
                return r;
            } catch (Exception e) {
                return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            String host = req.getUrl().getHost();
            return !(HOST.equals(host) || (host != null && host.endsWith("apple.com")));
        }
    }

    private static boolean allowedProxyHost(String host) {
        if (host == null) return false;
        host = host.toLowerCase();
        return host.endsWith(".apple.com") || host.equals("apple.com")
                || host.endsWith(".mzstatic.com") || host.endsWith(".itunes.com");
    }

    private WebResourceResponse proxy(String target) {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        try {
            URL url = new URL(target);
            if (!"https".equals(url.getProtocol()) || !allowedProxyHost(url.getHost())) {
                return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", h, null);
            }
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            int code = c.getResponseCode();
            String type = c.getContentType() == null ? "application/octet-stream" : c.getContentType().split(";")[0];
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String reason = c.getResponseMessage() == null ? "OK" : c.getResponseMessage();
            return new WebResourceResponse(type, "utf-8", code, reason, h, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", h, null);
        }
    }

    private static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = cb;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("audio/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "video/mp4", "application/ogg"});
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            try {
                startActivityForResult(i, FILE_REQ);
            } catch (Exception e) {
                fileCallback = null;
                cb.onReceiveValue(null);
                return false;
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }

        /** MusicKit sign-in opens a popup window; host it in a full-screen dialog. */
        @SuppressLint("SetJavaScriptEnabled")
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            WebView popup = new WebView(MainActivity.this);
            popup.getSettings().setJavaScriptEnabled(true);
            popup.getSettings().setDomStorageEnabled(true);
            popup.getSettings().setSupportMultipleWindows(false);
            popup.setWebViewClient(new WebViewClient());
            popup.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onCloseWindow(WebView w) {
                    if (popupDialog != null) popupDialog.dismiss();
                }
            });
            popupDialog = new Dialog(MainActivity.this, android.R.style.Theme_Black_NoTitleBar_Fullscreen);
            popupDialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            popupDialog.setContentView(popup, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            popupDialog.setOnDismissListener(d -> popup.destroy());
            popupDialog.show();
            WebView.WebViewTransport t = (WebView.WebViewTransport) resultMsg.obj;
            t.setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }
    }

    /** JS -> native bridge (window.DJNative). */
    private class Bridge {
        @JavascriptInterface
        public boolean isAndroid() { return true; }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void saveBegin(String id) {
            synchronized (pendingSaves) { pendingSaves.put(id, new ByteArrayOutputStream()); }
        }

        @JavascriptInterface
        public void saveChunk(String id, String base64) {
            synchronized (pendingSaves) {
                ByteArrayOutputStream b = pendingSaves.get(id);
                if (b == null) return;
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                b.write(bytes, 0, bytes.length);
            }
        }

        /** Writes the recorded mix to Music/DJ Free (or the app folder on old Android). Returns a display path or "" on error. */
        @JavascriptInterface
        public String saveEnd(String id, String fileName, String mimeType) {
            ByteArrayOutputStream b;
            synchronized (pendingSaves) { b = pendingSaves.remove(id); }
            if (b == null) return "";
            byte[] data = b.toByteArray();
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Audio.Media.DISPLAY_NAME, fileName);
                    v.put(MediaStore.Audio.Media.MIME_TYPE, mimeType);
                    v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/DJ Free");
                    Uri uri = getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) return "";
                        os.write(data);
                    }
                    return "Music/DJ Free/" + fileName;
                } else {
                    File dir = new File(getExternalFilesDir(Environment.DIRECTORY_MUSIC), "DJ Free");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File f = new File(dir, fileName);
                    try (FileOutputStream os = new FileOutputStream(f)) { os.write(data); }
                    return f.getAbsolutePath();
                }
            } catch (Exception e) {
                return "";
            }
        }
    }
}
