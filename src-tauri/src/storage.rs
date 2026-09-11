use crate::models::{UserSettings, WatchHistoryItem};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "
                PRAGMA journal_mode = WAL;
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS watch_history (
                    series_id TEXT PRIMARY KEY NOT NULL,
                    episode_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    series_cover TEXT NOT NULL,
                    episode_number INTEGER NOT NULL,
                    total_episodes INTEGER NOT NULL,
                    position_seconds REAL NOT NULL,
                    duration_seconds REAL NOT NULL,
                    progress_percent INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    is_finished INTEGER NOT NULL,
                    channel TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_watch_history_updated_at
                    ON watch_history(updated_at DESC);
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                ",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn list_history(&self) -> Result<Vec<WatchHistoryItem>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史数据库锁不可用。".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT series_id, episode_id, title, series_cover, episode_number, total_episodes,
                        position_seconds, duration_seconds, progress_percent, updated_at, is_finished, channel
                 FROM watch_history ORDER BY updated_at DESC LIMIT 80",
            )
            .map_err(|error| error.to_string())?;
        let records = statement
            .query_map([], |row| {
                Ok(WatchHistoryItem {
                    series_id: row.get(0)?,
                    episode_id: row.get(1)?,
                    title: row.get(2)?,
                    series_cover: row.get(3)?,
                    episode_number: row.get(4)?,
                    total_episodes: row.get(5)?,
                    position_seconds: row.get(6)?,
                    duration_seconds: row.get(7)?,
                    progress_percent: row.get(8)?,
                    updated_at: row.get(9)?,
                    is_finished: row.get::<_, i64>(10)? != 0,
                    channel: row.get(11)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(records)
    }

    pub fn save_history(&self, item: &WatchHistoryItem) -> Result<(), String> {
        if item.series_id.trim().is_empty() || item.episode_id.trim().is_empty() {
            return Err("历史记录缺少剧集或集数标识。".into());
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史数据库锁不可用。".to_string())?;
        connection
            .execute(
                "INSERT INTO watch_history (
                    series_id, episode_id, title, series_cover, episode_number, total_episodes,
                    position_seconds, duration_seconds, progress_percent, updated_at, is_finished, channel
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(series_id) DO UPDATE SET
                    episode_id = excluded.episode_id,
                    title = excluded.title,
                    series_cover = excluded.series_cover,
                    episode_number = excluded.episode_number,
                    total_episodes = excluded.total_episodes,
                    position_seconds = excluded.position_seconds,
                    duration_seconds = excluded.duration_seconds,
                    progress_percent = excluded.progress_percent,
                    updated_at = excluded.updated_at,
                    is_finished = excluded.is_finished,
                    channel = excluded.channel",
                params![
                    item.series_id,
                    item.episode_id,
                    item.title,
                    item.series_cover,
                    item.episode_number,
                    item.total_episodes,
                    item.position_seconds.max(0.0),
                    item.duration_seconds.max(0.0),
                    item.progress_percent.min(100),
                    item.updated_at,
                    item.is_finished as i32,
                    item.channel,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn remove_history(&self, series_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史数据库锁不可用。".to_string())?;
        connection
            .execute(
                "DELETE FROM watch_history WHERE series_id = ?1",
                params![series_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn clear_history(&self) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "历史数据库锁不可用。".to_string())?;
        connection
            .execute("DELETE FROM watch_history", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn settings_get(&self) -> Result<UserSettings, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "设置数据库锁不可用。".to_string())?;
        let raw: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'user_settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        match raw {
            Some(value) => serde_json::from_str(&value).map_err(|_| "保存的设置格式无效。".into()),
            None => Ok(UserSettings::default()),
        }
    }

    pub fn settings_save(&self, settings: &UserSettings) -> Result<(), String> {
        let value = serde_json::to_string(settings).map_err(|error| error.to_string())?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "设置数据库锁不可用。".to_string())?;
        connection
            .execute(
                "INSERT INTO settings(key, value) VALUES ('user_settings', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![value],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
