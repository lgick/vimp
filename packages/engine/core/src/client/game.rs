//! Граница клиентского generic-каркаса ↔ игровой предикт (Этап 4b плана
//! распила, PLAN.md §3.6/§4b). `ClientState<G>` (этот модуль) владеет сетевым
//! буфером (`Interpolator`), очередью событийных кадров и hot-буфером
//! рендер-тика; конкретная игра (`TanksClient` и т.п.) реализует
//! `GameClientDef` — client-side prediction своего актора, визуальный
//! спавн эффектов, панель. Форма трейта валидирована фикстурой
//! (`tests` в этом модуле, `TestClient`) до миграции танков — см.
//! PLAN_4_details.md.
//!
//! Камера и predicted-хвост hot-буфера разделены: движок пишет камеру как
//! `[f32; 2]` (общий для любой игры смысл — «куда смотреть»), а форму
//! хвоста (набор полей актора) собирает игра — движок дописывает его в
//! hot-буфер как непрозрачный `Vec<f32>`, не зная раскладки (см.
//! `RenderOverlay`).

use serde_json::{Map, Value, json};

use super::interpolator::{FrameData, InterpolatedGame, Interpolator};
use super::unpack::{self, DecodedSnapshot, UnpackError};
use crate::config::{BlockKind, EngineClientConfig, FieldValue, PLAYER_STATE_LEN, SnapshotConfig};

/// Predicted-запись рендер-тика: камера (общий смысл) + непрозрачный
/// хвост hot-буфера (раскладку полей актора знает только игра).
pub struct RenderOverlay {
    pub camera: [f32; 2],
    pub tail: Vec<f32>,
}

/// Игровая половина клиентского ядра — зеркало `crate::sim::GameSim<G>` на
/// клиентской стороне. `ClientState<G>` (ниже) зовёт эти методы в фиксированных
/// точках рендер-тика; `Self` хранит всё нужное для предикта (модели, оружие,
/// историю ввода) само — `ClientState<G>` игровых конфигов не хранит.
pub trait GameClientDef: Sized {
    type Config: serde::de::DeserializeOwned;

    fn new(cfg: &Self::Config, engine_cfg: &EngineClientConfig) -> Self;

    /// Reconciliation по player-блоку кадра (авторитетное состояние своего
    /// актора). Раскладка `[f32; PLAYER_STATE_LEN]` — движковая (общая с
    /// серверным `GameSim::prediction_state`), поэтому не параметризована
    /// трейтом отдельно.
    fn on_server_state(
        &mut self,
        state: [f32; PLAYER_STATE_LEN],
        centering: bool,
        server_time: f64,
        offset: f64,
        local_now: f64,
    );

    /// Оценка задержки (для RTT-компенсации визуальных эффектов).
    fn set_server_offset(&mut self, offset: Option<f64>);

    /// Шаг предикта до текущего рендер-времени.
    fn update(&mut self, local_now: f64);

    /// Отслеживание своего актора в пересечённом кадре (дискретные поля,
    /// freeze при уничтожении, reset по forceReset камеры). `my_game_id` —
    /// текущий id своего актора (из последнего player-блока).
    fn track_frame(&mut self, my_game_id: Option<u32>, frame: &FrameData);

    /// Фильтр собственных событий в JSON-форме кадра (подавление дублей
    /// локально предсказанных эффектов).
    fn filter_frame_game(&mut self, game: &mut Map<String, Value>, my_game_id: Option<u32>, local_now: f64);

    /// Обновление игрового мира для дальнейшего локального спавна эффектов
    /// (raycast и т.п.) — по каждому пересечённому кадру.
    fn update_world(&mut self, snapshot: &DecodedSnapshot);

    /// То же — по интерполированному состоянию (между кадрами).
    fn update_world_interpolated(&mut self, game: &InterpolatedGame);

