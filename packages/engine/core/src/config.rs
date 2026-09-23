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
    /// Секунды падения на уровень высоты (`FallModel::time_per_level`):
    /// одна траектория на танки и на тела карты.
    #[serde(default = "default_map_fall_time")]
    pub map_fall_time: f32,
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
    /// Детектор рассинхрона предикта (plan/done/ai-debug/stage_5.md). Отсутствует
    /// в боевом конфиге — тогда движок не делает вообще ничего лишнего на
    /// пути кадра.
    #[serde(default)]
    pub divergence: Option<DivergenceConfig>,
}

/// Пороги детектора рассинхрона предикта: расхождение считается нарушением,
/// если |предсказанное − авторитетное| по компоненту player-блока превышает
/// порог. Раскладка компонентов — игровая, поэтому пороги задаются позиционно
/// (`thresholds[i]`), а недостающие берутся из `default_threshold`.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergenceConfig {
    #[serde(default)]
    pub thresholds: Vec<f32>,
    #[serde(default = "default_divergence_threshold")]
    pub default_threshold: f32,
    /// Ёмкость кольцевого буфера записей (лишние вытесняются, их число
    /// попадает в отчёт как `dropped`).
    #[serde(default = "default_divergence_capacity")]
    pub capacity: usize,
    /// Индексы компонентов-углов: их разность приводится к `(−π, π]`, иначе
    /// одно направление по разные стороны разреза ±π давало бы Δ ≈ 2π.
    /// Индекс за пределами player-блока не участвует, как и лишние пороги.
    #[serde(default)]
    pub angles: Vec<usize>,
}

impl DivergenceConfig {
    pub fn threshold(&self, index: usize) -> f32 {
        self.thresholds
            .get(index)
            .copied()
            .unwrap_or(self.default_threshold)
    }

    pub fn is_angle(&self, index: usize) -> bool {
        self.angles.contains(&index)
    }
}

fn default_divergence_threshold() -> f32 {
    1.0
}

fn default_divergence_capacity() -> usize {
    64
}

fn default_map_fall_time() -> f32 {
    crate::map::DEFAULT_FALL_TIME
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

/// Роль поля в контракте движка. Имя поля принадлежит игре и меняется ею
/// свободно; роль — это заявка на движковое поведение, поэтому и `z`, и
/// `level` строки динамики карты объявляются ролью, а не именем: сравнение
/// по именам возвращало плоскую строку молча, стоило игре переименовать
/// поле.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldRole {
    /// Высота тела над своим уровнем (падение), позиция 3 строки динамики.
    Z,
    /// Уровень тела, позиция 4 строки динамики.
    Level,
    /// Байт состояния тела карты (`u8`), сразу за головой строки динамики:
    /// позиция 5 у слоёной строки, 3 — у плоской. Смысл значений — игры.
    State,
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
    /// Движковая роль поля (см. `FieldRole`). None — обычное игровое поле.
    #[serde(default)]
    pub role: Option<FieldRole>,
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
    /// Индекс первого поля опционального хвоста: поля `[optional_from..]`
    /// пишутся в кадр не всегда, их наличие задаёт флаг-байт перед строкой
    /// (кадр v4, блок динамики карты: покоящееся тело не платит за
    /// скорости). `None` — строка фиксированной ширины, флаг-байта нет.
    /// Раскладка полей при этом не меняется: распаковка всегда отдаёт
    /// строку полной ширины, отсутствующий хвост читается как нули
    /// (см. `client/unpack.rs`), поэтому потребители строки — интерполятор,
    /// hot-буфер, JS — остаются фиксированной ширины.
    #[serde(default)]
    pub optional_from: Option<usize>,
}

/// Позиции пары `z`/`level` в голове строки динамики карты: место в
/// раскладке фиксировано движком (`GameMap::dynamic_map_data`), ролями
/// объявляется только сам факт слоёной строки.
const Z_FIELD_INDEX: usize = 3;
const LEVEL_FIELD_INDEX: usize = 4;
/// Позиция поля с ролью `state`: сразу за головой строки.
const STATE_FIELD_INDEX_FLAT: usize = 3;
const STATE_FIELD_INDEX_LAYERED: usize = 5;

impl BlockSchema {
    /// Число полей, которые пишутся в строку всегда (без хвоста).
    pub fn required_len(&self) -> usize {
        self.optional_from.unwrap_or(self.fields.len())
    }

    /// Объявила ли игра слоёную строку динамики карты: роли `z` и `level`
    /// на своих позициях. Не по именам полей — имя принадлежит игре.
    pub fn with_levels(&self) -> bool {
        self.role_at(Z_FIELD_INDEX) == Some(FieldRole::Z)
            && self.role_at(LEVEL_FIELD_INDEX) == Some(FieldRole::Level)
    }

    /// Объявила ли игра байт состояния тела карты: роль `state` на своей
    /// позиции (5 у слоёной строки, 3 — у плоской).
    pub fn with_state(&self) -> bool {
        self.role_at(self.state_field_index()) == Some(FieldRole::State)
    }

