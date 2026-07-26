use indexmap::IndexMap;
use serde::Deserialize;

/// Движковая половина конфигурации ядра (Wasm Host ABI, PLAN.md §3.4):
/// общая для любой игры, не знает про модели/оружие/панель. Игровая
/// половина — `G::Config` (`crate::sim::GameDef::Config`), парсится и
/// живёт в game-crate; корневой JSON, который собирает JS, имеет форму
/// `{engine: {...}, game: {...}}` — сборка обоих кусков в один объект
/// init-конфига делает `GameCore::new` в game-crate.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    /// Интервал фиксированного шага физики (секунды, напр. 1/120).
    pub time_step: f32,
    /// Масштаб карты по умолчанию (перекрывается scale самой карты).
    #[serde(default = "default_map_scale")]
    pub map_scale: f32,
    /// Дефолтный setId конструктора карт (game.js mapSetId).
    #[serde(default = "default_map_set_id")]
    pub map_set_id: String,
    pub snapshot: SnapshotConfig,
    /// Сид PRNG ботов/разброса (детерминизм воспроизводим при равном сиде).
    #[serde(default = "default_seed")]
    pub seed: u64,
}

/// Движковая половина клиентского конфига (игровая половина — конфиг
/// предиктора/шот-предиктора игры, напр. `TanksClientConfig`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineClientConfig {
    /// Шаг симуляции предикта (миллисекунды; EngineConfig.timeStep — секунды).
    pub time_step_ms: f64,
    pub snapshot: SnapshotConfig,
    pub interpolation: InterpolationConfig,
}

fn default_map_scale() -> f32 {
    1.0
}

fn default_map_set_id() -> String {
    "c1".to_string()
}

fn default_seed() -> u64 {
    0x5644_4d49_5056_494d // произвольная константа
}

/// Форма блока в бинарном снапшоте (kind из src/config/opcodes.js):
/// ширина id/count и наличие null-маркера для удалённых строк. Раскладка
/// ПОЛЕЙ внутри строки — генерик, описывается отдельно схемой `fields`
/// (см. `BlockSchema`) и не зашита в Rust; движок не знает игровых имён
/// сущностей (танк/снаряд/трассер), только форму их строк.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    /// u8 id + null-маркер (удаление строки), u8 count.
    Indexed8,
    /// u32 id + null-маркер, u16 count.
    Indexed32,
    /// без id, без null-маркера, u16 count.
    List16,
    /// u8 индекс без null-маркера, u8 count.
    IndexedNoNull8,
}

/// Бинарный тип поля строки блока.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    F32,
    U8,
    U16,
    U32,
}

/// Способ интерполяции поля на клиенте между кадрами A/B
/// (применяется только к блокам класса `Hot` — см. `BlockClass`).
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Interp {
    Lerp,
    LerpAngle,
    Discrete,
}

/// Описание одного поля строки блока — порядок в векторе равен порядку
/// байтов в раскладке (и порядку полей в конкретной Row-структуре
/// core/src/snapshot.rs — молчаливый контракт, проверяемый тестами).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    pub name: String,
    pub ty: FieldType,
    #[serde(default = "default_interp")]
    pub interp: Interp,
}

fn default_interp() -> Interp {
    Interp::Discrete
}

/// Значение поля строки во время упаковки/распаковки (рантайм-парность
/// `FieldType`).
#[derive(Clone, Copy)]
pub enum FieldValue {
    F32(f32),
    U8(u8),
    U16(u16),
    U32(u32),
}

/// Класс блока: «горячий» — интерполируется клиентом между кадрами
/// (танки, динамика карты), «событийный» — одноразовый, кадром как есть
/// (трассеры/бомбы/взрывы).
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockClass {
    Hot,
    Event,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSchema {
    pub id: u8,
    pub kind: BlockKind,
    pub class: BlockClass,
    #[serde(default)]
    pub fields: Vec<FieldSchema>,
}

/// Длина player-блока предикшена (predicted player state), см.
/// `Tank::prediction_state`. Единая константа вместо 4 независимых
/// литералов `8` (snapshot.rs/unpack.rs/tank.rs/predictor.rs).
pub const PLAYER_STATE_LEN: usize = 8;

/// Реестр снапшот-ключей и версия формата (src/config/opcodes.js).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotConfig {
    pub version: u8,
    /// Номер порта SHOT_DATA (первый байт кадра).
    pub port: u8,
    pub keys: IndexMap<String, BlockSchema>,
}

