use crate::config::{
    BlockKind, BlockSchema, FieldType, FieldValue, PLAYER_STATE_LEN, SnapshotConfig,
};

// Бинарный пакер snapshot-кадра: порт SnapshotPacker из
// src/lib/snapshotCodec.js. Раскладка (v3) идентична байт-в-байт —
// клиент распаковывает существующим unpackFrame. Big-endian.

const CAMERA_FLAG_HAS_CAMERA: u8 = 1;
const CAMERA_FLAG_FORCE_RESET: u8 = 2;
const CAMERA_FLAG_HAS_SHAKE: u8 = 4;
const CAMERA_FLAG_HAS_PLAYER: u8 = 8;

/// Типизированные блоки тела снапшота — форма (см. `BlockKind`), не
/// игровая сущность; движок не знает, что строка блока значит «танк» или
/// «бомба», только как её упаковать. Раскладка полей внутри строки — по
/// `schema.fields`, позиционно.
pub enum Block {
    /// (id, поля строки | None = удаление с полотна)
    Indexed8(Vec<(u8, Option<Vec<FieldValue>>)>),
    /// (id, поля строки | None = удаление с полотна)
    Indexed32(Vec<(u32, Option<Vec<FieldValue>>)>),
    /// поля строки, без id
    List16(Vec<Vec<FieldValue>>),
    /// (индекс, поля строки)
    IndexedNoNull8(Vec<(u8, Vec<FieldValue>)>),
}

impl Block {
    fn kind(&self) -> BlockKind {
        match self {
            Block::Indexed8(_) => BlockKind::Indexed8,
            Block::Indexed32(_) => BlockKind::Indexed32,
            Block::List16(_) => BlockKind::List16,
            Block::IndexedNoNull8(_) => BlockKind::IndexedNoNull8,
        }
    }
}

/// Камера per-user кадра: [x, y, forceReset?, shake?] из JS-версии.
pub struct CameraData {
    pub x: f32,
    pub y: f32,
    pub force_reset: bool,
    pub shake: Option<String>,
}

/// Player-блок предикшена играющего.
pub struct PlayerBlock {
    pub game_id: u8,
    pub input_seq: u32,
    pub state: [f32; PLAYER_STATE_LEN],
    pub centering: bool,
}

pub struct SnapshotPacker {
    cfg: SnapshotConfig,
    body: Vec<u8>,
    frame: Vec<u8>,
}

fn push_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_be_bytes());
}

fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

