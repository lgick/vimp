//! Детектор рассинхрона предикта (`plan/done/ai-debug/stage_5.md`): сравнение
//! предсказанного состояния своего актора с авторитетным player-блоком
//! кадра — покомпонентно, с порогами из конфига.
//!
//! Существенно: предиктор игры реконсилится **по времени**, а не по `seq`
//! (история ввода переигрывается от момента авторитетного состояния), поэтому
//! запись несёт `serverTime`/`offset`/`localNow` и окно переигранной истории
//! ввода, а `inputSeq` — только справочно, как подтверждённый хостом номер.
//! Сравнение «по тому же seq» здесь ввело бы в заблуждение.
//!
//! Уровень 0 (`Source::Camera`) не требует от плагина ничего: сравнивается
//! камера predicted-оверлея с x/y авторитетного состояния. Уровень 1
//! (`Source::State`) — если игра реализовала `GameClientDef::predicted_state`.

use std::collections::VecDeque;

use serde_json::{Value, json};

use crate::config::{DivergenceConfig, PLAYER_STATE_LEN};

/// Откуда взято предсказанное состояние.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Камера predicted-оверлея (x/y) — уровень 0.
    Camera,
    /// `GameClientDef::predicted_state` — уровень 1.
    State,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Camera => "camera",
            Source::State => "state",
        }
    }
}

/// Одно сравнение: момент прихода кадра со своим player-блоком.
pub struct Observation<'a> {
    pub source: Source,
    /// Предсказанное состояние (2 компонента для `Camera`, `PLAYER_STATE_LEN`
    /// для `State`) — снимается ДО `on_server_state`.
    pub predicted: &'a [f32],
    pub authoritative: &'a [f32; PLAYER_STATE_LEN],
    pub server_time: f64,
    pub local_now: f64,
    pub offset: f64,
    pub input_seq: u32,
    /// Окно локального времени истории ввода, переигранное последним
    /// реконсилем: (начало, конец, число вводов).
    pub replayed: Option<(f64, f64, usize)>,
}

pub struct DivergenceTracker {
    cfg: DivergenceConfig,
    records: VecDeque<Value>,
    samples: u64,
    violations: u64,
    dropped: u64,
    max_delta: [f32; PLAYER_STATE_LEN],
}

impl DivergenceTracker {
    pub fn new(mut cfg: DivergenceConfig) -> Self {
        // capacity: 0 держал бы буфер пустым, но считал вытеснение на каждой
        // записи — отчёт сообщал бы «вытеснено N» при N-1 вытеснениях
        cfg.capacity = cfg.capacity.max(1);

        Self {
            cfg,
            records: VecDeque::new(),
            samples: 0,
            violations: 0,
            dropped: 0,
            max_delta: [0.0; PLAYER_STATE_LEN],
        }
    }

    /// Сравнивает предсказанное с авторитетным; запись кладётся в кольцевой
    /// буфер, только если хотя бы один компонент вышел за свой порог —
    /// иначе отчёт утонул бы в шуме здоровых кадров.
    pub fn observe(&mut self, obs: Observation) {
        self.samples += 1;

        let width = obs.predicted.len().min(PLAYER_STATE_LEN);
        let mut deltas = Vec::with_capacity(width);
        let mut exceeded = Vec::new();

        for index in 0..width {
            let mut delta = obs.predicted[index] - obs.authoritative[index];

            // уровень 0 (камера) несёт только x/y — углов там нет
            if obs.source == Source::State && self.cfg.is_angle(index) {
                delta = wrap_angle(delta);
            }

            deltas.push(delta);

            if delta.abs() > self.max_delta[index] {
                self.max_delta[index] = delta.abs();
            }

            if delta.abs() > self.cfg.threshold(index) {
                exceeded.push(index);
            }
        }

        if exceeded.is_empty() {
            return;
        }

        self.violations += 1;

        if self.records.len() >= self.cfg.capacity {
            self.records.pop_front();
            self.dropped += 1;
        }

        let thresholds: Vec<Value> = (0..width)
            .map(|index| json!(round4(self.cfg.threshold(index))))
            .collect();

        self.records.push_back(json!({
            "source": obs.source.as_str(),
            "serverTime": obs.server_time,
            "localNow": obs.local_now,
            "offset": obs.offset,
            "inputSeq": obs.input_seq,
            "replayed": obs.replayed.map(|(from, to, count)| json!({
                "from": from,
                "to": to,
                "count": count,
            })),
            "predicted": floats(&obs.predicted[..width]),
            "authoritative": floats(&obs.authoritative[..width]),
            "delta": floats(&deltas),
            "exceeded": exceeded,
            "thresholds": thresholds,
        }));
    }

