//! The game half of the init JSON (the engine half is
//! `vimp_engine_core::config`): actors, weapons, keys, panel. Both cores get
//! one string of the shape `{engine: {...}, game: {...}}` — `engine` is
//! parsed by the engine crate, `game` by the structs below.
//!
//! The unit of the fixed step differs between the halves **on purpose**, and
//! the field names say so: the host gets `timeStep` in SECONDS
//! (`EngineConfig`), the client gets `timeStepMs` in MILLISECONDS
//! (`EngineClientConfig`). Do not "fix" one of them.

use indexmap::IndexMap;
use serde::Deserialize;

/// One entry of `gameConfig.playerKeys`: the bit of the key and its kind —
/// `0` held, `1` one-shot (consumed by exactly one fixed step).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub key: u32,
    #[serde(default, rename = "type")]
    pub kind: u8,
}

/// Start value of a panel field (`gameConfig.panel.fields`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelValue {
    pub value: f64,
}

/// Rapier collider parameters of the actor body.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub density: f32,
    pub friction: f32,
    pub restitution: f32,
}

/// One actor class (`src/data/models.js`). The template ships a single class;
/// adding a second one means adding a key there — nothing in the core is
/// hard-coded to a name.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorConfig {
    /// Weapon the actor spawns with (key of `weapons`).
    pub current_weapon: String,
    /// Diameter of the body in world units.
    pub size: f32,
    /// Forward / reverse speed caps (units per second).
    pub max_speed: f32,
    pub max_reverse_speed: f32,
    /// Speed gained per second while a drive key is held.
    pub acceleration: f32,
    /// Speed lost per second with no drive key held.
    pub braking: f32,
    /// Turn rate (radians per second).
    pub turn_speed: f32,
    pub fixture: Fixture,
}

/// Camera shake of the victim on a hit (`CoreEvent::Shake`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraShake {
    pub intensity: f64,
    pub duration: f64,
}

/// One weapon (`src/data/weapons.js`). The template ships a single hitscan
/// weapon; a projectile weapon would add its own fields and a body kind in
/// `body_tag.rs`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponConfig {
    pub damage: f64,
    /// Ray length in world units.
    pub range: f32,
    /// Cooldown between shots (SECONDS — the client predictor multiplies by
    /// 1000 itself).
    pub fire_rate: f32,
    /// Random spread of the ray (radians, engine `Rng` only).
    #[serde(default)]
    pub spread: f32,
    /// Ammo spent per shot (default 1).
    #[serde(default)]
    pub consumption: Option<f64>,
    #[serde(default)]
    pub camera_shake: Option<CameraShake>,
}

/// The `game` half of the host init JSON (`GameCore::new`) — assembled by the
/// engine in `buildCoreConfig` from `HostPlugin.gameConfig`, so the field set
/// below is fixed by the engine, not by the game.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaConfig {
    #[serde(default)]
    pub friendly_fire: bool,
    pub models: IndexMap<String, ActorConfig>,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Start values of the panel: `health` plus one field per weapon (ammo).
    pub panel: IndexMap<String, PanelValue>,
}

impl ArenaConfig {
    /// Every panel key except `health` must name an existing weapon —
    /// otherwise the panel and the ammo bookkeeping drift apart silently.
    pub fn validate(&self) -> Result<(), String> {
        for key in self.panel.keys() {
            if key != "health" && !self.weapons.contains_key(key) {
                return Err(format!(
                    "panel key '{key}' has no matching entry in weapons"
                ));
            }
        }

        for (name, model) in &self.models {
            if !self.weapons.contains_key(&model.current_weapon) {
                return Err(format!(
                    "model '{name}': currentWeapon '{}' is not in weapons",
                    model.current_weapon
                ));
            }
        }

        Ok(())
    }
}

/// The `game` half of the client init JSON (`ClientCore::new`) — assembled by
/// the engine in `buildClientCoreConfig` from `CONFIG_DATA.prediction`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaClientConfig {
    pub models: IndexMap<String, ActorConfig>,
    pub weapons: IndexMap<String, WeaponConfig>,
    pub player_keys: IndexMap<String, KeyConfig>,
    /// Seed of the local spread PRNG. It is deliberately NOT synchronised
    /// with the host: the authoritative tracer arrives with the next frame
    /// and replaces the local guess.
    #[serde(default = "default_seed")]
    pub seed: u64,
}

fn default_seed() -> u64 {
    0x5644_4d49_5056_494d
}

/// Root init JSON of `GameCore::new`.
#[derive(Clone, Deserialize)]
pub struct RootConfig {
    pub engine: vimp_engine_core::config::EngineConfig,
    pub game: ArenaConfig,
}

/// Root init JSON of `ClientCore::new`.
#[derive(Clone, Deserialize)]
pub struct RootClientConfig {
    pub engine: vimp_engine_core::config::EngineClientConfig,
    pub game: ArenaClientConfig,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weapon() -> WeaponConfig {
        WeaponConfig {
            damage: 10.0,
            range: 500.0,
            fire_rate: 0.3,
            spread: 0.0,
            consumption: None,
            camera_shake: None,
        }
    }

    fn model(current_weapon: &str) -> ActorConfig {
        ActorConfig {
            current_weapon: current_weapon.to_string(),
            size: 32.0,
            max_speed: 200.0,
            max_reverse_speed: 100.0,
            acceleration: 400.0,
            braking: 600.0,
            turn_speed: 3.0,
            fixture: Fixture {
                density: 1.0,
                friction: 0.2,
                restitution: 0.0,
            },
        }
    }

    fn config(panel_keys: &[&str], current_weapon: &str) -> ArenaConfig {
        let mut weapons = IndexMap::new();
        let mut models = IndexMap::new();
        let mut panel = IndexMap::new();

        weapons.insert("w1".to_string(), weapon());
        models.insert("a1".to_string(), model(current_weapon));

        for key in panel_keys {
            panel.insert((*key).to_string(), PanelValue { value: 0.0 });
        }

        ArenaConfig {
            friendly_fire: false,
            models,
            weapons,
            player_keys: IndexMap::new(),
            panel,
        }
    }

    #[test]
    fn panel_of_health_and_weapons_passes() {
        assert!(config(&["health", "w1"], "w1").validate().is_ok());
    }

    #[test]
    fn panel_key_without_weapon_fails() {
        let err = config(&["health", "w9"], "w1").validate().unwrap_err();

        assert!(err.contains("w9"));
    }

    #[test]
    fn unknown_current_weapon_fails() {
        let err = config(&["health", "w1"], "w9").validate().unwrap_err();

        assert!(err.contains("w9"));
    }
}
