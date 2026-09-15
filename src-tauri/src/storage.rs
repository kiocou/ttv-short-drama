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
        // 冲突时是否采用本次的播放进度，取决于本次上报的时长是否可信。
        //
        // duration 为 0 意味着上报时视频元数据还没就绪——前端在 metadata 到达
        // 之前也会保存一次（用于先记住"看到第几集"）。旧实现无条件覆盖，
        // 于是这样一次上报就会把之前正确的时长冲成 0，历史页随即显示成
        // "0分0秒 / 0分0秒"，且进度条永远为空。时长不可信时只更新元数据，
        // position / duration / percent 三件套一律保留库里的旧值。
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
                    position_seconds = CASE WHEN excluded.duration_seconds > 0
                        THEN excluded.position_seconds ELSE watch_history.position_seconds END,
                    duration_seconds = CASE WHEN excluded.duration_seconds > 0
                        THEN excluded.duration_seconds ELSE watch_history.duration_seconds END,
                    progress_percent = CASE WHEN excluded.duration_seconds > 0
                        THEN excluded.progress_percent ELSE watch_history.progress_percent END,
                    updated_at = excluded.updated_at,
                    -- is_finished 同样受“时长是否可信”约束：duration=0 时前端算不出
                    -- 百分比，带上来的一定是 false。若无条件覆盖，用户已经看完的一集
                    -- 会因为一次“时长未知”的上报退回未看完，历史页的徽章凭空消失。
                    is_finished = CASE WHEN excluded.duration_seconds > 0
                        THEN excluded.is_finished ELSE watch_history.is_finished END,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::WatchHistoryItem;
    use std::path::PathBuf;

    fn temp_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("ttv-history-test-{}.sqlite3", uuid::Uuid::new_v4()))
    }

    fn item(position: f64, duration: f64, finished: bool) -> WatchHistoryItem {
        WatchHistoryItem {
            series_id: "s1".into(),
            episode_id: "e1".into(),
            title: "测试剧".into(),
            series_cover: String::new(),
            episode_number: 1,
            total_episodes: 10,
            position_seconds: position,
            duration_seconds: duration,
            progress_percent: if duration > 0.0 {
                ((position / duration) * 100.0).round() as u8
            } else {
                0
            },
            updated_at: 1_700_000_000_000,
            is_finished: finished,
            channel: Some("comic".into()),
        }
    }

    /// 时长不可信（0）时的上报只能更新元数据，不能把"已看完"冲掉。
    ///
    /// 现场背景：分片 MP4 在 WebView 里 `duration` 长期是 `Infinity`，前端按约定
    /// 上报 duration=0。若这里无条件用上报值覆盖 is_finished，用户已经看完的一集
    /// 会因为一次"时长未知"的上报退回未看完——历史页的"已看完"徽章凭空消失。
    #[test]
    fn untrusted_duration_keeps_finished_flag() {
        let path = temp_db_path();
        let db = Database::open(&path).expect("打开测试库");
        db.save_history(&item(100.0, 100.0, true)).expect("写入已看完");
        db.save_history(&item(0.0, 0.0, false)).expect("写入仅元数据");

        let rows = db.list_history().expect("读取历史");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_finished, "时长缺失的上报把已看完标记冲掉了");
        assert!((rows[0].duration_seconds - 100.0).abs() < f64::EPSILON);
        assert!((rows[0].position_seconds - 100.0).abs() < f64::EPSILON);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }
}
