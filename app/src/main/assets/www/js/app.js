import { Engine, diag } from './engine.js';
import { NativeEngine, nativeAvailable, onNativeFiles } from './native-engine.js';
import { Library } from './library.js';
import { UI } from './ui.js';
import { Automix } from './automix.js';
import { toast } from './widgets.js';

const start = async () => {
  const btn = document.getElementById('startBtn');
  btn.disabled = true; btn.textContent = 'STARTING…';
  try {
    let engine;
    if (nativeAvailable()) {
      // Android: real native audio engine (MediaCodec decoding + AudioTrack output)
      try { engine = new NativeEngine(); await engine.init(); }
      catch (e) { diag.lastError = 'native: ' + e.message; engine = null; }
    }
    if (!engine) { engine = new Engine(); await engine.init(); await engine.ctx.resume(); }
    const library = new Library(engine);
    const ui = new UI(engine, library);
    const automix = new Automix(engine, library, ui);
    ui.init(automix);
    onNativeFiles((files) => ui.onNativeFiles(files));
    window.DJ = {
      engine, library, ui, automix,
      onBack() {
        if (!document.getElementById('modal').classList.contains('hidden')) { ui.closeModal(); return true; }
        if (ui.page && ui.page !== 'mixer') { ui.showPage('mixer'); return true; }
        return false;
      },
    };
    document.getElementById('splash').remove();
    document.addEventListener('pointerdown', () => engine.resume(), { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) engine.resume(); });
    window.addEventListener('error', (e) => { diag.lastError = String(e.message || e.error); toast('Error: ' + diag.lastError, 4000); });
    window.addEventListener('unhandledrejection', (e) => { diag.lastError = String((e.reason && e.reason.message) || e.reason); toast('Error: ' + diag.lastError, 4000); });
    if (diag.lastError) toast(diag.lastError, 5000);
    else if (!library.local.length) setTimeout(() => toast('Tip: LIBRARY → ＋ ADD MUSIC, or try the Demo Tracks'), 600);
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = 'TAP TO START';
    alert('Audio engine failed to start: ' + (e.message || e));
  }
};

document.getElementById('startBtn').addEventListener('click', start);
