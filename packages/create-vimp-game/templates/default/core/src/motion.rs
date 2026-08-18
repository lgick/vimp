//! The ONLY source of movement math: pure functions, no Rapier bodies and no
//! world state. Both halves call them — the authoritative `Actor::update`
//! (which then writes the result onto the body) and the client `Predictor`
//! (which integrates it without collisions). Every change here is a change to
//! both halves at once; re-run `mod parity` in `client/predictor.rs` after it.
//!
//! The model is deliberately inertia-free: the velocity is written directly
//! from the held keys instead of being accumulated by impulses, so the
//! prediction parity is exact in open space and only collisions can pull the
//! two halves apart.

use rapier2d::prelude::Vector;
use vimp_engine_core::physics::normalize_angle;

use crate::config::ActorConfig;

/// Movement keys held on this step.
#[derive(Clone, Copy, Default)]
pub struct MoveInput {
    pub forward: bool,
    pub back: bool,
    pub left: bool,
    pub right: bool,
}

/// New facing angle (radians, normalised to [-PI, PI]).
pub fn step_angle(angle: f32, input: MoveInput, model: &ActorConfig, dt: f32) -> f32 {
    let mut delta = 0.0;

    if input.left {
        delta -= model.turn_speed * dt;
    }

    if input.right {
        delta += model.turn_speed * dt;
    }

    normalize_angle(angle + delta)
}

/// New signed speed along the facing direction: accelerate while a drive key
/// is held, brake towards zero otherwise.
pub fn step_speed(speed: f32, input: MoveInput, model: &ActorConfig, dt: f32) -> f32 {
    if input.forward && !input.back {
        (speed + model.acceleration * dt).min(model.max_speed)
    } else if input.back && !input.forward {
        (speed - model.acceleration * dt).max(-model.max_reverse_speed)
    } else if speed > 0.0 {
        (speed - model.braking * dt).max(0.0)
    } else {
        (speed + model.braking * dt).min(0.0)
    }
}

/// Velocity vector of an actor facing `angle` and moving at `speed`.
pub fn velocity(angle: f32, speed: f32) -> Vector {
    Vector::new(angle.cos() * speed, angle.sin() * speed)
}

/// Muzzle point: the edge of the body along the facing direction. The client
/// replicates it for the locally predicted tracer — keep the two in sync.
pub fn muzzle(x: f32, y: f32, angle: f32, model: &ActorConfig) -> Vector {
    let offset = model.size * 0.6;

    Vector::new(x + angle.cos() * offset, y + angle.sin() * offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> ActorConfig {
        serde_json::from_value(serde_json::json!({
            "currentWeapon": "w1",
            "size": 32.0,
            "maxSpeed": 200.0,
            "maxReverseSpeed": 100.0,
            "acceleration": 400.0,
            "braking": 600.0,
            "turnSpeed": 3.0,
            "fixture": { "density": 1.0, "friction": 0.2, "restitution": 0.0 }
        }))
        .unwrap()
    }

    #[test]
    fn speed_is_capped_by_the_model() {
        let mut speed = 0.0;
        let input = MoveInput {
            forward: true,
            ..MoveInput::default()
        };

        for _ in 0..600 {
            speed = step_speed(speed, input, &model(), 1.0 / 120.0);
        }

        assert_eq!(speed, 200.0);
    }

    #[test]
    fn braking_stops_exactly_at_zero() {
        let mut speed = 50.0;

        for _ in 0..600 {
            speed = step_speed(speed, MoveInput::default(), &model(), 1.0 / 120.0);
        }

        assert_eq!(speed, 0.0);
    }

    #[test]
    fn angle_stays_normalised() {
        let mut angle = 0.0;
        let input = MoveInput {
            right: true,
            ..MoveInput::default()
        };

        for _ in 0..1000 {
            angle = step_angle(angle, input, &model(), 1.0 / 120.0);
        }

        assert!(angle.abs() <= core::f32::consts::PI);
    }
}
