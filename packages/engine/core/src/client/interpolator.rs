//! Snapshot-интерполяция — порт src/client/SnapshotInterpolator.js
//! (срез 2.6). Кадры складываются в буфер по seq с дедупликацией, мир
//! рендерится в прошлом (renderTime = serverNow − delay); события
//! опоздавших кадров выдаются немедленно следующим sample().

use std::collections::HashSet;

use indexmap::IndexMap;

use crate::config::{BlockClass, FieldValue, Interp, InterpolationConfig, SnapshotConfig};
use crate::physics::{lerp, lerp_angle};

use super::unpack::{BlockData, DecodedCamera, DecodedSnapshot};

// коэффициент EMA-сглаживания оффсета серверного времени
const OFFSET_SMOOTHING: f64 = 0.1;

// окно памяти выданных seq для дедупликации (кадров; ~4 c при 30 пакетах/сек)
const SEQ_DEDUP_WINDOW: u32 = 128;

// жёсткий cap буфера — страховка памяти WASM (в JS-версии не требовался:
// maxFrameAge чистил буфер при живом потоке кадров)
const MAX_BUFFER_FRAMES: usize = 256;

/// Содержимое кадра для выдачи: снапшот + камера.
#[derive(Clone)]
pub struct FrameData {
    pub snapshot: DecodedSnapshot,
    pub camera: Option<DecodedCamera>,
}

struct BufferedFrame {
    seq: u32,
    server_time: f64,
    data: FrameData,
    issued: bool,
}

/// Интерполированная строка блока: id/индекс строки + поля в порядке
/// `schema.fields`, каждое интерполировано по своему `Interp`
/// (Discrete-поля — значение кадра A, как раньше condition/size/team).
pub struct InterpolatedRow {
    pub id: u32,
    pub fields: Vec<FieldValue>,
}

/// Непрерывная часть sample(): строки Hot-блоков по ключу реестра
/// (`opcodes.js`/игровой плагин) — движок не знает, что ключ значит «танк»
/// или «динамика карты», только форму (`Indexed8`/`IndexedNoNull8`, у
/// которых есть устойчивая id-идентичность строки между кадрами A/B).
#[derive(Default)]
pub struct InterpolatedGame {
    pub blocks: IndexMap<String, Vec<InterpolatedRow>>,
}

/// Результат sample().
pub struct SampleResult {
    /// Невыданные кадры, пересечённые renderTime (события — ровно один раз).
    pub frames: Vec<FrameData>,
    pub game: Option<InterpolatedGame>,
    /// Интерполированные координаты камеры (без флагов reset/shake).
    pub camera: Option<[f32; 2]>,
}

pub struct Interpolator {
    delay: f64,
    max_frame_age: f64,
    snapshot_cfg: SnapshotConfig,
    frames: Vec<BufferedFrame>,
    offset_ema: Option<f64>,
    last_render_time: Option<f64>,
    pending_late: Vec<FrameData>,
    issued_seqs: HashSet<u32>,
}

impl Interpolator {
    pub fn new(cfg: &InterpolationConfig, snapshot_cfg: SnapshotConfig) -> Self {
        Self {
            delay: cfg.delay,
            max_frame_age: cfg.max_frame_age,
            snapshot_cfg,
            frames: Vec::new(),
            offset_ema: None,
            last_render_time: None,
            pending_late: Vec::new(),
            issued_seqs: HashSet::new(),
        }
    }

    /// Текущая оценка (serverTime − localNow); None, если кадров ещё не было.
    pub fn offset(&self) -> Option<f64> {
        self.offset_ema
    }