    fn state_field_index(&self) -> usize {
        if self.with_levels() {
            STATE_FIELD_INDEX_LAYERED
        } else {
            STATE_FIELD_INDEX_FLAT
        }
    }

    fn role_at(&self, index: usize) -> Option<FieldRole> {
        self.fields.get(index).and_then(|field| field.role)
    }

    /// Прежнее имя `validate_roles` (до роли `state` проверялась только
    /// пара `z`/`level`).
    pub fn validate_level_roles(&self, key: &str) -> Result<(), String> {
        self.validate_roles(key)
    }

    /// Проверяет контракт ролей строки блока динамики карты `key`: пара
    /// `z`/`level` и байт `state`. Зовётся при загрузке карты: молчаливый
    /// отказ здесь — это плоская строка вместо слоёной (ящики без уровня у
    /// всех клиентов) или строка без состояния (целый забор у зрителя).
    pub fn validate_roles(&self, key: &str) -> Result<(), String> {
        let state_index = self.state_field_index();

        for (index, field) in self.fields.iter().enumerate() {
            let expected = match field.role {
                Some(FieldRole::Z) => Z_FIELD_INDEX,
                Some(FieldRole::Level) => LEVEL_FIELD_INDEX,
                Some(FieldRole::State) => state_index,
                None => continue,
            };

            if index != expected {
                return Err(format!(
                    "[core snapshot] Ключ '{key}': поле '{}' с ролью {:?} стоит \
                     на позиции {index}, движок ждёт его на позиции {expected}",
                    field.name, field.role
                ));
            }
        }

        if let Some(field) = self.fields.get(state_index)
            && field.role == Some(FieldRole::State)
        {
            if field.ty != FieldType::U8 {
                return Err(format!(
                    "[core snapshot] Ключ '{key}': поле '{}' с ролью State обязано \
                     иметь тип u8, объявлено {:?}",
                    field.name, field.ty
                ));
            }

            // байт состояния пишется всегда: в опциональном хвосте покоящееся
            // тело распаковалось бы с нулём вместо своего состояния
            if let Some(from) = self.optional_from
                && from <= state_index
            {
                return Err(format!(
                    "[core snapshot] Ключ '{key}': optionalFrom {from} захватывает \
                     поле '{}' с ролью State (позиция {state_index}) — оно обязано \
                     стоять в обязательной части строки",
                    field.name
                ));
            }
        }

        // только сами роли пары: `state` на позиции 3 плоской строки —
        // не половина слоёной
        let z = self.role_at(Z_FIELD_INDEX).filter(|role| *role == FieldRole::Z);
        let level = self
            .role_at(LEVEL_FIELD_INDEX)
            .filter(|role| *role == FieldRole::Level);

        if z.is_some() != level.is_some() {
            return Err(format!(
                "[core snapshot] Ключ '{key}': роли z и level объявляются \
                 только парой — строка динамики либо слоёная, либо нет"
            ));
        }

        // поле, названное движковым именем, но без роли: раньше эта пара
        // работала по именам, и молчаливый возврат к плоской строке при
        // обновлении движка — ровно тот отказ, ради которого роли и введены
        if z.is_none()
            && self.fields.get(Z_FIELD_INDEX).is_some_and(|f| f.name == "z")
            && self
                .fields
                .get(LEVEL_FIELD_INDEX)
                .is_some_and(|f| f.name == "level")
        {
            return Err(format!(
                "[core snapshot] Ключ '{key}': поля z/level строки динамики \
                 карты обязаны объявить role: 'z' и role: 'level'"
            ));
        }

        Ok(())
    }
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

