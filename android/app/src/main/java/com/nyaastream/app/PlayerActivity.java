package com.nyaastream.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;
import java.util.Locale;

/**
 * Full-screen player built on libVLC: plays the torrent stream from the local
 * server with any codec and styled (ASS) subtitles. Returns the position and
 * whether the episode finished, so the web UI can save progress and continue.
 */
public class PlayerActivity extends Activity {
    private static final int ACCENT = Color.parseColor("#7b5bf5");

    private LibVLC libVLC;
    private MediaPlayer player;
    private View controls;
    private SeekBar seek;
    private TextView time;
    private TextView status;
    private Button playPause;
    private boolean userSeeking;
    private boolean finished;
    private long startMs;
    private boolean startApplied;
    private long lastTimeChange;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable hideControls = () -> controls.setVisibility(View.GONE);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Intent in = getIntent();
        String url = in.getStringExtra("url");
        startMs = in.getLongExtra("startMs", 0);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        VLCVideoLayout videoLayout = new VLCVideoLayout(this);
        root.addView(videoLayout, new FrameLayout.LayoutParams(-1, -1));
        status = label("Connecting…", 15);
        status.setGravity(Gravity.CENTER);
        root.addView(status, new FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        controls = buildControls(in.getStringExtra("title"));
        root.addView(controls, new FrameLayout.LayoutParams(-1, -1));
        root.setOnClickListener(v -> toggleControls());
        setContentView(root);
        hideSystemBars();

        ArrayList<String> options = new ArrayList<>();
        options.add("--network-caching=5000"); // torrent pieces arrive in bursts
        options.add("--http-reconnect");
        options.add("--sub-language=" + in.getStringExtra("subLang") + ",eng,en");
        libVLC = new LibVLC(this, options);
        player = new MediaPlayer(libVLC);
        player.attachViews(videoLayout, null, true, false);
        Media media = new Media(libVLC, Uri.parse(url));
        media.setHWDecoderEnabled(true, false);
        player.setMedia(media);
        media.release();
        player.setEventListener(this::onPlayerEvent);
        player.play();
        showControls();
    }

    private void onPlayerEvent(MediaPlayer.Event e) {
        switch (e.type) {
            case MediaPlayer.Event.Buffering:
                // libVLC keeps reporting buffer refills during playback; only
                // show the label when the picture has actually stopped moving.
                float pct = e.getBuffering();
                boolean stalled = System.currentTimeMillis() - lastTimeChange > 1500;
                status.setText(String.format(Locale.US, "Buffering %.0f%%", pct));
                status.setVisibility(pct < 100 && stalled ? View.VISIBLE : View.GONE);
                break;
            case MediaPlayer.Event.Playing:
                status.setVisibility(View.GONE);
                playPause.setText("❚❚");
                if (!startApplied && startMs > 0) player.setTime(startMs);
                startApplied = true;
                break;
            case MediaPlayer.Event.Paused:
                playPause.setText("▶");
                break;
            case MediaPlayer.Event.TimeChanged:
                lastTimeChange = System.currentTimeMillis();
                status.setVisibility(View.GONE);
                updateTime();
                break;
            case MediaPlayer.Event.EndReached:
                finished = true;
                finishWithResult(null);
                break;
            case MediaPlayer.Event.EncounteredError:
                finishWithResult("This video could not be played.");
                break;
            default:
                break;
        }
    }

