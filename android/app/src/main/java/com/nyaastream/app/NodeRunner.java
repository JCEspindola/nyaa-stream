package com.nyaastream.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Runs the app's Node.js server (assets/nodejs-project/main.js) on its own
 * thread. Node can only be started once per process, so this is a singleton.
 */
final class NodeRunner {
    static final int PORT = 11471;
    static final String BASE_URL = "http://127.0.0.1:" + PORT;
    private static final String TAG = "NyaaStream";
    private static final String PROJECT = "nodejs-project";
    private static boolean started;

    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    private static native int startNodeWithArguments(String[] arguments);

    private NodeRunner() {}

    static synchronized void start(Context context) {
        if (started) return;
        started = true;
        Context app = context.getApplicationContext();
        Thread thread = new Thread(null, () -> {
            try {
                File project = new File(app.getFilesDir(), PROJECT);
                copyProjectIfChanged(app.getAssets(), project);
                startNodeWithArguments(new String[] {
                    "node",
                    new File(project, "main.js").getAbsolutePath(),
                    app.getFilesDir().getAbsolutePath(),
                    app.getCacheDir().getAbsolutePath(),
                });
            } catch (Exception e) {
                Log.e(TAG, "Node failed to start", e);
            }
        }, "node", 64L * 1024 * 1024); // Node wants a big stack
        thread.setDaemon(true);
        thread.start();
    }

    /** Copies the bundled server out of the APK when this build's version differs. */
    private static void copyProjectIfChanged(AssetManager assets, File project) throws IOException {
        String version = read(assets.open(PROJECT + "/version.txt"));
        File marker = new File(project, "version.txt");
        if (marker.exists() && version.equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) return;
        deleteRecursively(project);
        copyAssetDir(assets, PROJECT, project);
    }

    private static void copyAssetDir(AssetManager assets, String from, File to) throws IOException {
        String[] children = assets.list(from);
        if (children == null || children.length == 0) {
            to.getParentFile().mkdirs();
            try (InputStream in = assets.open(from); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return;
        }
        to.mkdirs();
        for (String child : children) copyAssetDir(assets, from + "/" + child, new File(to, child));
    }

    private static void deleteRecursively(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursively(c);
        f.delete();
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream s = in) {
            return new String(s.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