    /// Вычерпывает записи; агрегаты (`samples`/`violations`/`dropped`/
    /// `maxDelta`) — накопительные за весь прогон, они и есть ответ на «дрейф
    /// был вообще?» после того, как записи уже прочитаны.
    pub fn take_json(&mut self) -> String {
        let records: Vec<Value> = self.records.drain(..).collect();

        json!({
            "samples": self.samples,
            "violations": self.violations,
            "dropped": self.dropped,
            "maxDelta": floats(&self.max_delta),
            "records": records,
        })
        .to_string()
    }
}

// разность углов → (−π, π]: 3.1412 − (−3.1416) — это 0.0004, а не 2π
fn wrap_angle(delta: f32) -> f32 {
    use std::f32::consts::{PI, TAU};

    let wrapped = delta.rem_euclid(TAU);

    if wrapped > PI { wrapped - TAU } else { wrapped }
}

fn floats(values: &[f32]) -> Vec<Value> {
    values.iter().map(|v| json!(round4(*v))).collect()
}

// f32 → JSON без хвоста двоичного представления (10.100000381469727)
fn round4(value: f32) -> f64 {
    ((value as f64) * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker(divergence: Value) -> DivergenceTracker {
        DivergenceTracker::new(serde_json::from_value(divergence).unwrap())
    }

    // угол у разреза ±π: 3.1412 и −3.1416 — одно направление с разницей
    // 0.0004 рад, а наивная разность дала бы ≈ 2π
    fn observe_across_pi(tracker: &mut DivergenceTracker) {
        let mut predicted = [0.0; PLAYER_STATE_LEN];
        let mut authoritative = [0.0; PLAYER_STATE_LEN];

        predicted[2] = 3.1412;
        authoritative[2] = -3.1416;

        tracker.observe(Observation {
            source: Source::State,
            predicted: &predicted,
            authoritative: &authoritative,
            server_time: 1000.0,
            local_now: 1000.0,
            offset: 0.0,
            input_seq: 1,
            replayed: None,
        });
    }

    fn report(tracker: &mut DivergenceTracker) -> Value {
        serde_json::from_str(&tracker.take_json()).unwrap()
    }

    #[test]
    fn angle_component_is_compared_on_the_circle() {
        let mut tracker = tracker(json!({ "thresholds": [3, 3, 0.06], "angles": [2] }));

        observe_across_pi(&mut tracker);

        let report = report(&mut tracker);
        let max = report["maxDelta"][2].as_f64().unwrap();

        assert_eq!(report["violations"], 0);
        assert!((max - 0.0004).abs() < 1e-4, "maxDelta[2] = {max}");
    }

    #[test]
    fn without_angles_the_component_stays_linear() {
        let mut tracker = tracker(json!({ "thresholds": [3, 3, 0.06] }));

        observe_across_pi(&mut tracker);

        let report = report(&mut tracker);

        assert_eq!(report["violations"], 1);
        assert_eq!(report["records"][0]["exceeded"], json!([2]));
    }

    #[test]
    fn angle_index_out_of_the_player_block_is_ignored() {
        let mut tracker = tracker(json!({ "thresholds": [3, 3, 0.06], "angles": [99] }));

        observe_across_pi(&mut tracker);

        assert_eq!(report(&mut tracker)["violations"], 1);
    }
}
