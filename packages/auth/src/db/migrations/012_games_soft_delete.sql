-- Мягкое удаление игры: запись реестра и все данные по game_id живут ещё
-- config.games.deleteRetentionDays суток, а с раздачи игра снимается сразу.
--
-- Признаком служит отдельная колонка, а не новый статус: статус
-- (pending/approved/rejected/disabled) обязан пережить удаление — иначе
-- восстанавливать будет не во что.
ALTER TABLE games ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- частичный: удалённых игр в реестре единицы, и читает их ровно два
-- потребителя — графа Deleted панели модерации и суточная задача очистки
CREATE INDEX IF NOT EXISTS games_deleted_idx ON games (deleted_at)
  WHERE deleted_at IS NOT NULL;
