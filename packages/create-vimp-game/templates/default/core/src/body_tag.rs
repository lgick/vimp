//! Tag of a Rapier body in `user_data` (u128): the kind lives in the low
//! byte, the payload above it. Low byte `1` is reserved by the engine
//! (`vimp_engine_core::physics::MAP_OBJECT_TAG`) — game kinds start at `2`.

/// Kinds of body this game creates. A projectile weapon would add
/// `Shot { shot_id, owner_id, team_id, weapon }` here with `TAG_SHOT = 3`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyTag {
    Player { game_id: u32, team_id: u8 },
}

const TAG_PLAYER: u128 = 2;

impl BodyTag {
    pub fn encode(self) -> u128 {
        match self {
            BodyTag::Player { game_id, team_id } => {
                TAG_PLAYER | ((game_id as u128) << 8) | ((team_id as u128) << 40)
            }
        }
    }

    pub fn decode(data: u128) -> Option<BodyTag> {
        match data & 0xff {
            TAG_PLAYER => Some(BodyTag::Player {
                game_id: (data >> 8) as u32,
                team_id: (data >> 40) as u8,
            }),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_tag_round_trips() {
        let tag = BodyTag::Player {
            game_id: 250,
            team_id: 2,
        };

        assert_eq!(BodyTag::decode(tag.encode()), Some(tag));
    }

    #[test]
    fn map_object_is_not_a_game_tag() {
        assert_eq!(
            BodyTag::decode(vimp_engine_core::physics::encode_map_object()),
            None
        );
        assert_eq!(BodyTag::decode(0), None);
    }
}
