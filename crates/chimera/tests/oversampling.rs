//! A lighter airway requested for polyphony (1× at 48 kHz) ran away into noise under live
//! playing: tract pressures ~100× normal, ~8000 zero crossings/s (the limiter hid the level).
//! `Engine::with_oversampling` now keeps the internal rate above 60 kHz; this plays the same
//! moving voice and checks it stays a voice.
use chimera::engine::Engine;
use chimera::voice::human_voice::{SourcePatch, VoiceTelemetry};

/// zero crossings per second and the largest tract pressure RMS over 3 s of live-style playing
fn play(fs: f64, os: Option<usize>) -> (f64, f32) {
    let mut e = Engine::with_oversampling(fs, os);
    let mut seed = 7919u64;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % 1_000_000) as f64 / 1e6
    };
    let (mut f0, mut p) = (180.0f64, 8.0f64);
    e.set_gate(1.0);
    let mut buf = vec![0f32; 128];
    let mut tele = VoiceTelemetry::default();
    let (mut zc, mut n, mut prev, mut maxp) = (0usize, 0usize, 0f32, 0f32);
    for b in 0..(fs as usize * 3 / 128) {
        f0 = (f0 * (1.0 + (rnd() - 0.5) * 0.06)).clamp(70.0, 700.0);
        p = (p + (rnd() - 0.5) * 3.0).clamp(0.0, 22.0);
        let mut s = SourcePatch::f0(f0);
        s.pressure = Some(p);
        s.glide = Some(0.004);
        e.set_source(&s);
        if b % 6 == 0 {
            let a = serde_json::json!({ "tbX": 1.5 + rnd() * 2.7, "tbY": 5.5 + rnd() * 2.6, "jaw": 0.1 + rnd() * 1.6, "lipAp": 0.1 + rnd() * 1.4, "lipProt": rnd() * 1.4 });
            e.set_artic(&serde_json::from_value(a).unwrap(), Some(true));
        }
        e.render(&mut buf);
        for &x in &buf {
            if (x > 0.0) != (prev > 0.0) {
                zc += 1;
            }
            prev = x;
            n += 1;
        }
        if b % 16 == 0 {
            e.telemetry(&mut tele);
            for &v in &tele.pressure_rms {
                maxp = maxp.max(if v.is_finite() { v } else { f32::INFINITY });
            }
        }
    }
    (zc as f64 / (n as f64 / fs), maxp)
}

#[test]
fn a_light_airway_request_stays_stable() {
    let (zc_ref, p_ref) = play(48000.0, None);
    let (zc, p) = play(48000.0, Some(1));
    assert!(zc < 3000.0, "1× request: {zc:.0} zero crossings/s (the default: {zc_ref:.0})");
    assert!(p < p_ref * 5.0, "1× request: tract pressure {p:.0} (the default: {p_ref:.0})");
}