            // хвост, который начинается за последним полем (или охватывает
            // всю строку), не кодирует ничего — флаг-байт стал бы чистым
            // расходом трафика на каждой строке
            if let Some(from) = schema.optional_from
                && (from == 0 || from >= schema.fields.len())
            {
                return Err(format!(
                    "[core snapshot] Ключ '{key}': optionalFrom {from} вне диапазона \
                     1..{} — опциональный хвост должен быть непустым, а обязательная \
                     часть строки не может быть пустой",
                    schema.fields.len().saturating_sub(1)
                ));
            }
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
            role: None,
        }
    }

    fn field_interp(name: &str, ty: FieldType, interp: Interp) -> FieldSchema {
        FieldSchema {
            name: name.to_string(),
            ty,
            interp,
            role: None,
        }
    }

    /// Поле с движковой ролью (`z`/`level` слоёной строки динамики).
    pub fn field_role(name: &str, ty: FieldType, interp: Interp, role: FieldRole) -> FieldSchema {
        FieldSchema {
            name: name.to_string(),
            ty,
            interp,
            role: Some(role),
        }
    }

    pub fn tanks_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::Indexed8,
            class: BlockClass::Hot,
            optional_from: None,
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
            optional_from: None,
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
            optional_from: None,
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
            optional_from: None,
            fields: vec![
                field("x", FieldType::F32),
                field("y", FieldType::F32),
                field("radius", FieldType::F32),
            ],
        }
    }

    /// Динамика карты с опциональным хвостом скоростей (кадр v4):
    /// покоящееся тело шлёт только трансформацию.
    pub fn dynamics_schema(id: u8) -> BlockSchema {
        BlockSchema {
            id,
            kind: BlockKind::IndexedNoNull8,
            class: BlockClass::Hot,
            optional_from: Some(3),
            fields: vec![
                field_interp("x", FieldType::F32, Interp::Lerp),
                field_interp("y", FieldType::F32, Interp::Lerp),
                field_interp("angle", FieldType::F32, Interp::LerpAngle),
                field_interp("vx", FieldType::F32, Interp::Lerp),
                field_interp("vy", FieldType::F32, Interp::Lerp),
                // угловая СКОРОСТЬ, а не угол — интерполируется как число
                field_interp("angvel", FieldType::F32, Interp::Lerp),
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
    fn optional_from_out_of_range_fails() {
        let mut cfg = full_snapshot_config(3, 5);

        cfg.keys.get_mut("c1").unwrap().optional_from = Some(6);

        let err = cfg.validate().unwrap_err();
        assert!(err.contains("optionalFrom"));
    }

    #[test]
    fn optional_from_zero_fails() {
        let mut cfg = full_snapshot_config(3, 5);

        cfg.keys.get_mut("c1").unwrap().optional_from = Some(0);

        assert!(cfg.validate().is_err());
    }

    #[test]
    fn duplicate_id_fails() {
        let mut cfg = full_snapshot_config(3, 5);

        cfg.keys.get_mut("w2").unwrap().id = cfg.keys["m1"].id;

        let err = cfg.validate().unwrap_err();
        assert!(err.contains("w2"));
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;

    fn schema(fields: serde_json::Value, optional_from: Option<usize>) -> BlockSchema {
        serde_json::from_value(serde_json::json!({
            "id": 1,
            "kind": "indexedNoNull8",
            "class": "hot",
            "fields": fields,
            "optionalFrom": optional_from,
        }))
        .unwrap()
    }

    fn head() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({ "name": "x", "ty": "f32", "interp": "lerp" }),
            serde_json::json!({ "name": "y", "ty": "f32", "interp": "lerp" }),
            serde_json::json!({ "name": "angle", "ty": "f32", "interp": "lerpAngle" }),
        ]
    }

    fn levels() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({ "name": "z", "ty": "f32", "interp": "lerp", "role": "z" }),
            serde_json::json!({ "name": "level", "ty": "u8", "role": "level" }),
        ]
    }

    fn state(ty: &str) -> serde_json::Value {
        serde_json::json!({ "name": "hp", "ty": ty, "role": "state" })
    }

    fn tail() -> Vec<serde_json::Value> {
        ["vx", "vy", "angvel"]
            .iter()
            .map(|name| serde_json::json!({ "name": name, "ty": "f32", "interp": "lerp" }))
            .collect()
    }

    fn fields(parts: &[Vec<serde_json::Value>]) -> serde_json::Value {
        serde_json::Value::Array(parts.concat())
    }

    #[test]
    fn state_sits_right_after_a_flat_head() {
        let schema = schema(fields(&[head(), vec![state("u8")], tail()]), Some(4));

        assert!(schema.with_state());
        assert!(!schema.with_levels());
        assert!(schema.validate_roles("c1").is_ok());
    }

    #[test]
    fn state_sits_right_after_a_layered_head() {
        let schema = schema(fields(&[head(), levels(), vec![state("u8")], tail()]), Some(6));

        assert!(schema.with_state());
        assert!(schema.with_levels());
        assert!(schema.validate_roles("c1").is_ok());
        // прежнее имя проверяет то же самое
        assert!(schema.validate_level_roles("c1").is_ok());
    }

    #[test]
    fn schema_without_state_role_has_no_state() {
        let schema = schema(fields(&[head(), tail()]), Some(3));

        assert!(!schema.with_state());
        assert!(schema.validate_roles("c1").is_ok());
    }

    #[test]
    fn state_must_be_u8() {
        let error = schema(fields(&[head(), vec![state("f32")]]), None)
            .validate_roles("c1")
            .unwrap_err();

        assert!(error.contains("u8"), "{error}");
    }

    #[test]
    fn state_at_the_flat_position_of_a_layered_row_is_rejected() {
        let error = schema(
            fields(&[head(), vec![state("u8")], levels()]),
            None,
        )
        .validate_roles("c1")
        .unwrap_err();

        assert!(error.contains("позиции"), "{error}");
    }

    #[test]
    fn state_inside_the_optional_tail_is_rejected() {
        let error = schema(fields(&[head(), vec![state("u8")], tail()]), Some(3))
            .validate_roles("c1")
            .unwrap_err();

        assert!(error.contains("optionalFrom"), "{error}");
    }
}