    /// Добавляет кадр в буфер (вставка по seq с дедупликацией).
    pub fn push(&mut self, data: FrameData, server_time: f64, local_now: f64, seq: u32) {
        if self.issued_seqs.contains(&seq) {
            return;
        }

        // позиция вставки по seq (кадры почти всегда приходят по порядку —
        // поиск с конца); заодно дедупликация по буферу
        let mut index = self.frames.len();

        while index > 0 && self.frames[index - 1].seq >= seq {
            if self.frames[index - 1].seq == seq {
                return;
            }

            index -= 1;
        }

        let offset = server_time - local_now;

        match &mut self.offset_ema {
            None => self.offset_ema = Some(offset),
            Some(ema) => *ema += (offset - *ema) * OFFSET_SMOOTHING,
        }

        // кадр опоздал (renderTime уже прошёл его serverTime): в буфере он
        // сдвинул бы опорный кадр назад — события выдаются немедленно
        if let Some(last) = self.last_render_time
            && server_time <= last
        {
            self.issued_seqs.insert(seq);
            self.pending_late.push(data);

            return;
        }

        self.frames.insert(
            index,
            BufferedFrame {
                seq,
                server_time,
                data,
                issued: false,
            },
        );

        // страховочная очистка слишком старых кадров
        let newest_time = self.frames[self.frames.len() - 1].server_time;
        let min_time = newest_time - self.max_frame_age;

        while self.frames.len() > 2 && self.frames[0].server_time < min_time {
            self.frames.remove(0);
        }

        while self.frames.len() > MAX_BUFFER_FRAMES {
            self.frames.remove(0);
        }
    }

    /// Выборка состояния мира на момент рендера.
    pub fn sample(&mut self, local_now: f64) -> SampleResult {
        // опоздавшие кадры выдаются немедленно, даже если буфер пуст
        let mut frames = std::mem::take(&mut self.pending_late);

        let Some(offset) = self.offset_ema else {
            return SampleResult {
                frames,
                game: None,
                camera: None,
            };
        };

        if self.frames.is_empty() {
            return SampleResult {
                frames,
                game: None,
                camera: None,
            };
        }

        let render_time = local_now + offset - self.delay;

        self.last_render_time = Some(render_time);

        // индекс кадра A: последний с serverTime <= renderTime
        let mut index_a: isize = -1;

        for (i, frame) in self.frames.iter().enumerate() {
            if frame.server_time <= render_time {
                index_a = i as isize;
            } else {
                break;
            }
        }

        // renderTime раньше первого кадра — мир ещё «не начался»
        if index_a == -1 {
            return SampleResult {
                frames,
                game: None,
                camera: None,
            };
        }

        let index_a = index_a as usize;

        // кадры до A больше не нужны (A остаётся опорным);
        // невыданные — в выдачу (события — ровно один раз)
        for frame in self.frames.drain(0..index_a) {
            if !frame.issued {
                self.issued_seqs.insert(frame.seq);
                frames.push(frame.data);
            }
        }

        if !self.frames[0].issued {
            self.frames[0].issued = true;
            self.issued_seqs.insert(self.frames[0].seq);
            frames.push(self.frames[0].data.clone());
        }

        self.prune_issued_seqs();

        let frame_a = &self.frames[0];

        // нет следующего кадра — hold на A без экстраполяции
        let Some(frame_b) = self.frames.get(1) else {
            let game = interpolate_game(
                &frame_a.data.snapshot,
                &frame_a.data.snapshot,
                0.0,
                &self.snapshot_cfg,
            );
            let camera = strip_camera(frame_a.data.camera.as_ref());

            return SampleResult {
                frames,
                game: Some(game),
                camera,
            };
        };

        let alpha = ((render_time - frame_a.server_time)
            / (frame_b.server_time - frame_a.server_time))
            .clamp(0.0, 1.0) as f32;

        let game = interpolate_game(
            &frame_a.data.snapshot,
            &frame_b.data.snapshot,
            alpha,
            &self.snapshot_cfg,
        );
        let camera = interpolate_camera(
            frame_a.data.camera.as_ref(),
            frame_b.data.camera.as_ref(),
            alpha,
        );

        SampleResult {
            frames,
            game: Some(game),
            camera,
        }
    }

    /// Сбрасывает буфер и оценку времени (смена карты, очистка полотна).
    pub fn reset(&mut self) {
        self.frames.clear();
        self.offset_ema = None;
        self.last_render_time = None;
        self.pending_late.clear();
        self.issued_seqs.clear();
    }

    // выкидывает из памяти дедупликации seq далеко позади опорного кадра
    fn prune_issued_seqs(&mut self) {
        let min_seq = self.frames[0].seq.saturating_sub(SEQ_DEDUP_WINDOW);

        self.issued_seqs.retain(|seq| *seq >= min_seq);
    }
}

