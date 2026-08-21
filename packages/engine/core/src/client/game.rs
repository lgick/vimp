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
//!
//! Тем же хвостом игра перекрывает и ЧУЖИЕ строки кадра
//! (`GameClientDef::render_rows`): предсказанные телом игры сущности —
//! динамика карты, контактирующие чужие акторы — дописываются записями
//! после predicted-хвоста, а разбор hot-буфера кладёт запись в
//! `game[key][id]`, поэтому последняя запись перекрывает интерполированную.

use serde_json::{Map, Value, json};

use super::divergence::{DivergenceTracker, Observation, Source};
use super::interpolator::{FrameData, InterpolatedGame, Interpolator};
use super::unpack::{self, DecodedSnapshot, UnpackError};
use crate::config::{BlockKind, EngineClientConfig, FieldValue, PLAYER_STATE_LEN, SnapshotConfig};

/// Predicted-запись рендер-тика: камера (общий смысл) + непрозрачный
/// хвост hot-буфера (раскладку полей актора знает только игра).
pub struct RenderOverlay {
    pub camera: [f32; 2],
    pub tail: Vec<f32>,
}

/// Строка рендер-тика, которой игра перекрывает интерполированную:
/// `key_id` — числовой id ключа снапшот-реестра, `id` — id строки
/// (`gameId` для `Indexed8`, индекс для `IndexedNoNull8`), `fields` — поля
/// по схеме этого ключа. Ширину движок приводит к схеме сам: лишние поля
/// отбрасываются, недостающие дописываются нулями, иначе одна кривая
/// запись сдвинула бы разбор всего хвоста.
pub struct PredictedRow {
    pub key_id: u8,
    pub id: u32,
    pub fields: Vec<f32>,
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

    /// Шаг предикта до текущего рендер-времени.
    fn update(&mut self, local_now: f64);

    /// Авторитетный кадр ПЕРЕД replay предикта: игра снимает с него
    /// состояние тел, которые ведёт сама (динамика карты, чужие акторы
    /// в контакте). Дефолт пустой — игре, предсказывающей только своего
    /// актора, кадр в этой точке не нужен.
    fn begin_reconcile(&mut self, _snapshot: &DecodedSnapshot) {}

    /// Парный хук ПОСЛЕ `on_server_state`: replay уже переиграл и тела
    /// игры, так что расхождение старого предсказания с новым считается
    /// здесь. Дефолт пустой.
    fn finish_reconcile(&mut self) {}

    /// Строки рендер-тика, которыми игра перекрывает интерполированные
    /// (см. `PredictedRow`). Дефолт пустой — предсказанных чужих тел нет.
    fn render_rows(&self) -> Vec<PredictedRow> {
        Vec::new()
    }

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

    /// Предсказанное состояние своего актора в раскладке player-блока —
    /// уровень 1 детектора рассинхрона (`client::divergence`). Движок
    /// снимает его непосредственно перед `on_server_state`, то есть до
    /// затирания предикта авторитетным состоянием. Дефолт `None` — тогда
    /// движок сравнивает камеру predicted-оверлея с x/y кадра (уровень 0),
    /// и от плагина не требуется ничего.
    fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> {
        None
    }

    /// Окно локального времени истории ввода, переигранное последним
    /// реконсилем: (начало, конец, число вводов). Реконсиляция идёт по
    /// времени, а не по `seq`, поэтому именно окно локализует расхождение
    /// в формуле движения. Дефолт `None`.
    fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
        None
    }

    fn apply_input(&mut self, action: &str, key_name: &str, local_now: f64);

    /// Ввод указателем: мировая точка (движок уже пересчитал экранные
    /// координаты через камеру) и биты состояния указателя — бит 0
    /// «прижат», бит 1 «двойной тап». Дефолт пустой, как у `GameSim`.
    fn apply_aim(&mut self, _x: f32, _y: f32, _flags: u32, _local_now: f64) {}
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

    // детектор рассинхрона предикта; None в боевом конфиге — путь кадра
    // остаётся ровно таким же, как до этапа 5
    divergence: Option<DivergenceTracker>,

    // обратный индекс «id ключа → ширина строки»: id однобайтовый, поэтому
    // массив дешевле карты и без хеширования. Нужен write_hot, чтобы не
    // искать схему перебором на каждую предсказанную строку каждого кадра
    row_widths: Box<[Option<u16>; 256]>,
}