    private View buildControls(String title) {
        FrameLayout overlay = new FrameLayout(this);

        LinearLayout top = row();
        top.setBackgroundColor(Color.parseColor("#99000000"));
        Button back = button("←");
        back.setOnClickListener(v -> finishWithResult(null));
        top.addView(back);
        TextView titleView = label(title, 15);
        titleView.setSingleLine(true);
        top.addView(titleView, new LinearLayout.LayoutParams(0, -2, 1));
        overlay.addView(top, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setBackgroundColor(Color.parseColor("#99000000"));
        bottom.setPadding(dp(12), dp(4), dp(12), dp(8));
        seek = new SeekBar(this);
        seek.setProgressTintList(ColorStateList.valueOf(ACCENT));
        seek.setProgressBackgroundTintList(ColorStateList.valueOf(Color.parseColor("#66ffffff")));
        seek.setThumbTintList(ColorStateList.valueOf(ACCENT));
        seek.setMax(1000);
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                if (fromUser) time.setText(fmt(player.getLength() * p / 1000) + " / " + fmt(player.getLength()));
            }
            @Override public void onStartTrackingTouch(SeekBar s) { userSeeking = true; handler.removeCallbacks(hideControls); }
            @Override public void onStopTrackingTouch(SeekBar s) {
                userSeeking = false;
                if (player.getLength() > 0) player.setTime(player.getLength() * s.getProgress() / 1000);
                showControls();
            }
        });
        bottom.addView(seek);
        LinearLayout buttons = row();
        playPause = button("▶");
        playPause.setOnClickListener(v -> { if (player.isPlaying()) player.pause(); else player.play(); showControls(); });
        Button rew = button("−10s");
        rew.setOnClickListener(v -> { player.setTime(Math.max(0, player.getTime() - 10_000)); showControls(); });
        Button fwd = button("+10s");
        fwd.setOnClickListener(v -> { player.setTime(player.getTime() + 10_000); showControls(); });
        time = label("0:00 / --:--", 13);
        Button audio = button("Audio");
        audio.setOnClickListener(v -> pickTrack(true));
        Button subs = button("Subtitles");
        subs.setOnClickListener(v -> pickTrack(false));
        buttons.addView(playPause);
        buttons.addView(rew);
        buttons.addView(fwd);
        buttons.addView(time, new LinearLayout.LayoutParams(0, -2, 1));
        buttons.addView(audio);
        buttons.addView(subs);
        bottom.addView(buttons);
        overlay.addView(bottom, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        overlay.setOnClickListener(v -> toggleControls());
        return overlay;
    }

    /** Audio or subtitle track list from the file, as libVLC sees it. */
    private void pickTrack(boolean audio) {
        MediaPlayer.TrackDescription[] tracks = audio ? player.getAudioTracks() : player.getSpuTracks();
        if (tracks == null || tracks.length == 0) return;
        String[] names = new String[tracks.length];
        int current = audio ? player.getAudioTrack() : player.getSpuTrack();
        int checked = -1;
        for (int i = 0; i < tracks.length; i++) {
            names[i] = tracks[i].name;
            if (tracks[i].id == current) checked = i;
        }
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(audio ? "Audio" : "Subtitles")
            .setSingleChoiceItems(names, checked, (d, which) -> {
                if (audio) player.setAudioTrack(tracks[which].id); else player.setSpuTrack(tracks[which].id);
                d.dismiss();
            })
            .show();
    }

    private void updateTime() {
        long len = player.getLength();
        long t = player.getTime();
        if (!userSeeking && len > 0) seek.setProgress((int) (t * 1000 / len));
        if (!userSeeking) time.setText(fmt(t) + " / " + (len > 0 ? fmt(len) : "--:--"));
    }

    private void toggleControls() {
        if (controls.getVisibility() == View.VISIBLE) controls.setVisibility(View.GONE);
        else showControls();
    }

    private void showControls() {
        controls.setVisibility(View.VISIBLE);
        handler.removeCallbacks(hideControls);
        handler.postDelayed(hideControls, 3500);
    }

    private void finishWithResult(String error) {
        Intent result = new Intent()
            .putExtra("position", player != null ? player.getTime() : 0)
            .putExtra("duration", player != null ? player.getLength() : 0)
            .putExtra("finished", finished);
        if (error != null) result.putExtra("error", error);
        setResult(RESULT_OK, result);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishWithResult(null);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null && player.isPlaying()) player.pause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        handler.removeCallbacksAndMessages(null);
        if (player != null) {
            player.stop();
            player.detachViews();
            player.release();
        }
        if (libVLC != null) libVLC.release();
    }

    private void hideSystemBars() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    // ---- small view helpers ----
    private LinearLayout row() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        l.setPadding(dp(8), dp(6), dp(8), dp(6));
        return l;
    }

    private Button button(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(14);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#33ffffff"));
        bg.setCornerRadius(dp(8));
        b.setBackground(bg);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setPadding(dp(12), 0, dp(12), 0);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, dp(38));
        lp.setMargins(dp(4), 0, dp(4), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private TextView label(String text, int sp) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.WHITE);
        t.setTextSize(sp);
        t.setPadding(dp(8), 0, dp(8), 0);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private static String fmt(long ms) {
        long s = Math.max(0, ms / 1000);
        long h = s / 3600;
        long m = (s % 3600) / 60;
        return h > 0 ? String.format(Locale.US, "%d:%02d:%02d", h, m, s % 60) : String.format(Locale.US, "%d:%02d", m, s % 60);
    }
}