impl SnapshotConfig {
    /// Проверяет структурные инварианты, общие для любой игры: `id` блока —
    /// это опкод в бинарном кадре (см. `core/src/snapshot.rs`), совпадение
    /// двух `id` молча портит распаковку на клиенте. Должна вызываться на
    /// границе конструирования (`GameCore::new`/`ClientCore::new`).
    pub fn validate(&self) -> Result<(), String> {
        let mut seen_ids: Vec<u8> = Vec::new();

        for (key, schema) in &self.keys {
            if seen_ids.contains(&schema.id) {
                return Err(format!(
                    "[core snapshot] Ключ '{key}': id {} уже используется другим блоком",
                    schema.id
                ));
            }

            seen_ids.push(schema.id);
        }

        Ok(())
    }
}

/// Настройки snapshot-интерполяции (src/config/client.js interpolation).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterpolationConfig {
    /// Задержка рендера в прошлом (мс).
    pub delay: f64,
    /// Максимальный возраст кадра в буфере (мс).
    pub max_frame_age: f64,
}

/// Канонические схемы 5 сегодняшних kind — общий тестовый фикстур для
/// snapshot.rs/unpack.rs/interpolator.rs/client/mod.rs (единый source of
/// truth вместо копипаста SnapshotConfig в каждом test-модуле).
#[cfg(test)]
pub mod test_support {
    use super::*;

    fn field(name: &str, ty: FieldType) -> FieldSchema {
        FieldSchema {
            name: name.to_string(),
            ty,
            interp: Interp::Discrete,
        }
    }

    fn field_interp(name: &str, ty: FieldType, interp: Interp) -> FieldSchema {
        FieldSchema {
            name: name.to_string(),
            ty,
            interp,
        }
    }

    pub fn tanks_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Indexed8,
            class: BlockClass::Hot,
            fields: vec![
                field_interp("x", FieldType::F32, Interp::Lerp),
                field_interp("y", FieldType::F32, Interp::Lerp),
                field_interp("angle", FieldType::F32, Interp::LerpAngle),
                field_interp("gunRotation", FieldType::F32, Interp::LerpAngle),
                field_interp("vx", FieldType::F32, Interp::Lerp),
                field_interp("vy", FieldType::F32, Interp::Lerp),
                field_interp("engineLoad", FieldType::F32, Interp::Lerp),
                field("condition", FieldType::U8),
                field("size", FieldType::U8),
                field("team", FieldType::U8),
            ],
        }
    }

    pub fn tracers_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::List16,
            class: BlockClass::Event,
            fields: vec![
                field("startX", FieldType::F32),
                field("startY", FieldType::F32),
                field("endX", FieldType::F32),
                field("endY", FieldType::F32),
                field("bodyX", FieldType::F32),
                field("bodyY", FieldType::F32),
                field("wasHit", FieldType::U8),
                field("shooterId", FieldType::U8),
            ],
        }
    }

    pub fn bombs_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Indexed32,
            class: BlockClass::Event,
            fields: vec![
                field("x", FieldType::F32),
                field("y", FieldType::F32),
                field("angle", FieldType::F32),
                field("size", FieldType::U8),
                field("time", FieldType::U16),
                field("ownerId", FieldType::U8),
            ],
        }
    }

    pub fn explosions_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::List16,
            class: BlockClass::Event,
            fields: vec![
                field("x", FieldType::F32),
                field("y", FieldType::F32),
                field("radius", FieldType::F32),
            ],
        }
    }

    pub fn dynamics_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::IndexedNoNull8,
            class: BlockClass::Hot,
            fields: vec![
                field_interp("x", FieldType::F32, Interp::Lerp),
                field_interp("y", FieldType::F32, Interp::Lerp),
                field_interp("angle", FieldType::F32, Interp::LerpAngle),
            ],
        }
    }

    /// Реестр из 5 ключей — 5 из 6 канонических ключей opcodes.js
    /// (без `c2`, второго динамического слоя с идентичной `c1` схемой).
    pub fn full_snapshot_config(version: u8, port: u8) -> SnapshotConfig {
        let mut keys = IndexMap::new();

        keys.insert("m1".to_string(), tanks_schema(1));
        keys.insert("w1".to_string(), tracers_schema(2));
        keys.insert("w2".to_string(), bombs_schema(3));
        keys.insert("w2e".to_string(), explosions_schema(4));
        keys.insert("c1".to_string(), dynamics_schema(5));

        SnapshotConfig {
            version,
            port,
            keys,
        }
    }
}

#[cfg(test)]
mod validate_tests {
    use super::test_support::full_snapshot_config;

    #[test]
    fn valid_schema_passes() {
        assert!(full_snapshot_config(3, 5).validate().is_ok());
    }

    #[test]
    fn duplicate_id_fails() {
        let mut cfg = full_snapshot_config(3, 5);

        cfg.keys.get_mut("w2").unwrap().id = cfg.keys["m1"].id;

        let err = cfg.validate().unwrap_err();
        assert!(err.contains("w2"));
    }
}