impl<G: GameClientDef> ClientState<G> {
    pub fn new(cfg: EngineClientConfig, game_cfg: &G::Config) -> Self {
        let interpolator = Interpolator::new(&cfg.interpolation, cfg.snapshot.clone());
        let game = G::new(game_cfg, &cfg);
        let divergence = cfg.divergence.clone().map(DivergenceTracker::new);

        let mut row_widths = Box::new([None; 256]);

        for schema in cfg.snapshot.keys.values() {
            row_widths[schema.id as usize] = Some(schema.fields.len() as u16);
        }

        Self {
            cfg,
            interpolator,
            game,
            my_game_id: None,
            frames_out: Vec::new(),
            hot: Vec::new(),
            divergence,
            row_widths,
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

        // тела, которые игра ведёт сама, снимаются с кадра ДО replay —
        // порядок тот же, что у своего актора: сначала авторитетное
        // состояние, потом переигранная история ввода
        if frame.player.is_some() {
            self.game.begin_reconcile(&frame.snapshot);
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

            self.observe_divergence(&player, frame.server_time, offset, local_now);

            self.game.on_server_state(
                player.state,
                player.centering,
                frame.server_time,
                offset,
                local_now,
            );

            // replay переиграл и тела игры — расхождение считается после него
            self.game.finish_reconcile();
        }

        true
    }

    /// Игровая половина ядра: игровая обёртка ABI (`ClientCore` плагина)
    /// достаёт через неё свои подсистемы — движок их формы не знает.
    pub fn game(&self) -> &G {
        &self.game
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
        let rows = self.game.render_rows();

        self.write_hot(result.game.as_ref(), result.camera, overlay.as_ref(), &rows);
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

    pub fn apply_aim(&mut self, x: f32, y: f32, flags: u32, local_now: f64) {
        self.game.apply_aim(x, y, flags, local_now);
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
        // мира больше нет: своя идентичность восстановится из первого же
        // player-блока, а у наблюдателя его нет — значит и предсказанной
        // сущности быть не должно
        self.my_game_id = None;
    }

    /// Ресинк часов после долгой паузы вкладки (visibilitychange → visible):
    /// сетевая половина начинает с чистого листа, чтобы следующий кадр
    /// пересеял оффсет точно, а не догонял EMA десятки кадров. Игровую
    /// половину (предикт, своя идентичность) не трогаем — сущности на
    /// полотне живы.
    pub fn resync(&mut self) {
        self.interpolator.reset();
        self.frames_out.clear();
    }

    /// Зеркало серверного `EngineSim::debug_json` на клиенте: состояние
    /// сетевого буфера (глубина, окно seq, оффсет, последний кадр), свой
    /// gameId, размеры hot-буфера и очереди событийных кадров.
    pub fn debug_json(&self) -> String {
        json!({
            "myGameId": self.my_game_id,
            "offset": self.interpolator.offset(),
            "interpolator": self.interpolator.debug_json(),
            "hotLen": self.hot.len(),
            "framesOut": self.frames_out.len(),
        })
        .to_string()
    }

    /// Записи расхождения предикта с авторитетным состоянием (JSON,
    /// см. `client::divergence`); очередь очищается. `"null"` — детектор
    /// выключен (боевой конфиг без секции `divergence`).
    pub fn take_divergence(&mut self) -> String {
        match &mut self.divergence {
            Some(tracker) => tracker.take_json(),
            None => "null".to_string(),
        }
    }

    // Снимок предикта ДО реконсиляции: после on_server_state сравнивать уже
    // не с чем — состояние затёрто авторитетным.
    fn observe_divergence(
        &mut self,
        player: &unpack::DecodedPlayer,
        server_time: f64,
        offset: f64,
        local_now: f64,
    ) {
        let Some(tracker) = &mut self.divergence else {
            return;
        };

        // уровень 1 (predicted_state игры) либо уровень 0 (камера оверлея)
        let (source, predicted) = match self.game.predicted_state() {
            Some(state) => (Source::State, state.to_vec()),
            None => match self.game.render_overlay(self.my_game_id) {
                Some(overlay) => (Source::Camera, overlay.camera.to_vec()),
                None => return,
            },
        };

        tracker.observe(Observation {
            source,
            predicted: &predicted,
            authoritative: &player.state,
            server_time,
            local_now,
            offset,
            input_seq: player.input_seq,
            replayed: self.game.replayed_inputs(),
        });
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
    // predicted-хвост игры (см. GameClientDef::render_overlay) и её
    // предсказанные строки (GameClientDef::render_rows), перекрывающие
    // интерполированные: разбор кладёт запись в game[key][id], последняя
    // побеждает.
    fn write_hot(
        &mut self,
        game: Option<&InterpolatedGame>,
        camera: Option<[f32; 2]>,
        overlay: Option<&RenderOverlay>,
        rows: &[PredictedRow],
    ) {
        self.hot.clear();

        let mut flags = 0u32;

        if game.is_some() {
            flags |= super::HOT_HAS_GAME;
        }

        if !self.frames_out.is_empty() {
            flags |= super::HOT_HAS_FRAMES;
        }

        // флаг означает «за группами есть хвостовые записи»: predicted-хвост
        // своего актора и/или строки тел, которые игра предсказывает сама
        // (render_rows). Без строк в флаге JS-потребитель, гейтящий разбор
        // по HOT_HAS_GAME | HOT_HAS_PREDICTED, молча выбросил бы их
        if overlay.is_some() || !rows.is_empty() {
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

        for row in rows {
            // ширина записи диктуется схемой ключа: неизвестный id пропускаем,
            // поля подрезаем/дополняем нулями — иначе одна кривая строка
            // сдвинет разбор всех следующих
            let Some(width) = self.row_widths[row.key_id as usize] else {
                continue;
            };

            let width = width as usize;

            self.hot.push(row.key_id as f32);
            self.hot.push(row.id as f32);

            for index in 0..width {
                self.hot.push(row.fields.get(index).copied().unwrap_or(0.0));
            }
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
        // уровень детектора рассинхрона, которым фикстура притворяется:
        // set_model("predicted") → уровень 1 (predicted_state), иначе — 0
        report_state: bool,
        // set_model("rows") → фикстура ведёт чужое тело и отдаёт его строкой
        predicted_rows: bool,
        // порядок вызовов хуков реконсиляции относительно on_server_state
        pub reconcile_log: Vec<&'static str>,
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
                report_state: false,
                predicted_rows: false,
                reconcile_log: Vec::new(),
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
            self.reconcile_log.push("state");
        }

        fn begin_reconcile(&mut self, _snapshot: &DecodedSnapshot) {
            self.reconcile_log.push("begin");
        }

        fn finish_reconcile(&mut self) {
            self.reconcile_log.push("finish");
        }

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

        // чужое тело, которое фикстура «предсказывает»: строка с той же
        // парой (keyId, id), что и в кадре, — она обязана перекрыть
        // интерполированную. Вторая строка проверяет приведение ширины
        // к схеме, третья — отсев неизвестного ключа
        fn render_rows(&self) -> Vec<PredictedRow> {
            if !self.predicted_rows {
                return Vec::new();
            }

            vec![
                PredictedRow {
                    key_id: 1,
                    id: 2,
                    fields: vec![111.0, 222.0],
                },
                PredictedRow {
                    key_id: 1,
                    id: 7,
                    fields: vec![333.0],
                },
                PredictedRow {
                    key_id: 200,
                    id: 9,
                    fields: vec![1.0, 2.0],
                },
            ]
        }

        fn predicted_state(&self) -> Option<[f32; PLAYER_STATE_LEN]> {
            self.report_state
                .then_some([self.x, self.y, 0.0, self.vx, self.vy, 0.0, 0.0, 0.0])
        }

        fn replayed_inputs(&self) -> Option<(f64, f64, usize)> {
            self.last_update.map(|last| (last - 50.0, last, 2))
        }

        fn apply_input(&mut self, _action: &str, _key_name: &str, _local_now: f64) {}

        fn set_model(&mut self, model_name: &str) {
            self.report_state = model_name == "predicted";
            self.predicted_rows = model_name == "rows";
        }

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

    // конфиг с включённым детектором рассинхрона (в боевом конфиге секции
    // divergence нет — путь кадра тогда не меняется вовсе)
    fn config_with_divergence(capacity: usize) -> EngineClientConfig {
        let mut json = config_json();

        json["divergence"] = serde_json::json!({
            "defaultThreshold": 1.0,
            "capacity": capacity,
        });

        serde_json::from_value(json).unwrap()
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
    fn reconcile_hooks_wrap_the_replay() {
        let mut state = make_state();

        state.set_active(true);

        // кадр без player-блока реконсиляции не запускает
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, false), 1000.0);
        assert!(state.game.reconcile_log.is_empty());

        state.push_frame(&frame_bytes(1100.0, 2, 20.0, true), 1100.0);

        // begin — до replay (авторитетное состояние тел игры),
        // finish — после (расхождение старого предсказания с новым)
        assert_eq!(state.game.reconcile_log, vec!["begin", "state", "finish"]);
    }

    #[test]
    fn render_rows_follow_the_tail_and_keep_schema_width() {
        let mut state = make_state();

        state.set_active(true);
        state.set_model("rows");
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, true), 1100.0);
        state.sample(1150.0);

        let hot = state.hot().to_vec();

        // ширина записи — 2 + поля схемы (2) = 4; неизвестный ключ (200)
        // отброшен, поэтому строк две, а не три
        let rows = &hot[hot.len() - 8..];

        assert_eq!(rows[0], 1.0); // keyId
        assert_eq!(rows[1], 2.0); // id — та же строка, что в кадре
        assert_eq!(rows[2], 111.0);
        assert_eq!(rows[3], 222.0);

        // короткая строка дополнена нулём до ширины схемы
        assert_eq!(rows[4], 1.0);
        assert_eq!(rows[5], 7.0);
        assert_eq!(rows[6], 333.0);
        assert_eq!(rows[7], 0.0);

        // интерполированная строка на месте: перекрытие делает разбор
        // (последняя запись с той же парой ключ/id побеждает)
        assert_eq!(hot[5], 2.0);
        assert_eq!(hot[6], 15.0);
    }

    #[test]
    fn game_rows_alone_still_raise_the_tail_flag() {
        // строки игры без predicted-хвоста своего актора: флаг обязан
        // подняться, иначе JS-потребитель не станет разбирать буфер.
        // Кадры идут БЕЗ player-блока (спектатор): только так my_game_id
        // остаётся None и render_overlay отдаёт None — иначе хвост своего
        // актора поднял бы флаг сам, и ветка осталась бы непроверенной
        let mut state = make_state();

        state.set_active(true);
        state.set_model("rows");
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, false), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, false), 1100.0);
        state.sample(1150.0);

