package com.nyaastream.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Keeps the app (and the Node server inside it) running while Offline Catalog
 * downloads are in progress, with a progress notification. The downloads
 * themselves happen in the server; this only watches /api/offline and stops
 * itself when nothing is left to download.
 */
public class DownloadService extends Service {
    private static final String CHANNEL_PROGRESS = "downloads";
    private static final String CHANNEL_ALERTS = "download-alerts";
    private static final int ID_PROGRESS = 1;
    private static final int ID_ALERT = 2;
    private static final long POLL_MS = 2000;

    private volatile boolean running;
    private Thread poller;
    private long startedAt;
    private final Set<String> reported = new HashSet<>();

    /** Start watching; called when a download is added. */
    public static void start(Context context) {
        Intent i = new Intent(context, DownloadService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    /** At app start: resume watching only if the server still has downloads running. */
    public static void startIfActive(Context context) {
        new Thread(() -> {
            try {
                if (fetchStatus().optInt("downloading") > 0) start(context);
            } catch (Exception ignored) {
                // server not answering: nothing to watch
            }
        }).start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannels();
        Notification n = progress("Preparing downloads…", 0, true);
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_PROGRESS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(ID_PROGRESS, n);
        if (!running) {
            running = true;
            startedAt = System.currentTimeMillis();
            poller = new Thread(this::poll, "offline-downloads");
            poller.start();
        }
        return START_NOT_STICKY;
    }

    private void poll() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        int idle = 0;
        while (running) {
            try {
                JSONArray items = fetchStatus().getJSONArray("items");
                int active = 0;
                long total = 0;
                double have = 0;
                double speed = 0;
                String first = null;
                for (int i = 0; i < items.length(); i++) {
                    JSONObject it = items.getJSONObject(i);
                    String status = it.optString("status");
                    String key = it.optString("key");
                    if ("downloading".equals(status)) {
                        active++;
                        long len = it.optLong("length");
                        total += len;
                        have += it.optDouble("progress") * len;
                        speed += it.optDouble("speed");
                        if (first == null) first = it.optString("title");
                    } else if ("failed".equals(status) && it.optLong("failedAt") > startedAt && reported.add(key + ":f")) {
                        // Cancelled (e.g. the device ran out of space): tell the user.
                        nm.notify(ID_ALERT + key.hashCode(), alert("Download cancelled", it.optString("title") + ": " + it.optString("error")));
                    } else if ("done".equals(status) && it.optLong("doneAt") > startedAt && reported.add(key + ":d")) {
                        nm.notify(ID_ALERT + key.hashCode(), alert("Ready to watch offline", it.optString("title")));
                    }
                }
                if (active == 0) {
                    // A just-added download may not be listed for a moment.
                    if (++idle >= 3) break;
                } else {
                    idle = 0;
                    int pct = total > 0 ? (int) (have * 100 / total) : 0;
                    String title = active == 1 ? first : String.format(Locale.US, "%d videos", active);
                    nm.notify(ID_PROGRESS, progress(String.format(Locale.US, "Downloading %s · %d%% · %s", title, pct, fmtSpeed(speed)), pct, false));
                }
            } catch (Exception ignored) {
                // server busy or restarting: try again
            }
            try { Thread.sleep(POLL_MS); } catch (InterruptedException e) { break; }
        }
        running = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private static JSONObject fetchStatus() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(NodeRunner.BASE_URL + "/api/offline").openConnection();
        c.setConnectTimeout(2000);
        c.setReadTimeout(5000);
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
        } finally {
            c.disconnect();
        }
    }

    private static String fmtSpeed(double b) {
        return b > 1048576 ? String.format(Locale.US, "%.1f MB/s", b / 1048576) : String.format(Locale.US, "%.0f KB/s", b / 1024);
    }

    private PendingIntent openCatalog() {
        Intent i = new Intent(this, MainActivity.class).putExtra(MainActivity.EXTRA_OPEN, "#/offline")
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification.Builder builder(String channel) {
        return Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channel) : new Notification.Builder(this);
    }

    private Notification progress(String text, int pct, boolean indeterminate) {
        return builder(CHANNEL_PROGRESS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Offline Catalog")
            .setContentText(text)
            .setProgress(100, pct, indeterminate)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openCatalog())
            .build();
    }

    private Notification alert(String title, String text) {
        return builder(CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openCatalog())
            .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_PROGRESS, "Download progress", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_ALERTS, "Finished and cancelled downloads", NotificationManager.IMPORTANCE_DEFAULT));
    }

    // Android 15 limits dataSync services to 6 hours a day; stop cleanly when told.
    @Override
    public void onTimeout(int startId) {
        running = false;
        if (poller != null) poller.interrupt();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        onTimeout(startId);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (poller != null) poller.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
