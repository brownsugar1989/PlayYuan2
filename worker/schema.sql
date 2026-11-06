CREATE TABLE IF NOT EXISTS games (
  play_id TEXT PRIMARY KEY,
  manage_hash TEXT NOT NULL UNIQUE,  -- 只存管理金鑰的雜湊，不存金鑰本身
  title TEXT,
  email TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  play_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- o = 一般物件，b = 炸彈
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_play ON photos(play_id);
CREATE INDEX IF NOT EXISTS games_exp ON games(expires_at);
