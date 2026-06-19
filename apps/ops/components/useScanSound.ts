'use client';

// Web Audio feedback for Scan mode (PR22 §4). Two synthesized tones — no asset files, zero network
// latency, works offline: ACK = a short rising chirp on a clean count; REJECT = a low double-buzz on
// anything that needs a human. The AudioContext starts suspended under the browser autoplay policy, so
// we resume() it on the session-open tap and on first scan-field focus (via `unlock`) — that way the
// FIRST real scan already plays (no "first scan is silent" bug). Mute is read live from a ref so the
// callbacks never need rebuilding; the caller owns persistence (localStorage). Everything no-ops
// gracefully where Web Audio is unavailable (older browsers, SSR).

import { useCallback, useEffect, useRef } from 'react';

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function useScanSound(muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // Lazily create the shared context (browser-only, only if Web Audio exists). Returns null when
  // unavailable so every caller can early-out without throwing.
  const getCtx = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
      if (!Ctor) return null;
      try {
        ctxRef.current = new Ctor();
      } catch {
        return null;
      }
    }
    return ctxRef.current;
  }, []);

  // Resume a suspended context — call from inside a user gesture (session-open, first focus, a scan).
  const unlock = useCallback(() => {
    const c = getCtx();
    if (c && c.state === 'suspended') void c.resume();
  }, [getCtx]);

  // Schedule one oscillator note with a click-free attack/decay envelope (exponential ramps need a
  // tiny non-zero floor, hence 0.0001 rather than 0).
  function note(c: AudioContext, type: OscillatorType, f0: number, f1: number, start: number, dur: number, peak: number) {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, start);
    if (f1 !== f0) osc.frequency.linearRampToValueAtTime(f1, start + dur);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, dur / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // ACK — short rising chirp (~100 ms, 660→990 Hz), pleasant + low-fatigue. Fires only after a count
  // write resolves, so the operator can pace by the beep.
  const playAck = useCallback(() => {
    if (mutedRef.current) return;
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') void c.resume();
    const t = c.currentTime + 0.005;
    note(c, 'sine', 660, 990, t, 0.1, 0.18);
  }, [getCtx]);

  // REJECT — distinct low double-buzz (~300 ms, two 220 Hz square pulses). Unmistakable + attention-
  // grabbing; the priority signal for anything held for review.
  const playReject = useCallback(() => {
    if (mutedRef.current) return;
    const c = getCtx();
    if (!c) return;
    if (c.state === 'suspended') void c.resume();
    const t = c.currentTime + 0.005;
    note(c, 'square', 220, 220, t, 0.12, 0.14);
    note(c, 'square', 220, 220, t + 0.16, 0.12, 0.14);
  }, [getCtx]);

  // Release the context when the session unmounts (a new session open creates a fresh one).
  useEffect(() => {
    return () => {
      const c = ctxRef.current;
      if (c && c.state !== 'closed') void c.close();
      ctxRef.current = null;
    };
  }, []);

  return { playAck, playReject, unlock };
}
