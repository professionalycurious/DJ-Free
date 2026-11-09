package com.djfree.app;

import android.content.ContentValues;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Process;
import android.provider.MediaStore;
import android.util.Base64;

import com.djfree.app.audio.AudioEngine;
import com.djfree.app.audio.Control;
import com.djfree.app.audio.Track;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

/** Native audio: AudioTrack output thread, MediaCodec decoding, track cache, WAV recording. */
final class NativeAudio {
    interface Callback { void send(String json); }

    private final Context ctx;
    private final Callback cb;
    AudioEngine engine;
    Control control;
    private Thread thread;
    private volatile boolean running;
    private boolean floatOut;
    private int latencyMs, outRate;
    private String error = "";

    private final LinkedHashMap<String, Track> cache = new LinkedHashMap<>(8, 0.75f, true);
    private final Map<String, Object[]> mono = new HashMap<>();
    private final Map<String, Upload> uploads = new HashMap<>();
    private final ExecutorService decodeExec = Executors.newSingleThreadExecutor();
    private final Track[] onDeck = new Track[2];
    private Recorder recorder;

    NativeAudio(Context ctx, Callback cb) { this.ctx = ctx.getApplicationContext(); this.cb = cb; }

    /* ------------------------------------------------------------------ output */

    synchronized String start() {
        try {
            if (!running) {
                outRate = AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC);
                if (outRate < 8000 || outRate > 192000) outRate = 48000;
                engine = new AudioEngine(outRate);
                control = new Control(engine);
                requestFocus();
                final AudioTrack at = createTrack();
                running = true;
                thread = new Thread(() -> loop(at), "DJFree-Audio");
                thread.start();
            }
            JSONObject o = new JSONObject();
            o.put("ok", true); o.put("sr", outRate); o.put("latencyMs", latencyMs); o.put("float", floatOut);
            return o.toString();
        } catch (Throwable t) {
            error = String.valueOf(t);
            return "{\"ok\":false,\"error\":" + JSONObject.quote(error) + "}";
        }
    }

    private AudioTrack createTrack() {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        int[] encodings = {AudioFormat.ENCODING_PCM_FLOAT, AudioFormat.ENCODING_PCM_16BIT};
        for (int enc : encodings) {
            try {
                int bytesPerFrame = enc == AudioFormat.ENCODING_PCM_FLOAT ? 8 : 4;
                int min = AudioTrack.getMinBufferSize(outRate, AudioFormat.CHANNEL_OUT_STEREO, enc);
                if (min <= 0) continue;
                int size = Math.max(min * 2, 1536 * bytesPerFrame);
                AudioTrack.Builder b = new AudioTrack.Builder()
                        .setAudioAttributes(attrs)
                        .setAudioFormat(new AudioFormat.Builder().setEncoding(enc).setSampleRate(outRate)
                                .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO).build())
                        .setBufferSizeInBytes(size)
                        .setTransferMode(AudioTrack.MODE_STREAM);
                if (Build.VERSION.SDK_INT >= 26) b.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY);
                AudioTrack at = b.build();
                if (at.getState() != AudioTrack.STATE_INITIALIZED) { at.release(); continue; }
                floatOut = enc == AudioFormat.ENCODING_PCM_FLOAT;
                latencyMs = (int) (1000L * size / bytesPerFrame / outRate);
                return at;
            } catch (Throwable ignored) { /* try next encoding */ }
        }
        throw new IllegalStateException("No audio output available");
    }

    private void loop(AudioTrack first) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        final int n = 256;
        final float[] L = new float[n], R = new float[n], fbuf = new float[n * 2];
        final short[] sbuf = new short[n * 2];
        AudioTrack at = first;
        try {
            at.play();
            while (running) {
                engine.render(L, R, n);
                int w = 0;
                if (floatOut) {
                    for (int i = 0; i < n; i++) { fbuf[2 * i] = L[i]; fbuf[2 * i + 1] = R[i]; }
                    int off = 0;
                    while (off < fbuf.length && running) { w = at.write(fbuf, off, fbuf.length - off, AudioTrack.WRITE_BLOCKING); if (w < 0) break; off += w; }
                } else {
                    for (int i = 0; i < n; i++) { sbuf[2 * i] = toShort(L[i]); sbuf[2 * i + 1] = toShort(R[i]); }
                    int off = 0;
                    while (off < sbuf.length && running) { w = at.write(sbuf, off, sbuf.length - off); if (w < 0) break; off += w; }
                }
                if (w < 0 && running) {
                    // output died (headphones / bluetooth switch, audio server restart): reopen it
                    error = "output restarted (" + w + ")";
                    try { at.release(); } catch (Throwable ignored) { }
                    try { Thread.sleep(100); } catch (InterruptedException ignored) { }
                    at = createTrack();
                    at.play();
                }
            }
        } catch (Throwable t) {
            error = "audio thread: " + t;
        } finally {
            try { at.stop(); } catch (Throwable ignored) { }
            at.release();
        }
    }

    private static short toShort(float x) { int v = (int) (x * 32767f); return (short) Math.max(-32768, Math.min(32767, v)); }

    private void requestFocus() {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (Build.VERSION.SDK_INT >= 26) {
                am.requestAudioFocus(new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                        .setOnAudioFocusChangeListener(c -> { }).build());
            } else {
                //noinspection deprecation
                am.requestAudioFocus(c -> { }, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            }
        } catch (Throwable ignored) { }
    }

    void stop() {
        running = false;
        if (thread != null) try { thread.join(500); } catch (InterruptedException ignored) { }
        decodeExec.shutdownNow();
    }

    String info() {
        return "native " + outRate + " Hz, " + (floatOut ? "float" : "16-bit") + ", ~" + latencyMs + " ms" + (error.isEmpty() ? "" : " | " + error);
    }

    /* ------------------------------------------------------------------ control */

    void cmd(String json) {
        if (control == null) return;
        try { control.dispatch(new JsonMsg(new JSONObject(json))); } catch (Throwable t) { error = "cmd: " + t; }
    }

    String state() {
        if (engine == null) return "{}";
        StringBuilder s = new StringBuilder(256);
        s.append("{\"t\":").append(engine.timeSec).append(",\"m\":").append(engine.masterLevel).append(",\"d\":[");
        for (int i = 0; i < 2; i++) {
            com.djfree.app.audio.Deck d = engine.decks[i];
            if (i > 0) s.append(',');
            s.append("{\"p\":").append(d.posSec).append(",\"s\":").append(d.speed)
             .append(",\"pl\":").append(d.playing ? 1 : 0).append(",\"sl\":").append(d.slipSec)
             .append(",\"v\":").append(d.level).append(",\"e\":").append(d.ended).append('}');
        }
        s.append("],\"r\":").append(recorder != null ? recorder.seconds() : -1).append('}');
        return s.toString();
    }

    void testTone() { if (control != null) engine.post(() -> engine.trigger(15)); }

    /* ------------------------------------------------------------------ tracks */

    /** Decodes a source on a background thread. keep=true keeps the full PCM for playback. */
    void prepare(String reqId, String id, String srcJson, boolean keep, boolean wantMono) {
        decodeExec.execute(() -> {
            JSONObject res = new JSONObject();
            try {
                res.put("type", "prepared"); res.put("reqId", reqId);
                Track have;
                synchronized (cache) { have = cache.get(id); }
                JSONObject src = new JSONObject(srcJson);
                Decoded dec;
                if (have != null && (keep || wantMono)) {
                    dec = new Decoded(); dec.track = have;
                    if (wantMono) {
                    int dc = Math.max(1, Math.round(have.rate / 11025f)), mn = have.frames / dc;
                    short[] m = new short[mn];
                    for (int i = 0; i < mn; i++) {
                        int acc = 0;
                        for (int k = 0; k < dc; k++) { int f = (i * dc + k) * 2; acc += (have.pcm[f] + have.pcm[f + 1]) >> 1; }
                        m[i] = (short) (acc / dc);
                    }
                    dec.mono = m; dec.monoRate = have.rate / (double) dc;
                    }
                } else {
                    dec = decode(id, src, keep);
                    if (keep) putCache(id, dec.track);
                }
                if (dec.mono != null && wantMono) synchronized (mono) { mono.put(id, new Object[]{dec.mono, dec.monoRate}); }
                Track t = dec.track;
                res.put("ok", true);
                res.put("monoRate", dec.monoRate);
                res.put("hasMono", dec.mono != null);
                res.put("duration", t != null ? t.durationSec() : dec.duration);
            } catch (Throwable t) {
                try { res.put("ok", false); res.put("error", t.getMessage() != null ? t.getMessage() : t.toString()); } catch (Exception ignored) { }
            }
            cb.send(res.toString());
        });
    }

    private void putCache(String id, Track t) {
        synchronized (cache) {
            cache.put(id, t);
            Iterator<Map.Entry<String, Track>> it = cache.entrySet().iterator();
            while (cache.size() > 3 && it.hasNext()) {
                Map.Entry<String, Track> e = it.next();
                if (e.getValue() == onDeck[0] || e.getValue() == onDeck[1] || e.getKey().equals(id)) continue;
                it.remove();
            }
        }
    }

    boolean assign(int deck, String id) {
        Track t;
        synchronized (cache) { t = cache.get(id); }
        if (t == null || control == null) return false;
        onDeck[deck] = t;
        control.load(deck, t);
        return true;
    }

    /** Raw mono analysis PCM (16-bit LE) for the JS analyser; removed once served. */
    byte[] takeMono(String id) {
        Object[] m;
        synchronized (mono) { m = mono.remove(id); }
        if (m == null) return null;
        short[] s = (short[]) m[0];
        ByteBuffer bb = ByteBuffer.allocate(s.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        bb.asShortBuffer().put(s);
        return bb.array();
    }

    /* uploads (JS generated audio: demo tracks, sampler pads) */
    private static final class Upload { short[] pcm; int pos; int rate; int frames; }

    void uploadBegin(String id, int rate, int frames) {
        Upload u = new Upload(); u.pcm = new short[frames * 2]; u.rate = rate; u.frames = frames;
        synchronized (uploads) { uploads.put(id, u); }
    }

    void uploadChunk(String id, String b64) {
        Upload u; synchronized (uploads) { u = uploads.get(id); }
        if (u == null) return;
        byte[] b = Base64.decode(b64, Base64.DEFAULT);
        ByteBuffer bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN);
        int n = Math.min(b.length / 2, u.pcm.length - u.pos);
        bb.asShortBuffer().get(u.pcm, u.pos, n);
        u.pos += n;
    }

    /** sample >= 0: becomes sampler pad; otherwise cached as a playable track. */
    boolean uploadEnd(String id, int sample) {
        Upload u; synchronized (uploads) { u = uploads.remove(id); }
        if (u == null || engine == null) return false;
        Track t = new Track(id, u.pcm, u.frames, u.rate);
        if (sample >= 0) engine.post(() -> engine.setSample(sample, t)); else putCache(id, t);
        return true;
    }

    boolean hasTrack(String id) { synchronized (cache) { return cache.containsKey(id); } }

    /* ------------------------------------------------------------------ decoding */

    static final class Decoded { Track track; short[] mono; double monoRate; double duration; }

    private Decoded decode(String id, JSONObject src, boolean keep) throws Exception {
        MediaExtractor ex = new MediaExtractor();
        File tmp = null;
        try {
            String type = src.optString("type");
            if ("uri".equals(type)) ex.setDataSource(ctx, Uri.parse(src.getString("uri")), null);
            else if ("url".equals(type)) { tmp = download(src.getString("url")); ex.setDataSource(tmp.getAbsolutePath()); }
            else throw new IllegalArgumentException("unknown source");
            int ti = -1; MediaFormat fmt = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) { ti = i; fmt = f; break; }
            }
            if (ti < 0) throw new IllegalStateException("no audio in this file");
            ex.selectTrack(ti);
            String mime = fmt.getString(MediaFormat.KEY_MIME);
            int rate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int ch = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            long durUs = fmt.containsKey(MediaFormat.KEY_DURATION) ? fmt.getLong(MediaFormat.KEY_DURATION) : 0;
            MediaCodec codec = MediaCodec.createDecoderByType(mime);
            codec.configure(fmt, null, null, 0);
            codec.start();

            if (durUs > 25L * 60 * 1_000_000) throw new IllegalStateException("tracks longer than 25 minutes aren't supported");
            int est = (int) Math.min(Integer.MAX_VALUE / 4, (durUs > 0 ? durUs * rate / 1_000_000L : rate * 240L) + rate);
            short[] pcm = keep ? new short[est * 2] : null;
            int frames = 0;
            int dec = Math.max(1, Math.round(rate / 11025f));
            short[] mbuf = new short[Math.max(1024, est / dec + 16)];
            int mcount = 0; int macc = 0; int mn = 0;
            boolean floatPcm = false;
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inDone = false, outDone = false;
            while (!outDone) {
                if (!inDone) {
                    int ii = codec.dequeueInputBuffer(10000);
                    if (ii >= 0) {
                        ByteBuffer ib = codec.getInputBuffer(ii);
                        int sz = ex.readSampleData(ib, 0);
                        if (sz < 0) { codec.queueInputBuffer(ii, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true; }
                        else { codec.queueInputBuffer(ii, 0, sz, ex.getSampleTime(), 0); ex.advance(); }
                    }
                }
                int oi = codec.dequeueOutputBuffer(info, 10000);
                if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) ch = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (Build.VERSION.SDK_INT >= 24 && of.containsKey(MediaFormat.KEY_PCM_ENCODING))
                        floatPcm = of.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT;
                    dec = Math.max(1, Math.round(rate / 11025f));
                } else if (oi >= 0) {
                    ByteBuffer ob = codec.getOutputBuffer(oi);
                    if (ob != null && info.size > 0) {
                        ob.position(info.offset); ob.limit(info.offset + info.size);
                        ob.order(ByteOrder.nativeOrder());
                        int samples = info.size / (floatPcm ? 4 : 2);
                        int fr = samples / Math.max(1, ch);
                        if (keep && (frames + fr) * 2 > pcm.length) pcm = java.util.Arrays.copyOf(pcm, Math.max(pcm.length * 3 / 2, (frames + fr) * 2 + rate * 2));
                        for (int f = 0; f < fr; f++) {
                            int l, r;
                            if (floatPcm) {
                                float a = ob.getFloat(), b = ch > 1 ? ob.getFloat() : a;
                                for (int k = 2; k < ch; k++) ob.getFloat();
                                l = (int) (Math.max(-1, Math.min(1, a)) * 32767); r = (int) (Math.max(-1, Math.min(1, b)) * 32767);
                            } else {
                                l = ob.getShort(); r = ch > 1 ? ob.getShort() : l;
                                for (int k = 2; k < ch; k++) ob.getShort();
                            }
                            if (keep) { pcm[(frames + f) * 2] = (short) l; pcm[(frames + f) * 2 + 1] = (short) r; }
                            macc += (l + r) >> 1; if (++mn == dec) {
                                if (mcount == mbuf.length) mbuf = java.util.Arrays.copyOf(mbuf, mbuf.length * 3 / 2 + 1024);
                                mbuf[mcount++] = (short) (macc / dec); macc = 0; mn = 0;
                            }
                        }
                        frames += fr;
                    }
                    codec.releaseOutputBuffer(oi, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outDone = true;
                }
            }
            codec.stop(); codec.release();
            if (frames == 0) throw new IllegalStateException("could not decode audio");
            Decoded d = new Decoded();
            if (keep) d.track = new Track(id, pcm.length == frames * 2 ? pcm : java.util.Arrays.copyOf(pcm, frames * 2), frames, rate);
            d.mono = java.util.Arrays.copyOf(mbuf, mcount);
            d.monoRate = rate / (double) dec;
            d.duration = frames / (double) rate;
            return d;
        } finally {
            ex.release();
            if (tmp != null) //noinspection ResultOfMethodCallIgnored
                tmp.delete();
        }
    }

    private File download(String url) throws Exception {
        URL u = new URL(url);
        if (!"https".equals(u.getProtocol())) throw new SecurityException("https only");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000);
        if (c.getResponseCode() >= 400) throw new IllegalStateException("download failed (" + c.getResponseCode() + ")");
        File f = File.createTempFile("dl", ".m4a", ctx.getCacheDir());
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(f)) {
            byte[] b = new byte[65536]; int r;
            while ((r = in.read(b)) > 0) out.write(b, 0, r);
        }
        return f;
    }

    /* ------------------------------------------------------------------ recording */

    synchronized boolean recStart() {
        if (engine == null || recorder != null) return false;
        try { recorder = new Recorder(ctx.getCacheDir(), outRate); engine.tap = recorder; return true; }
        catch (Exception e) { error = "rec: " + e; return false; }
    }

    void recStop() {
        final Recorder r;
        synchronized (this) { r = recorder; recorder = null; if (engine != null) engine.tap = null; }
        if (r == null) return;
        new Thread(() -> {
            String path = "";
            try { path = r.finishTo(ctx); } catch (Exception e) { error = "rec: " + e; }
            try { cb.send(new JSONObject().put("type", "recSaved").put("path", path).toString()); } catch (Exception ignored) { }
        }).start();
    }

    private static final class Recorder implements AudioEngine.Tap {
        final File file; final int rate; final LinkedBlockingQueue<short[]> q = new LinkedBlockingQueue<>();
        final Thread writer; volatile boolean active = true; long frames;
        Recorder(File dir, int rate) throws Exception {
            this.rate = rate;
            file = File.createTempFile("mix", ".wav", dir);
            final OutputStream os = new BufferedOutputStream(new FileOutputStream(file), 1 << 16);
            os.write(new byte[44]);
            writer = new Thread(() -> {
                byte[] b = new byte[0];
                try {
                    while (true) {
                        short[] s = q.take();
                        if (s.length == 0) break;
                        if (b.length != s.length * 2) b = new byte[s.length * 2];
                        for (int i = 0; i < s.length; i++) { b[2 * i] = (byte) s[i]; b[2 * i + 1] = (byte) (s[i] >> 8); }
                        os.write(b);
                    }
                    os.close();
                } catch (Exception ignored) { }
            }, "DJFree-Rec");
            writer.start();
        }
        @Override public void onBlock(float[] L, float[] R, int n) {
            if (!active) return;
            short[] s = new short[n * 2];
            for (int i = 0; i < n; i++) { s[2 * i] = toShort(L[i]); s[2 * i + 1] = toShort(R[i]); }
            frames += n;
            q.offer(s);
        }
        double seconds() { return frames / (double) rate; }
        String finishTo(Context ctx) throws Exception {
            active = false; q.offer(new short[0]); writer.join(5000);
            long data = file.length() - 44;
            try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
                ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
                h.put("RIFF".getBytes()).putInt((int) (36 + data)).put("WAVE".getBytes()).put("fmt ".getBytes())
                 .putInt(16).putShort((short) 1).putShort((short) 2).putInt(rate).putInt(rate * 4).putShort((short) 4).putShort((short) 16)
                 .put("data".getBytes()).putInt((int) data);
                raf.seek(0); raf.write(h.array());
            }
            String name = "DJFree-Mix-" + new java.text.SimpleDateFormat("yyyy-MM-dd-HH-mm-ss", java.util.Locale.US).format(new java.util.Date()) + ".wav";
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
                    v.put(MediaStore.Audio.Media.MIME_TYPE, "audio/wav");
                    v.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/DJ Free");
                    Uri uri = ctx.getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    try (OutputStream os = ctx.getContentResolver().openOutputStream(uri); InputStream in = new FileInputStream(file)) {
                        if (os == null) return "";
                        byte[] b = new byte[1 << 16]; int r; while ((r = in.read(b)) > 0) os.write(b, 0, r);
                    }
                    return "Music/DJ Free/" + name;
                } else {
                    File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_MUSIC), "DJ Free");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File out = new File(dir, name);
                    try (InputStream in = new FileInputStream(file); OutputStream os = new FileOutputStream(out)) {
                        byte[] b = new byte[1 << 16]; int r; while ((r = in.read(b)) > 0) os.write(b, 0, r);
                    }
                    return out.getAbsolutePath();
                }
            } finally {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    /* ------------------------------------------------------------------ JSON adapter */

    private static final class JsonMsg implements Control.Msg {
        final JSONObject o;
        JsonMsg(JSONObject o) { this.o = o; }
        @Override public String str(String k) { return o.has(k) && !o.isNull(k) ? o.optString(k) : null; }
        @Override public double num(String k, double def) { return o.optDouble(k, def); }
        @Override public boolean bool(String k) { return o.optBoolean(k, false); }
        @Override public boolean has(String k) { return o.has(k) && !o.isNull(k); }
        @Override public Control.Msg obj(String k) { JSONObject j = o.optJSONObject(k); return j == null ? null : new JsonMsg(j); }
    }
}
