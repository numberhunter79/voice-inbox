// Speech-to-text on the phone. Runs Moonshine in a background worker.
// Audio never leaves the device for this step.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;   // models come from Hugging Face once, then the browser cache
env.useBrowserCache = true;

const RATE = 16000;
let asr = null;
let loading = null;
let modelId = 'onnx-community/moonshine-base-ONNX';
let device = 'wasm';

function progress(p) {
  if (p.status === 'progress' && p.total) {
    postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
  }
}

async function load(opts = {}) {
  if (asr) return asr;
  if (loading) return loading;
  if (opts.model) modelId = opts.model;
  loading = (async () => {
    const tries = [];
    if (opts.device === 'webgpu' && self.navigator?.gpu) {
      tries.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
    }
    tries.push({ device: 'wasm', dtype: 'q8' });
    let lastErr;
    for (const t of tries) {
      try {
        asr = await pipeline('automatic-speech-recognition', modelId, { ...t, progress_callback: progress });
        device = t.device;
        postMessage({ type: 'ready', model: modelId, device });
        return asr;
      } catch (e) { lastErr = e; }
    }
    loading = null;
    throw lastErr;
  })();
  return loading;
}

function rms(a, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

// Split long notes at the quietest spot near every ~20 s, so words aren't cut.
export function splitPoints(audio, target = 20, search = 4) {
  const cuts = [0];
  const frame = Math.round(RATE * 0.1);
  let pos = 0;
  while (audio.length - pos > (target + search) * RATE) {
    const lo = pos + (target - search) * RATE;
    const hi = pos + (target + search) * RATE;
    let best = lo, bestE = Infinity;
    for (let i = lo; i + frame <= hi; i += frame) {
      const e = rms(audio, i, i + frame);
      if (e < bestE) { bestE = e; best = i + Math.round(frame / 2); }
    }
    cuts.push(best);
    pos = best;
  }
  cuts.push(audio.length);
  return cuts;
}

async function transcribe(id, audio) {
  const pipe = await load();
  const cuts = splitPoints(audio);
  const parts = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const seg = audio.subarray(cuts[i], cuts[i + 1]);
    if (rms(seg, 0, seg.length) < 0.002) continue;          // silence: skip, avoids made-up words
    const sec = seg.length / RATE;
    const out = await pipe(seg, { max_new_tokens: Math.ceil(sec * 7) + 10 });
    const text = (Array.isArray(out) ? out[0]?.text : out?.text || '').trim();
    if (text) parts.push(text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

let busy = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') {
    load(m).catch(err => postMessage({ type: 'loadError', message: String(err?.message || err) }));
  } else if (m.type === 'transcribe') {
    busy = busy.then(async () => {
      try {
        const text = await transcribe(m.id, m.audio);
        postMessage({ type: 'result', id: m.id, text, model: modelId.split('/').pop() + '/' + device });
      } catch (err) {
        postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
      }
    });
  }
};