    /// Полная predicted-запись рендер-тика; `None` — предикт не готов (нет
    /// своего актора/модели/меты), тогда камера рендер-тика берётся из
    /// интерполяции, а флаг HOT_HAS_PREDICTED не выставляется.
    fn render_overlay(&self, my_game_id: Option<u32>) -> Option<RenderOverlay>;

    fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64);
    fn set_model(&mut self, model_name: &str);
    fn set_active(&mut self, active: bool);
    fn set_map(&mut self, map_json: &str) -> Result<(), String>;
    fn sync_panel(&mut self, items: &[String]);
    fn reset(&mut self);

    /// Циклический выбор активного предмета/режима актора (нейтральный
    /// аналог смены оружия — конкретный смысл определяет игра).
    fn cycle_item(&mut self, back: bool);

    /// Локальное визуальное действие актора (выстрел и т.п.; гейты внутри —
    /// предикт активен, свой актор жив). JSON спавна либо `None`.
    fn try_action(&mut self, my_game_id: Option<u32>, local_now: f64) -> Option<String>;
}

// приводит любое поле строки к f32 для плоского hot-буфера
fn field_as_f32(value: FieldValue) -> f32 {
    match value {
        FieldValue::F32(v) => v,
        FieldValue::U8(v) => v as f32,
        FieldValue::U16(v) => v as f32,
        FieldValue::U32(v) => v as f32,
    }
}

// блоки интерполированного кадра нужной формы (kind), с id ключа реестра
// snapshot.keys (записывается в hot-буфер как keyId).
fn blocks_of_kind<'a>(
    snapshot_cfg: &'a SnapshotConfig,
    game: &'a InterpolatedGame,
    kind: BlockKind,
) -> impl Iterator<Item = (u8, &'a Vec<super::interpolator::InterpolatedRow>)> {
    game.blocks.iter().filter_map(move |(key, rows)| {
        let schema = snapshot_cfg.keys.get(key)?;

        (schema.kind == kind).then_some((schema.id, rows))
    })
}

/// Generic оркестрация клиентского ядра поверх игровой `G: GameClientDef`:
/// сетевой буфер (interpolator), очередь событийных кадров, hot-буфер
/// рендер-тика. Байтовая раскладка hot-буфера (флаги/камера/N танков×поля/M
/// динамики×поля/predicted-хвост) не меняется — см. `write_hot`.
pub struct ClientState<G: GameClientDef> {
    cfg: EngineClientConfig,
    interpolator: Interpolator,
    game: G,

    // id своего актора из последнего player-блока
    my_game_id: Option<u32>,

    // очередь событийных кадров на take_frames (в форме applyShot)
    frames_out: Vec<Value>,

    // переиспользуемый плоский буфер рендер-тика
    hot: Vec<f32>,
}

impl<G: GameClientDef> ClientState<G> {
    pub fn new(cfg: EngineClientConfig, game_cfg: &G::Config) -> Self {
        let interpolator = Interpolator::new(&cfg.interpolation, cfg.snapshot.clone());
        let game = G::new(game_cfg, &cfg);

        Self {
            cfg,
            interpolator,
            game,
            my_game_id: None,
            frames_out: Vec::new(),
            hot: Vec::new(),
        }
    }

    /// Бинарный кадр из транспорта: распаковка, вставка в буфер по seq,
    /// reconciliation предикта по player-блоку. false — кадр отброшен
    /// (чужой порт, версия или повреждённые данные).
    pub fn push_frame(&mut self, data: &[u8], local_now: f64) -> bool {
        let frame = match unpack::unpack_frame(data, &self.cfg.snapshot) {
            Ok(frame) => frame,
            Err(UnpackError::WrongVersion | UnpackError::Truncated) => return false,
        };

        if frame.port != self.cfg.snapshot.port {
            return false;
        }

        self.interpolator.push(
            FrameData {
                snapshot: frame.snapshot,
                camera: frame.camera,
            },
            frame.server_time,
            local_now,
            frame.seq,
        );

        if let Some(player) = frame.player {
            self.my_game_id = Some(player.game_id as u32);

            // после push оффсет всегда известен
            let offset = self.interpolator.offset().unwrap_or(0.0);

            self.game.on_server_state(
                player.state,
                player.centering,
                frame.server_time,
                offset,
                local_now,
            );
        }

        true
    }

