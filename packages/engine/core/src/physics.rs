/// Метка тела в user_data Rapier (аналог body.userData JS-версии).
/// Кодируется в u128: тип в младшем байте. Движок знает только про статику
/// карты; игровые теги (танк/снаряд) кодируются в игровом crate и обязаны
/// использовать значения младшего байта, отличные от `MAP_OBJECT_TAG`
/// (зарезервированный диапазон движка — только `1`; игра начинает с `2`).
pub const MAP_OBJECT_TAG: u128 = 1;

/// Кодирует тег статики карты.
pub fn encode_map_object() -> u128 {
    MAP_OBJECT_TAG
}

/// Является ли тело статикой карты.
pub fn is_map_object(user_data: u128) -> bool {
    (user_data & 0xff) == MAP_OBJECT_TAG
}

/// Округление до 2 знаков (lib/formatters.js roundTo2Decimals).
pub fn round2(v: f32) -> f32 {
    ((v as f64 * 100.0).round() / 100.0) as f32
}

/// Округление до 1 знака (+value.toFixed(1) в JS-частях).
pub fn round1(v: f32) -> f32 {
    ((v as f64 * 10.0).round() / 10.0) as f32
}

/// Перевод градусов в радианы (lib/math.js degToRad).
pub fn deg_to_rad(degrees: f32) -> f32 {
    degrees * (core::f32::consts::PI / 180.0)
}

/// Линейная интерполяция (lib/math.js lerp).
pub fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Ограничение в диапазоне (lib/math.js clamp).
pub fn clamp(value: f32, min: f32, max: f32) -> f32 {
    value.min(max).max(min)
}

/// Интерполяция угла по кратчайшему пути (lib/math.js lerpAngle).
pub fn lerp_angle(a: f32, b: f32, t: f32) -> f32 {
    let mut diff = b - a;

    while diff > core::f32::consts::PI {
        diff -= core::f32::consts::PI * 2.0;
    }

    while diff < -core::f32::consts::PI {
        diff += core::f32::consts::PI * 2.0;
    }

    a + diff * t
}

/// Нормализация угла к диапазону [-PI, PI] (lib/math.js normalizeAngle).
pub fn normalize_angle(mut angle: f32) -> f32 {
    while angle > core::f32::consts::PI {
        angle -= core::f32::consts::PI * 2.0;
    }

    while angle < -core::f32::consts::PI {
        angle += core::f32::consts::PI * 2.0;
    }

    angle
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_object_roundtrip() {
        assert!(is_map_object(encode_map_object()));
    }

    #[test]
    fn non_map_object_returns_false() {
        assert!(!is_map_object(0));
        assert!(!is_map_object(0xff));
    }

    #[test]
    fn rounding_matches_js() {
        assert_eq!(round2(10.567), 10.57);
        assert_eq!(round2(-3.14159), -3.14);
        assert_eq!(round1(10.567), 10.6);
    }
}
