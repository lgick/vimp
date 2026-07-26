use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Стандартный словарь событий ядра (Wasm Host ABI) — «топливо» движковой
/// меты (Panel, RoundManager/Stat, звук/тряска камеры). Сериализуются в JSON
/// при take_events(). Словарь фиксирован движком; игровой смысл (какое поле
/// панели, что означает custom-событие) задаёт конфиг/HostPlugin, не ядро.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CoreEvent {
    /// Новое значение поля панели (Panel.updateUser); `field` — ключ схемы
    /// панели игры (`"health"`, имя оружия и т.п.).
    #[serde(rename_all = "camelCase")]
    PanelSet { id: u32, field: String, value: f64 },

    /// Смена активного поля панели (Panel.setActiveWeapon, ключ `activeKey`).
    #[serde(rename_all = "camelCase")]
    PanelActive { id: u32, field: String },

    /// Уничтожение участника (RoundManager.reportKill / Stat).
    #[serde(rename_all = "camelCase")]
    Death { victim: u32, killer: u32 },

    /// Тряска камеры у конкретного игрока (per-user мета кадра).
    #[serde(rename_all = "camelCase")]
    Shake { id: u32, intensity: f64, duration: f64 },

    /// Игровое событие вне стандартного словаря — маршрутизируется движком
    /// в `HostPlugin.onCoreEvent`, не интерпретируется ядром/движком.
    #[serde(rename_all = "camelCase")]
    Custom { data: Value },
}