    pub fn my_game_id(&self) -> Option<u32> {
        self.my_game_id
    }

    pub fn offset(&self) -> Option<f64> {
        self.interpolator.offset()
    }

    /// Рендер-тик: выдача пересечённых кадров (фильтр дублей → JSON-очередь),
    /// интерполяция, шаг предикта, запись hot-буфера. Возвращает длину
    /// hot-буфера в f32-элементах.
    pub fn sample(&mut self, local_now: f64) -> usize {
        self.game.set_server_offset(self.interpolator.offset());

        let result = self.interpolator.sample(local_now);

        // событийные кадры: свой актор → фильтр дублей → очередь → мир
        for frame in result.frames {
            self.game.track_frame(self.my_game_id, &frame);

            let mut game = unpack::snapshot_to_json(&frame.snapshot);

            self.game
                .filter_frame_game(&mut game, self.my_game_id, local_now);

            self.frames_out.push(json!({
                "game": game,
                "camera": unpack::camera_to_json(frame.camera.as_ref()),
            }));

            self.game.update_world(&frame.snapshot);
        }

        if let Some(game) = &result.game {
            self.game.update_world_interpolated(game);
        }

        self.game.update(local_now);

        let overlay = self.game.render_overlay(self.my_game_id);

        self.write_hot(result.game.as_ref(), result.camera, overlay.as_ref());
        self.hot.len()
    }

    pub fn hot(&self) -> &[f32] {
        &self.hot
    }

    /// Событийные кадры JSON-строкой [{game, camera}, ...]; очередь очищается.
    pub fn take_frames(&mut self) -> String {
        let frames = std::mem::take(&mut self.frames_out);

        serde_json::to_string(&frames).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64) {
        self.game.apply_input(action, key_name, local_now);
    }

    pub fn try_action(&mut self, local_now: f64) -> Option<String> {
        self.game.try_action(self.my_game_id, local_now)
    }

    pub fn cycle_item(&mut self, back: bool) {
        self.game.cycle_item(back);
    }

    pub fn set_model(&mut self, model_name: &str) {
        self.game.set_model(model_name);
    }

    /// Смена режима игрок/спектатор (KEYSET_DATA).
    pub fn set_active(&mut self, active: bool) {
        self.game.set_active(active);
    }

    /// Данные карты (MAP_DATA): мир raycast + сброс буфера и предикта.
    pub fn set_map(&mut self, map_json: &str) -> Result<(), String> {
        self.interpolator.reset();
        self.frames_out.clear();
        self.game.set_map(map_json)
    }

    pub fn sync_panel(&mut self, panel_json: &str) {
        let Ok(Value::Array(items)) = serde_json::from_str(panel_json) else {
            return;
        };

        let items: Vec<String> = items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect();

        self.game.sync_panel(&items);
    }

    /// Полный сброс (порт CLEAR).
    pub fn reset(&mut self) {
        self.interpolator.reset();
        self.game.reset();
        self.frames_out.clear();
    }

    /// Чистая распаковка кадра v3 в JSON-форму unpackFrame (тесты/харнесс).
    pub fn decode_frame(&self, data: &[u8]) -> String {
        match unpack::unpack_frame(data, &self.cfg.snapshot) {
            Ok(frame) => unpack::frame_to_json(&frame).to_string(),
            Err(_) => "null".to_string(),
        }
    }