        let hot = state.hot().to_vec();
        let flags = hot[0] as u32;

        assert!(flags & HOT_HAS_PREDICTED != 0);

        // хвост на месте: две строки игры по 4 f32
        let rows = &hot[hot.len() - 8..];

        assert_eq!(rows[0], 1.0);
        assert_eq!(rows[1], 2.0);
        assert_eq!(rows[4], 1.0);
        assert_eq!(rows[5], 7.0);
    }

    #[test]
    fn render_rows_default_to_empty() {
        let mut state = make_state();

        state.set_active(true);
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.sample(1150.0);

        // без строк игры буфер заканчивается predicted-хвостом (4 f32)
        let hot = state.hot().to_vec();

        assert_eq!(hot.len(), 3 + 1 + 4 + 1 + 4);
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

    #[test]
    fn resync_clears_network_half_only() {
        let mut state = make_state();

        state.set_active(true);
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, false), 1100.0);
        state.sample(1150.0);

        state.resync();

        let dump: serde_json::Value = serde_json::from_str(&state.debug_json()).unwrap();

        assert_eq!(dump["interpolator"]["buffered"], 0);
        assert!(dump["interpolator"]["lastFrame"].is_null());
        assert!(dump["offset"].is_null());
        assert_eq!(dump["framesOut"], 0);
        assert_eq!(state.take_frames(), "[]");

        // игровая половина цела: своя идентичность не потеряна
        assert_eq!(state.my_game_id(), Some(2));
    }

    #[test]
    fn debug_json_reports_buffer_seq_window_and_offset() {
        let mut state = make_state();

        let empty: serde_json::Value = serde_json::from_str(&state.debug_json()).unwrap();

        assert!(empty["myGameId"].is_null());
        assert_eq!(empty["interpolator"]["buffered"], 0);
        assert!(empty["interpolator"]["lastFrame"].is_null());

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, false), 1100.0);
        state.sample(1150.0);

        let dump: serde_json::Value = serde_json::from_str(&state.debug_json()).unwrap();

        assert_eq!(dump["myGameId"], 2);
        assert_eq!(dump["interpolator"]["buffered"], 2);
        assert_eq!(dump["interpolator"]["seqWindow"], serde_json::json!([1, 2]));
        assert_eq!(dump["interpolator"]["lastFrame"]["seq"], 2);
        assert_eq!(dump["interpolator"]["lastFrame"]["serverTime"], 1100.0);
        assert_eq!(dump["interpolator"]["delay"], 100.0);
        assert_eq!(dump["offset"], dump["interpolator"]["offset"]);
        assert_eq!(dump["hotLen"], state.hot().len());
        assert_eq!(dump["framesOut"], 1);
    }

    // ***** детектор рассинхрона предикта (этап 5 plan/done/ai-debug) ***** //

    #[test]
    fn divergence_is_off_without_config() {
        let mut state = make_state();

        state.set_active(true);
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);

        assert_eq!(state.take_divergence(), "null");
    }

    // уровень 0: плагин не реализовал predicted_state — сравнивается камера
    // predicted-оверлея с x/y авторитетного состояния
    #[test]
    fn divergence_falls_back_to_overlay_camera() {
        let mut state = ClientState::<TestClient>::new(config_with_divergence(8), &TestConfig {});

        state.set_active(true);
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);

        let dump: serde_json::Value = serde_json::from_str(&state.take_divergence()).unwrap();
        let record = &dump["records"][0];

        assert_eq!(dump["samples"], 1);
        assert_eq!(dump["violations"], 1);
        assert_eq!(record["source"], "camera");
        assert_eq!(record["predicted"], serde_json::json!([0.0, 0.0]));
        assert_eq!(record["authoritative"], serde_json::json!([10.0, 0.0]));
        assert_eq!(record["delta"][0], -10.0);
        assert_eq!(record["exceeded"], serde_json::json!([0]));
        assert_eq!(record["thresholds"][0], 1.0);
        assert!(record["replayed"].is_null());
    }

    // уровень 1: predicted_state сравнивается покомпонентно, а отчёт несёт
    // serverTime/offset/окно переигранного ввода — реконсиляция идёт по
    // времени, а не по seq
    #[test]
    fn divergence_reports_predicted_state_and_replay_window() {
        let mut state = ClientState::<TestClient>::new(config_with_divergence(8), &TestConfig {});

        state.set_active(true);
        state.set_model("predicted");

        // первый кадр совпадает с предиктом — записи быть не должно
        state.push_frame(&frame_bytes(1000.0, 1, 0.0, true), 1000.0);
        state.sample(1100.0);
        state.push_frame(&frame_bytes(1100.0, 2, 50.0, true), 1100.0);

        let dump: serde_json::Value = serde_json::from_str(&state.take_divergence()).unwrap();

        assert_eq!(dump["samples"], 2);
        assert_eq!(dump["violations"], 1);
        assert_eq!(dump["records"].as_array().unwrap().len(), 1);
        assert_eq!(dump["maxDelta"][0], 50.0);

        let record = &dump["records"][0];

        assert_eq!(record["source"], "state");
        assert_eq!(record["serverTime"], 1100.0);
        assert_eq!(record["localNow"], 1100.0);
        assert_eq!(record["inputSeq"], 0);
        assert_eq!(record["delta"][0], -50.0);
        assert_eq!(record["exceeded"], serde_json::json!([0]));
        assert_eq!(record["replayed"]["from"], 1050.0);
        assert_eq!(record["replayed"]["to"], 1100.0);
        assert_eq!(record["replayed"]["count"], 2);

        // очередь вычерпана, агрегаты — накопительные
        let drained: serde_json::Value = serde_json::from_str(&state.take_divergence()).unwrap();

        assert_eq!(drained["records"].as_array().unwrap().len(), 0);
        assert_eq!(drained["samples"], 2);
        assert_eq!(drained["maxDelta"][0], 50.0);
    }

    #[test]
    fn divergence_ring_buffer_evicts_oldest_records() {
        let mut state = ClientState::<TestClient>::new(config_with_divergence(1), &TestConfig {});

        state.set_active(true);
        state.set_model("predicted");
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 90.0, true), 1100.0);

        let dump: serde_json::Value = serde_json::from_str(&state.take_divergence()).unwrap();

        assert_eq!(dump["violations"], 2);
        assert_eq!(dump["dropped"], 1);
        assert_eq!(dump["records"].as_array().unwrap().len(), 1);
        assert_eq!(dump["records"][0]["serverTime"], 1100.0);
    }

    // capacity: 0 — буфер всё равно держит одну запись, значит и вытеснений
    // на две записи ровно одно: иначе отчёт врал бы про «вытеснено N»
    #[test]
    fn divergence_zero_capacity_counts_evictions_honestly() {
        let mut state = ClientState::<TestClient>::new(config_with_divergence(0), &TestConfig {});

        state.set_active(true);
        state.set_model("predicted");
        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 90.0, true), 1100.0);

        let dump: serde_json::Value = serde_json::from_str(&state.take_divergence()).unwrap();

        assert_eq!(dump["violations"], 2);
        assert_eq!(dump["dropped"], 1);
        assert_eq!(dump["records"].as_array().unwrap().len(), 1);
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

    #[test]
    fn reset_clears_my_game_id() {
        let mut state = make_state();

        state.push_frame(&frame_bytes(1000.0, 1, 10.0, true), 1000.0);
        state.push_frame(&frame_bytes(1100.0, 2, 20.0, true), 1100.0);
        state.sample(1150.0);
        assert_eq!(state.my_game_id(), Some(2));

        // CLEAR означает «мира больше нет»: без сброса идентичности предикт
        // продолжил бы рисовать сущность, которой на хосте уже нет
        state.reset();
        assert_eq!(state.my_game_id(), None);
    }
}