// интерполирует одно значение поля по способу интерполяции схемы;
// Discrete — без интерполяции, значение кадра A (как раньше condition/
// size/team); Lerp/LerpAngle применимы только к F32-полям — не-F32 поле с
// таким interp в схеме молча падает на Discrete (защита — на стороне
// SnapshotConfig::validate/интеграционных тестов схемы, не рантайма).
fn interp_field(interp: Interp, a: FieldValue, b: FieldValue, alpha: f32) -> FieldValue {
    match (interp, a, b) {
        (Interp::Lerp, FieldValue::F32(a), FieldValue::F32(b)) => FieldValue::F32(lerp(a, b, alpha)),
        (Interp::LerpAngle, FieldValue::F32(a), FieldValue::F32(b)) => {
            FieldValue::F32(lerp_angle(a, b, alpha))
        }
        _ => a,
    }
}

// интерполирует строку блока по позиционной схеме `schema.fields`.
fn interpolate_row(
    schema_fields: &[crate::config::FieldSchema],
    fields_a: &[FieldValue],
    fields_b: &[FieldValue],
    alpha: f32,
) -> Vec<FieldValue> {
    fields_a
        .iter()
        .zip(fields_b)
        .enumerate()
        .map(|(i, (a, b))| {
            let interp = schema_fields.get(i).map_or(Interp::Discrete, |f| f.interp);

            interp_field(interp, *a, *b, alpha)
        })
        .collect()
}

// интерполирует непрерывную часть снапшота; блок участвует, только если
// присутствует в обоих кадрах, его класс — Hot (событийные блоки —
// трассеры/бомбы/взрывы — не интерполируются, выдаются кадром как есть
// через take_frames), и его форма — `Indexed8`/`IndexedNoNull8` (у них
// есть устойчивая id-идентичность строки между кадрами A/B; `Indexed32`/
// `List16` сегодня используются только для событийных блоков).
fn interpolate_game(
    a: &DecodedSnapshot,
    b: &DecodedSnapshot,
    alpha: f32,
    cfg: &SnapshotConfig,
) -> InterpolatedGame {
    let mut game = InterpolatedGame::default();

    for block in &a.blocks {
        let Some(block_b) = b.block_by_key(&block.key) else {
            continue;
        };

        let Some(schema) = cfg.keys.get(&block.key) else {
            continue;
        };

        if schema.class != BlockClass::Hot {
            continue;
        }

        let rows: Vec<InterpolatedRow> = match (&block.data, block_b) {
            (BlockData::Indexed8(items_a), BlockData::Indexed8(items_b)) => items_a
                .iter()
                .filter_map(|(id, row_a)| {
                    let (Some(row_a), Some(Some(row_b))) = (row_a, items_b.get(id)) else {
                        return None;
                    };

                    Some(InterpolatedRow {
                        id: *id as u32,
                        fields: interpolate_row(&schema.fields, row_a, row_b, alpha),
                    })
                })
                .collect(),
            (BlockData::IndexedNoNull8(items_a), BlockData::IndexedNoNull8(items_b)) => items_a
                .iter()
                .filter_map(|(index, fields_a)| {
                    let fields_b = items_b.get(index)?;

                    Some(InterpolatedRow {
                        id: *index as u32,
                        fields: interpolate_row(&schema.fields, fields_a, fields_b, alpha),
                    })
                })
                .collect(),
            // Indexed32/List16 — событийные формы сегодня, не интерполируются
            _ => continue,
        };

        if !rows.is_empty() {
            game.blocks.insert(block.key.clone(), rows);
        }
    }

    game
}

// камера: lerp x/y; reset/shake не дублируются (уже выданы кадрами)
fn interpolate_camera(
    a: Option<&DecodedCamera>,
    b: Option<&DecodedCamera>,
    alpha: f32,
) -> Option<[f32; 2]> {
    match (a, b) {
        (Some(a), Some(b)) => Some([lerp(a.x, b.x, alpha), lerp(a.y, b.y, alpha)]),
        _ => strip_camera(a),
    }
}

