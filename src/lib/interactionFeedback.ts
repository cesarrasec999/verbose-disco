export type OperationalFeedback = "scan" | "success" | "error";

const tone: Record<OperationalFeedback, { frequency: number; duration: number; vibration: VibratePattern }> = {
  scan: { frequency: 440, duration: 0.07, vibration: 24 },
  success: { frequency: 660, duration: 0.12, vibration: [32, 42, 68] },
  error: { frequency: 180, duration: 0.16, vibration: [65, 55, 95] },
};

/**
 * Feedback corto para operaciones de cámara/lector. No guarda datos ni bloquea
 * el flujo de la pantalla si el navegador no permite reproducir audio.
 */
export function playOperationalFeedback(kind: OperationalFeedback) {
  if (typeof window === "undefined") return;

  const preferences = window.localStorage;
  const config = tone[kind];

  if (preferences.getItem("rasecorp_haptic_feedback") !== "off" && "vibrate" in navigator) {
    navigator.vibrate(config.vibration);
  }

  if (preferences.getItem("rasecorp_sound_feedback") === "off") return;

  try {
    const AudioContextConstructor = window.AudioContext
      || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    const audio = new AudioContextConstructor();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = kind === "error" ? "sawtooth" : "sine";
    oscillator.frequency.setValueAtTime(config.frequency, audio.currentTime);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.075, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + config.duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + config.duration + 0.02);
    oscillator.addEventListener("ended", () => void audio.close());
  } catch {
    // El aviso visual y la operación siguen funcionando en navegadores que bloquean audio.
  }
}