    // плоский Float32-буфер рендер-тика:
    // [0] flags, [1..2] камера x/y, [3] N строк hot-блоков (Indexed8), N×(2+поля),
    // [..] M строк динамики (IndexedNoNull8), M×(2+поля), затем — непрозрачный
    // predicted-хвост игры (см. GameClientDef::render_overlay).
    fn write_hot(
        &mut self,
        game: Option<&InterpolatedGame>,
        camera: Option<[f32; 2]>,
        overlay: Option<&RenderOverlay>,
    ) {
        self.hot.clear();

        let mut flags = 0u32;

        if game.is_some() {
            flags |= super::HOT_HAS_GAME;
        }

        if !self.frames_out.is_empty() {
            flags |= super::HOT_HAS_FRAMES;
        }

        if overlay.is_some() {
            flags |= super::HOT_HAS_PREDICTED;
        }

        // камера: предсказанная позиция либо интерполированная
        let camera = overlay.map(|o| o.camera).or(camera);

        if camera.is_some() {
            flags |= super::HOT_HAS_CAMERA;
        }

        self.hot.push(flags as f32);

        let camera = camera.unwrap_or([0.0, 0.0]);

        self.hot.push(camera[0]);
        self.hot.push(camera[1]);

        let empty = InterpolatedGame::default();
        let game = game.unwrap_or(&empty);

        // строки блоков — по форме (BlockKind), не по игровой сущности:
        // Indexed8 пишется как «танк» (keyId, gameId, поля), IndexedNoNull8
        // — как «динамика карты» (keyId, index, поля); порядок и число
        // полей идут напрямую из schema.fields.
        let tank_count: usize = blocks_of_kind(&self.cfg.snapshot, game, BlockKind::Indexed8)
            .map(|(_, rows)| rows.len())
            .sum();

        self.hot.push(tank_count as f32);

        for (key_id, rows) in blocks_of_kind(&self.cfg.snapshot, game, BlockKind::Indexed8) {
            for row in rows {
                self.hot.push(key_id as f32);
                self.hot.push(row.id as f32);

                for field in &row.fields {
                    self.hot.push(field_as_f32(*field));
                }
            }
        }

        let dynamic_count: usize =
            blocks_of_kind(&self.cfg.snapshot, game, BlockKind::IndexedNoNull8)
                .map(|(_, rows)| rows.len())
                .sum();

        self.hot.push(dynamic_count as f32);

        for (key_id, rows) in blocks_of_kind(&self.cfg.snapshot, game, BlockKind::IndexedNoNull8) {
            for row in rows {
                self.hot.push(key_id as f32);
                self.hot.push(row.id as f32);

                for field in &row.fields {
                    self.hot.push(field_as_f32(*field));
                }
            }
        }

        if let Some(overlay) = overlay {
            self.hot.extend_from_slice(&overlay.tail);
        }
    }
}

/// Фикстурный второй клиент — валидатор формы `GameClientDef` (Этап 4b,
/// PLAN_4_details.md): доказывает, что трейт не завязан по форме на танки,
/// до миграции `games/tanks` на него (см. `TanksClient`). Состояние —
/// тривиальная линейная интеграция позиции по vx/vy, без формул движения
/// игры (мотор здесь не нужен — только форма трейта).
#[cfg(test)]
mod fixture {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct TestConfig {}

    pub struct TestClient {
        x: f32,
        y: f32,
        vx: f32,
        vy: f32,
        active: bool,
        alive: bool,
        last_update: Option<f64>,
    }

    impl GameClientDef for TestClient {
        type Config = TestConfig;

        fn new(_cfg: &Self::Config, _engine_cfg: &EngineClientConfig) -> Self {
            Self {
                x: 0.0,
                y: 0.0,
                vx: 0.0,
                vy: 0.0,
                active: false,
                alive: true,
                last_update: None,
            }
        }

        fn on_server_state(
            &mut self,
            state: [f32; PLAYER_STATE_LEN],
            _centering: bool,
            _server_time: f64,
            _offset: f64,
            _local_now: f64,
        ) {
            self.x = state[0];
            self.y = state[1];
            self.vx = state[3];
            self.vy = state[4];
        }