// оставляет от камеры только координаты (без флагов reset/shake)
fn strip_camera(camera: Option<&DecodedCamera>) -> Option<[f32; 2]> {
    camera.map(|camera| [camera.x, camera.y])
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use super::*;
    use crate::config::test_support::full_snapshot_config;

    use super::super::unpack::DecodedBlock;

    const DELAY: f64 = 100.0;

    fn make() -> Interpolator {
        Interpolator::new(
            &InterpolationConfig {
                delay: DELAY,
                max_frame_age: 1000.0,
            },
            full_snapshot_config(3, 5),
        )
    }

    fn tank_row(x: f32, angle: f32) -> Vec<FieldValue> {
        vec![
            FieldValue::F32(x),
            FieldValue::F32(0.0),
            FieldValue::F32(angle),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::F32(0.0),
            FieldValue::U8(3),
            FieldValue::U8(2),
            FieldValue::U8(1),
        ]
    }

    fn tank_frame(entries: &[(u8, Option<Vec<FieldValue>>)]) -> FrameData {
        let mut items = IndexMap::new();

        for (id, row) in entries {
            items.insert(*id, row.clone());
        }

        FrameData {
            snapshot: DecodedSnapshot {
                blocks: vec![DecodedBlock {
                    key: "m1".to_string(),
                    key_id: 1,
                    data: BlockData::Indexed8(items),
                }],
            },
            camera: None,
        }
    }

    // push с оффсетом 0 (serverTime == localNow): renderTime = now − delay
    fn push_zero_offset(i: &mut Interpolator, frame: FrameData, server_time: f64, seq: u32) {
        i.push(frame, server_time, server_time, seq);
    }

    fn tanks(game: &InterpolatedGame) -> &[InterpolatedRow] {
        game.blocks.get("m1").map_or(&[], Vec::as_slice)
    }

    fn f32_at(row: &InterpolatedRow, i: usize) -> f32 {
        match row.fields[i] {
            FieldValue::F32(v) => v,
            _ => panic!("поле {i} не F32"),
        }
    }

    fn u8_at(row: &InterpolatedRow, i: usize) -> u8 {
        match row.fields[i] {
            FieldValue::U8(v) => v,
            _ => panic!("поле {i} не U8"),
        }
    }

    #[test]
    fn empty_buffer_returns_nothing() {
        let mut i = make();
        let result = i.sample(0.0);

        assert!(result.frames.is_empty());
        assert!(result.game.is_none());
        assert!(result.camera.is_none());
    }

    #[test]
    fn render_time_before_first_frame_returns_nothing() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);

        // renderTime = 1000 + 0 − 100 = 900 < 1000
        let result = i.sample(1000.0);

        assert!(result.frames.is_empty());
        assert!(result.game.is_none());
    }

    #[test]
    fn positions_lerp_between_frames() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(100.0, 0.0)))]), 1100.0, 2);

        // renderTime = 1150 − 100 = 1050 → alpha 0.5
        let result = i.sample(1150.0);
        let game = result.game.unwrap();
        let rows = tanks(&game);

        assert_eq!(rows.len(), 1);
        assert_eq!(f32_at(&rows[0], 0), 50.0);
        assert_eq!(rows[0].id, 1);
    }

    #[test]
    fn angles_lerp_shortest_path() {
        use std::f32::consts::PI;

        let mut i = make();

        push_zero_offset(
            &mut i,
            tank_frame(&[(1, Some(tank_row(0.0, PI - 0.1)))]),
            1000.0,
            1,
        );
        push_zero_offset(
            &mut i,
            tank_frame(&[(1, Some(tank_row(0.0, -PI + 0.1)))]),
            1100.0,
            2,
        );

        let result = i.sample(1150.0);
        let game = result.game.unwrap();
        let angle = f32_at(&tanks(&game)[0], 2);

        // кратчайший путь через ±PI, а не через 0
        assert!((angle.abs() - PI).abs() < 0.01);
    }

    #[test]
    fn discrete_fields_come_from_frame_a() {
        let mut i = make();
        let mut row_b = tank_row(100.0, 0.0);

        row_b[7] = FieldValue::U8(1); // condition

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);
        push_zero_offset(&mut i, tank_frame(&[(1, Some(row_b))]), 1100.0, 2);

        let result = i.sample(1150.0);
        let game = result.game.unwrap();

        assert_eq!(u8_at(&tanks(&game)[0], 7), 3);
    }

    #[test]
    fn null_and_missing_tanks_are_not_interpolated() {
        let mut i = make();

        push_zero_offset(
            &mut i,
            tank_frame(&[(1, Some(tank_row(0.0, 0.0))), (2, Some(tank_row(5.0, 0.0)))]),
            1000.0,
            1,
        );
        // танк 1 удалён (null), танк 2 отсутствует
        push_zero_offset(&mut i, tank_frame(&[(1, None)]), 1100.0, 2);

        let result = i.sample(1150.0);

        assert!(tanks(&result.game.unwrap()).is_empty());
    }

    #[test]
    fn frames_are_issued_exactly_once() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(10.0, 0.0)))]), 1100.0, 2);

        assert_eq!(i.sample(1150.0).frames.len(), 1); // кадр A выдан
        assert_eq!(i.sample(1151.0).frames.len(), 0); // повторно не выдаётся
        assert_eq!(i.sample(1250.0).frames.len(), 1); // пересечён кадр B
    }

    #[test]
    fn hold_on_last_frame_without_extrapolation() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(50.0, 0.0)))]), 1000.0, 1);

        let result = i.sample(1500.0);

        // hold: непрерывная часть отдаётся с alpha 0 по кадру A
        let game = result.game.unwrap();
        assert_eq!(f32_at(&tanks(&game)[0], 0), 50.0);
    }

    #[test]
    fn out_of_order_insert_and_duplicates() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(100.0, 0.0)))]), 1200.0, 3);
        // опоздавший в буфер (renderTime ещё не прошёл) — встаёт между
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(50.0, 0.0)))]), 1100.0, 2);
        // дубликат seq — отброшен
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(999.0, 0.0)))]), 1100.0, 2);

        // renderTime = 1150: A = seq 2 (x=50), B = seq 3 (x=100), alpha 0.5
        let result = i.sample(1250.0);

        let game = result.game.unwrap();
        assert_eq!(f32_at(&tanks(&game)[0], 0), 75.0);
        assert_eq!(result.frames.len(), 2); // seq 1 и seq 2 пересечены
    }

    #[test]
    fn late_frame_events_are_issued_immediately() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(20.0, 0.0)))]), 1200.0, 3);
        i.sample(1250.0); // renderTime 1150

        // seq 2 опоздал: его serverTime 1100 позади renderTime
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(10.0, 0.0)))]), 1100.0, 2);

        let result = i.sample(1251.0);

        assert_eq!(result.frames.len(), 1); // выдан немедленно

        // повторный push того же seq игнорируется (память выданных)
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(10.0, 0.0)))]), 1100.0, 2);
        assert!(i.sample(1252.0).frames.is_empty());
    }

    #[test]
    fn camera_lerp_and_strip() {
        let mut i = make();
        let frame = |x: f32| FrameData {
            snapshot: DecodedSnapshot::default(),
            camera: Some(DecodedCamera {
                x,
                y: 0.0,
                force_reset: true,
                shake: None,
            }),
        };

        push_zero_offset(&mut i, frame(0.0), 1000.0, 1);
        push_zero_offset(&mut i, frame(100.0), 1100.0, 2);

        let result = i.sample(1150.0);

        // флаги reset/shake не попадают в интерполированную камеру
        assert_eq!(result.camera, Some([50.0, 0.0]));
    }

    #[test]
    fn offset_ema_smoothing() {
        let mut i = make();

        i.push(tank_frame(&[]), 1000.0, 500.0, 1); // offset 500
        assert_eq!(i.offset(), Some(500.0));

        i.push(tank_frame(&[]), 1100.0, 500.0, 2); // offset 600
        // EMA: 500 + (600 − 500) · 0.1 = 510
        assert_eq!(i.offset(), Some(510.0));
    }

    #[test]
    fn old_frames_are_pruned_by_age() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[]), 1000.0, 1);
        push_zero_offset(&mut i, tank_frame(&[]), 1100.0, 2);
        // кадр старше maxFrameAge (1000 мс) относительно новейшего
        push_zero_offset(&mut i, tank_frame(&[]), 2500.0, 3);

        // кадр seq 1 вычищен без выдачи: sample его уже не увидит
        let result = i.sample(2500.0); // renderTime 2400 → пересечены 2 и...

        // seq 1 (1000.0) удалён pruning'ом, выданы seq 2 и seq 3? renderTime
        // 2400 пересекает 1100 и не пересекает 2500
        assert_eq!(result.frames.len(), 1);
    }

    #[test]
    fn reset_clears_everything() {
        let mut i = make();

        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(0.0, 0.0)))]), 1000.0, 1);
        i.reset();

        assert!(i.offset().is_none());

        let result = i.sample(2000.0);

        assert!(result.frames.is_empty());
        assert!(result.game.is_none());

        // после reset тот же seq принимается заново
        push_zero_offset(&mut i, tank_frame(&[(1, Some(tank_row(5.0, 0.0)))]), 3000.0, 1);
        assert_eq!(i.sample(3200.0).frames.len(), 1);
    }
}