fn push_f32(buf: &mut Vec<u8>, v: f32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

fn push_f64(buf: &mut Vec<u8>, v: f64) {
    buf.extend_from_slice(&v.to_be_bytes());
}

/// Пишет одно поле строки по типу схемы (интерпретатор `FieldSchema`).
/// Ветка `_` недостижима, пока `SnapshotConfig::validate()` вызывается на
/// границе конструирования (`GameCore::new`/`ClientCore::new`) — паникуем
/// явно вместо тихого no-op, чтобы регресс защиты проявился сразу, а не
/// усечённым кадром в release-WASM.
fn write_field(buf: &mut Vec<u8>, ty: FieldType, value: FieldValue) {
    match (ty, value) {
        (FieldType::F32, FieldValue::F32(v)) => push_f32(buf, v),
        (FieldType::U8, FieldValue::U8(v)) => buf.push(v),
        (FieldType::U16, FieldValue::U16(v)) => push_u16(buf, v),
        (FieldType::U32, FieldValue::U32(v)) => push_u32(buf, v),
        _ => unreachable!(
            "[core snapshot] тип поля не совпадает со схемой — validate() должен был это отловить"
        ),
    }
}

impl SnapshotPacker {
    pub fn new(cfg: SnapshotConfig) -> Self {
        Self {
            cfg,
            body: Vec::with_capacity(4096),
            frame: Vec::with_capacity(4096),
        }
    }

    /// Пакует блоки сущностей (broadcast-часть, один раз за отправку).
    /// Незарегистрированный ключ — ошибка (зеркало проверки packBody).
    pub fn pack_body(&mut self, blocks: &[(String, Block)]) -> Result<(), String> {
        self.body.clear();

        for (key, block) in blocks {
            let schema = self.cfg.keys.get(key).ok_or_else(|| {
                format!(
                    "[core snapshot] Неизвестный ключ снапшота '{key}': \
                     зарегистрируйте его в src/config/opcodes.js"
                )
            })?;

            if schema.kind != block.kind() {
                return Err(format!(
                    "[core snapshot] Раскладка блока '{key}' не совпадает с kind из opcodes.js"
                ));
            }

            self.body.push(schema.id);
            Self::write_block(&mut self.body, schema, block);
        }

        Ok(())
    }

    /// Интерпретатор схемы: форма блока (ширина count/id, null-маркер)
    /// зависит от `kind` (см. `BlockKind`), раскладка полей строки —
    /// от `schema.fields` (см. `FieldSchema`).
    fn write_block(buf: &mut Vec<u8>, schema: &BlockSchema, block: &Block) {
        fn write_row(buf: &mut Vec<u8>, schema: &BlockSchema, fields: &[FieldValue]) {
            for (i, field) in schema.fields.iter().enumerate() {
                write_field(buf, field.ty, fields[i]);
            }
        }

        match block {
            Block::Indexed8(items) => {
                buf.push(items.len() as u8);

                for (id, row) in items {
                    buf.push(*id);

                    match row {
                        None => buf.push(0),
                        Some(fields) => {
                            buf.push(1);
                            write_row(buf, schema, fields);
                        }
                    }
                }
            }
            Block::Indexed32(items) => {
                push_u16(buf, items.len() as u16);

                for (id, row) in items {
                    push_u32(buf, *id);

                    match row {
                        None => buf.push(0),
                        Some(fields) => {
                            buf.push(1);
                            write_row(buf, schema, fields);
                        }
                    }
                }
            }
            Block::List16(items) => {
                push_u16(buf, items.len() as u16);

                for fields in items {
                    write_row(buf, schema, fields);
                }
            }
            Block::IndexedNoNull8(items) => {
                buf.push(items.len() as u8);

                for (index, fields) in items {
                    buf.push(*index);
                    write_row(buf, schema, fields);
                }
            }
        }
    }

    /// Собирает кадр пользователя: заголовок + копия тела. Возвращает срез
    /// внутреннего буфера — JS читает его zero-copy из памяти WASM.
    pub fn pack_frame(
        &mut self,
        server_time: f64,
        seq: u32,
        camera: Option<&CameraData>,
        player: Option<&PlayerBlock>,
    ) -> &[u8] {
        let frame = &mut self.frame;

        frame.clear();
        frame.push(self.cfg.port);
        frame.push(self.cfg.version);
        push_u32(frame, seq);
        push_f64(frame, server_time);

        let mut flags = 0u8;
        let shake = camera.and_then(|camera| camera.shake.as_deref());

        if let Some(camera) = camera {
            flags |= CAMERA_FLAG_HAS_CAMERA;

            if camera.force_reset {
                flags |= CAMERA_FLAG_FORCE_RESET;
            }

            if shake.is_some() {
                flags |= CAMERA_FLAG_HAS_SHAKE;
            }
        }

        if player.is_some() {
            flags |= CAMERA_FLAG_HAS_PLAYER;
        }

        frame.push(flags);

        if let Some(camera) = camera {
            push_f32(frame, camera.x);
            push_f32(frame, camera.y);
        }

        if let Some(shake) = shake {
            frame.push(shake.len() as u8);
            frame.extend_from_slice(shake.as_bytes());
        }

        if let Some(player) = player {
            frame.push(player.game_id);
            push_u32(frame, player.input_seq);

            for value in player.state {
                push_f32(frame, value);
            }

            frame.push(player.centering as u8);
        }

        frame.extend_from_slice(&self.body);

        frame
    }

    pub fn frame_bytes(&self) -> &[u8] {
        &self.frame
    }

    pub fn body_len(&self) -> usize {
        self.body.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_support::{tanks_schema, tracers_schema};
    use indexmap::IndexMap;

    fn test_config() -> SnapshotConfig {
        let mut keys = IndexMap::new();

        keys.insert("m1".to_string(), tanks_schema(1));
        keys.insert("w1".to_string(), tracers_schema(2));

        SnapshotConfig {
            version: 3,
            port: 5,
            keys,
        }
    }

    #[test]
    fn frame_header_layout() {
        let mut packer = SnapshotPacker::new(test_config());

        packer.pack_body(&[]).unwrap();

        let frame = packer.pack_frame(
            1234.5,
            42,
            Some(&CameraData {
                x: 10.5,
                y: -3.25,
                force_reset: true,
                shake: Some("20:200".to_string()),
            }),
            None,
        );

        assert_eq!(frame[0], 5); // port
        assert_eq!(frame[1], 3); // версия
        assert_eq!(u32::from_be_bytes(frame[2..6].try_into().unwrap()), 42);
        assert_eq!(
            f64::from_be_bytes(frame[6..14].try_into().unwrap()),
            1234.5
        );
        // hasCamera | forceReset | hasShake
        assert_eq!(frame[14], 1 | 2 | 4);
        assert_eq!(f32::from_be_bytes(frame[15..19].try_into().unwrap()), 10.5);
        assert_eq!(frame[23], 6); // длина строки shake
        assert_eq!(&frame[24..30], b"20:200");
    }

    #[test]
    fn unknown_key_is_error() {
        let mut packer = SnapshotPacker::new(test_config());
        let result = packer.pack_body(&[("zzz".to_string(), Block::List16(vec![]))]);

        assert!(result.is_err());
    }

    #[test]
    fn tank_block_layout() {
        let mut packer = SnapshotPacker::new(test_config());

        packer
            .pack_body(&[(
                "m1".to_string(),
                Block::Indexed8(vec![
                    (
                        7,
                        Some(vec![
                            FieldValue::F32(1.0),
                            FieldValue::F32(2.0),
                            FieldValue::F32(3.0),
                            FieldValue::F32(4.0),
                            FieldValue::F32(5.0),
                            FieldValue::F32(6.0),
                            FieldValue::F32(7.0),
                            FieldValue::U8(3),
                            FieldValue::U8(2),
                            FieldValue::U8(1),
                        ]),
                    ),
                    (9, None),
                ]),
            )])
            .unwrap();

        let frame = packer.pack_frame(0.0, 0, None, None).to_vec();
        let body = &frame[15..]; // заголовок без камеры/игрока: 15 байт

        assert_eq!(body[0], 1); // id ключа m1
        assert_eq!(body[1], 2); // количество танков
        assert_eq!(body[2], 7); // gameId
        assert_eq!(body[3], 1); // hasData
        // 7 float + condition/size/team
        assert_eq!(body[4 + 28], 3);
        assert_eq!(body[4 + 29], 2);
        assert_eq!(body[4 + 30], 1);
        assert_eq!(body[4 + 31], 9); // второй танк
        assert_eq!(body[4 + 32], 0); // null-маркер
    }
}