        fn set_server_offset(&mut self, _offset: Option<f64>) {}

        fn update(&mut self, local_now: f64) {
            let dt = self
                .last_update
                .map(|last| (local_now - last) / 1000.0)
                .unwrap_or(0.0) as f32;

            self.x += self.vx * dt;
            self.y += self.vy * dt;
            self.last_update = Some(local_now);
        }

        fn track_frame(&mut self, _my_game_id: Option<u32>, _frame: &FrameData) {}

        fn filter_frame_game(
            &mut self,
            _game: &mut Map<String, Value>,
            _my_game_id: Option<u32>,
            _local_now: f64,
        ) {
        }

        fn update_world(&mut self, _snapshot: &DecodedSnapshot) {}

        fn update_world_interpolated(&mut self, _game: &InterpolatedGame) {}

        fn render_overlay(&self, my_game_id: Option<u32>) -> Option<RenderOverlay> {
            let game_id = my_game_id?;

            (self.active && self.alive).then(|| RenderOverlay {
                camera: [self.x, self.y],
                tail: vec![0.0, game_id as f32, self.x, self.y],
            })
        }

        fn apply_input(&mut self, _action: &str, _key_name: &str, _local_now: f64) {}

        fn set_model(&mut self, _model_name: &str) {}

        fn set_active(&mut self, active: bool) {
            self.active = active;
        }

        fn set_map(&mut self, _map_json: &str) -> Result<(), String> {
            Ok(())
        }

        fn sync_panel(&mut self, _items: &[String]) {}

        fn reset(&mut self) {
            self.x = 0.0;
            self.y = 0.0;
            self.last_update = None;
        }

        fn cycle_item(&mut self, _back: bool) {}

        fn try_action(&mut self, _my_game_id: Option<u32>, _local_now: f64) -> Option<String> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::{TestClient, TestConfig};
    use super::*;
    use crate::client::{HOT_HAS_CAMERA, HOT_HAS_FRAMES, HOT_HAS_GAME, HOT_HAS_PREDICTED};
    use crate::snapshot::{Block, CameraData, PlayerBlock, SnapshotPacker};

