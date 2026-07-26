use serde::{Deserialize, Serialize};

/// Детерминированный PRNG (SplitMix64): замена Math.random() у ботов и
/// разброса оружия. Целочисленное ядро — результат бит-в-бит одинаков на
/// любой платформе, что сохраняет детерминизм WASM (Spike C).
#[derive(Clone, Serialize, Deserialize)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;

        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Аналог Math.random(): значение в [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Аналог randomRange(min, max) из lib/math.js.
    pub fn range(&mut self, min: f32, max: f32) -> f32 {
        self.next_f32() * (max - min) + min
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_seed() {
        let mut a = Rng::new(42);
        let mut b = Rng::new(42);

        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn next_f32_in_unit_range() {
        let mut rng = Rng::new(7);

        for _ in 0..1000 {
            let v = rng.next_f32();
            assert!((0.0..1.0).contains(&v));
        }
    }

    #[test]
    fn range_respects_bounds() {
        let mut rng = Rng::new(3);

        for _ in 0..1000 {
            let v = rng.range(-0.25, 0.25);
            assert!((-0.25..0.25).contains(&v));
        }
    }
}