    fn config_json() -> serde_json::Value {
        serde_json::json!({
            "timeStepMs": 1000.0 / 120.0,
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": {
                    "actor": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" }
                    ] }
                }
            },
            "interpolation": { "delay": 100, "maxFrameAge": 1000 }
        })
    }

    fn engine_client_config() -> EngineClientConfig {
        serde_json::from_value(config_json()).unwrap()
    }

    fn make_state() -> ClientState<TestClient> {
        ClientState::new(engine_client_config(), &TestConfig {})
    }

    fn frame_bytes(server_time: f64, seq: u32, x: f32, with_player: bool) -> Vec<u8> {
        let cfg = engine_client_config();
        let mut packer = SnapshotPacker::new(cfg.snapshot.clone());

        packer
            .pack_body(&[(
                "actor".to_string(),
                Block::Indexed8(vec![(2, Some(vec![FieldValue::F32(x), FieldValue::F32(0.0)]))]),
            )])
            .unwrap();

        let camera = CameraData {
            x,
            y: 0.0,
            force_reset: false,
            shake: None,
        };
        let player = PlayerBlock {
            game_id: 2,
            input_seq: 0,
            state: [x, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            centering: false,
        };

        packer
            .pack_frame(
                server_time,
                seq,
                Some(&camera),
                with_player.then_some(&player),
            )
            .to_vec()
    }

    #[test]
    fn push_frame_and_sample_writes_hot_layout() {
        let mut state = make_state();

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, false), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, false), 1100.0);

        // renderTime = 1150 − 100 = 1050 → alpha 0.5
        let len = state.sample(1150.0);
        let hot = state.hot().to_vec();

        assert_eq!(len, hot.len());

        let flags = hot[0] as u32;

        assert!(flags & HOT_HAS_GAME != 0);
        assert!(flags & HOT_HAS_CAMERA != 0);
        assert!(flags & HOT_HAS_FRAMES != 0);
        assert!(flags & HOT_HAS_PREDICTED == 0);

        // один актор: keyId 1, gameId 2, x = 15 (лерп)
        assert_eq!(hot[3], 1.0);
        assert_eq!(hot[4], 1.0);
        assert_eq!(hot[5], 2.0);
        assert_eq!(hot[6], 15.0);

        let frames: Vec<serde_json::Value> =
            serde_json::from_str(&state.take_frames()).unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(state.take_frames(), "[]");
    }

    #[test]
    fn render_overlay_appends_opaque_tail_and_sets_flag() {
        let mut state = make_state();

        state.set_active(true);
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);

        assert_eq!(state.my_game_id(), Some(2));

        state.sample(1150.0);

        let hot = state.hot().to_vec();
        let flags = hot[0] as u32;

        assert!(flags & HOT_HAS_PREDICTED != 0);

        // хвост — последние 4 f32 (форма TestClient::render_overlay)
        let tail = &hot[hot.len() - 4..];

        assert_eq!(tail[1], 2.0); // gameId
        assert_eq!(hot[1], tail[2]); // камера следует хвосту (x)
    }

    #[test]
    fn reset_clears_predictor_and_frame_queue() {
        let mut state = make_state();

        state.set_active(true);
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.sample(1150.0);

        state.reset();

        assert_eq!(state.take_frames(), "[]");
    }

    // Расширение сценариев фикстуры (Этап 7 плана отделения движка): второй
    // ключ схемы другого BlockKind (IndexedNoNull8 — «динамика карты» по
    // форме) наряду с Indexed8 («танк» по форме) — доказывает, что hot-буфер
    // остаётся schema-driven для произвольного набора ключей, а не только
    // для одного actor-блока выше.
    #[test]
    fn second_schema_key_of_different_block_kind_flows_into_hot_buffer() {
        let config = serde_json::json!({
            "timeStepMs": 1000.0 / 120.0,
            "snapshot": {
                "version": 3,
                "port": 5,
                "keys": {
                    "actor": { "id": 1, "kind": "indexed8", "class": "hot", "fields": [
                        { "name": "x", "ty": "f32", "interp": "lerp" },
                        { "name": "y", "ty": "f32", "interp": "lerp" }
                    ] },
                    "zone": { "id": 2, "kind": "indexedNoNull8", "class": "hot", "fields": [
                        { "name": "level", "ty": "f32", "interp": "discrete" }
                    ] }
                }
            },
            "interpolation": { "delay": 100, "maxFrameAge": 1000 }
        });
        let cfg: EngineClientConfig = serde_json::from_value(config).unwrap();
        let mut state = ClientState::<TestClient>::new(cfg.clone(), &TestConfig {});
        let mut packer = SnapshotPacker::new(cfg.snapshot.clone());

        packer
            .pack_body(&[
                (
                    "actor".to_string(),
                    Block::Indexed8(vec![(2, Some(vec![FieldValue::F32(10.0), FieldValue::F32(0.0)]))]),
                ),
                (
                    "zone".to_string(),
                    Block::IndexedNoNull8(vec![(0, vec![FieldValue::F32(7.0)])]),
                ),
            ])
            .unwrap();

        let frame = packer.pack_frame(1000.0, 1, None, None).to_vec();

        state.push_frame(&frame, 1000.0);
        state.push_frame(&frame, 1100.0);
        state.sample(1150.0);

        let hot = state.hot().to_vec();

        // [flags, camX, camY, tankCount, keyId, gameId, x, y, dynamicCount, keyId, index, level]
        assert_eq!(hot[3], 1.0); // tankCount (Indexed8)
        assert_eq!(hot[8], 1.0); // dynamicCount (IndexedNoNull8)
        assert_eq!(hot[9], 2.0); // keyId зоны
        assert_eq!(hot[11], 7.0); // level
    }
}
