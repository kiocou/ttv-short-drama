use crate::models::{FavoriteItem, UserSettings, WatchHistoryItem};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
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
                CREATE TABLE IF NOT EXISTS favorites (
                    series_id TEXT PRIMARY KEY NOT NULL,
                    title TEXT NOT NULL,
                    cover TEXT NOT NULL,
                    mark TEXT NOT NULL,
                    channel TEXT,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_favorites_updated_at
                    ON favorites(updated_at DESC);
                CREATE TABLE IF NOT EXISTS account_sessions (
                    account_key TEXT PRIMARY KEY NOT NULL,
                    display_name TEXT NOT NULL,
                    protected_session BLOB NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_session_index (
                    account_key TEXT PRIMARY KEY NOT NULL,
                    display_name TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS account_favorites (
                    account_key TEXT NOT NULL,
                    series_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    cover TEXT NOT NULL,
                    mark TEXT NOT NULL,
                    channel TEXT,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (account_key, series_id)
                );
                CREATE TABLE IF NOT EXISTS account_history (
                    account_key TEXT NOT NULL,
                    series_id TEXT NOT NULL,
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
                    channel TEXT,
                    PRIMARY KEY (account_key, series_id)
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
        let mut records = statement
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
        // 渲染用改写：库里存的是可持久化的原始地址，交给前端的那一份才换成本地代理
        // （境外图床直连会超时，见 `hls_proxy::proxied_image_url`）。写库前会还原，
        // 所以库里永远不会留下代理地址。
        for item in &mut records {
            if let Some(proxied) = crate::hls_proxy::proxied_image_url(&item.series_cover) {
                item.series_cover = proxied;
            }
        }
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
                    // 落库前还原成原始地址：代理地址跨进程启动即失效，见 restore_image_url。
                    crate::hls_proxy::restore_image_url(&item.series_cover),
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

    pub fn list_favorites(&self, mark: Option<&str>) -> Result<Vec<FavoriteItem>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "收藏数据库锁不可用。".to_string())?;
        let read_rows = |statement: &mut rusqlite::Statement,
                         params: &[&dyn rusqlite::ToSql]|
         -> Result<Vec<FavoriteItem>, String> {
            let mapped = statement
                .query_map(params, |row| {
                    Ok(FavoriteItem {
                        series_id: row.get(0)?,
                        title: row.get(1)?,
                        cover: row.get(2)?,
                        mark: row.get(3)?,
                        channel: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })
                .map_err(|error| error.to_string())?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        };
        let mut records = match mark {
            Some(value) => {
                let mut statement = connection
                    .prepare(
                        "SELECT series_id, title, cover, mark, channel, updated_at
                         FROM favorites WHERE mark = ?1 ORDER BY updated_at DESC",
                    )
                    .map_err(|error| error.to_string())?;
                read_rows(&mut statement, &[&value])?
            }
            None => {
                let mut statement = connection
                    .prepare(
                        "SELECT series_id, title, cover, mark, channel, updated_at
                         FROM favorites ORDER BY updated_at DESC",
                    )
                    .map_err(|error| error.to_string())?;
                read_rows(&mut statement, &[])?
            }
        };
        // 同 list_history：渲染用改写，库里存原始地址。
        for item in &mut records {
            if let Some(proxied) = crate::hls_proxy::proxied_image_url(&item.cover) {
                item.cover = proxied;
            }
        }
        Ok(records)
    }

    pub fn save_favorite(&self, item: &FavoriteItem) -> Result<(), String> {
        if item.series_id.trim().is_empty() {
            return Err("收藏条目缺少剧集标识。".into());
        }
        // 状态只有三种：未知值是前端 bug 的信号，报错而不是静默改写。
        if !matches!(item.mark.as_str(), "want" | "watching" | "done") {
            return Err(format!("未知的收藏状态：{}", item.mark));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "收藏数据库锁不可用。".to_string())?;
        connection
            .execute(
                "INSERT INTO favorites (series_id, title, cover, mark, channel, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(series_id) DO UPDATE SET
                    title = excluded.title,
                    cover = excluded.cover,
                    mark = excluded.mark,
                    channel = excluded.channel,
                    updated_at = excluded.updated_at",
                params![
                    item.series_id,
                    item.title,
                    // 同 save_history：落库前还原成原始地址。
                    crate::hls_proxy::restore_image_url(&item.cover),
                    item.mark,
                    item.channel,
                    item.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn remove_favorite(&self, series_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "收藏数据库锁不可用。".to_string())?;
        connection
            .execute(
                "DELETE FROM favorites WHERE series_id = ?1",
                params![series_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn save_account_session(
        &self,
        account_id: &str,
        display_name: &str,
        session: &[u8],
    ) -> Result<String, String> {
        let account_key = account_key(account_id)?;
        if session.is_empty() {
            return Err("账号会话不能为空。".into());
        }
        let protected_session = crate::account_session::protect(session)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "账号会话数据库锁不可用。".to_string())?;
        let tx = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO account_session_index (account_key, display_name, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(account_key) DO UPDATE SET
                display_name = excluded.display_name,
                updated_at = excluded.updated_at",
            params![account_key, display_name.trim(), now_unix_ms()],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
                "INSERT INTO account_sessions (account_key, display_name, protected_session, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(account_key) DO UPDATE SET
                    display_name = excluded.display_name,
                    protected_session = excluded.protected_session,
                    updated_at = excluded.updated_at",
                params![account_key, display_name.trim(), protected_session, now_unix_ms()],
            )
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(format!("sha256:{account_key}"))
    }

    pub fn list_account_sessions(&self) -> Result<Vec<(String, String)>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "账号会话数据库锁不可用。".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT account_key, display_name FROM account_session_index ORDER BY updated_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<(String, String)>, _>>()
            .map_err(|error| error.to_string())
            .map(|accounts| {
                accounts
                    .into_iter()
                    .map(|(key, display_name)| (format!("sha256:{key}"), display_name))
                    .collect()
            })
    }

    pub fn load_account_session(
        &self,
        account_id: &str,
    ) -> Result<Option<(String, Vec<u8>)>, String> {
        let Some(account_key) = account_key_if_valid(account_id) else {
            return Ok(None);
        };
        let stored = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| "账号会话数据库锁不可用。".to_string())?;
            connection
                .query_row(
                    "SELECT display_name, protected_session FROM account_sessions WHERE account_key = ?1",
                    params![account_key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?
        };
        stored
            .map(|(display_name, protected)| {
                crate::account_session::unprotect(&protected)
                    .map(|session| (display_name, session))
                    .map_err(|_| "账号会话无法解密，请重新登录。".to_string())
            })
            .transpose()
    }

    pub fn remove_account_session(&self, account_id: &str) -> Result<(), String> {
        let Some(account_key) = account_key_if_valid(account_id) else {
            return Ok(());
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| "账号会话数据库锁不可用。".to_string())?;
        let tx = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM account_sessions WHERE account_key = ?1",
            params![account_key],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM account_session_index WHERE account_key = ?1",
            params![account_key],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_account_favorites(&self, account_id: &str) -> Result<Vec<FavoriteItem>, String> {
        let account_key = account_key(account_id)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "账号收藏数据库锁不可用。".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT series_id, title, cover, mark, channel, updated_at
                 FROM account_favorites WHERE account_key = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let records = statement
            .query_map(params![account_key], |row| {
                Ok(FavoriteItem {
                    series_id: row.get(0)?,
                    title: row.get(1)?,
                    cover: row.get(2)?,
                    mark: row.get(3)?,
                    channel: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string());
        records
    }

    pub fn save_account_favorite(
        &self,
        account_id: &str,
        item: &FavoriteItem,
    ) -> Result<(), String> {
        let account_key = account_key(account_id)?;
        if item.series_id.trim().is_empty() {
            return Err("账号收藏条目缺少剧集标识。".into());
        }
        if !matches!(item.mark.as_str(), "want" | "watching" | "done") {
            return Err(format!("未知的账号收藏状态：{}", item.mark));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| "账号收藏数据库锁不可用。".to_string())?;
        connection
            .execute(
                "INSERT INTO account_favorites (account_key, series_id, title, cover, mark, channel, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(account_key, series_id) DO UPDATE SET
                    title = excluded.title,
                    cover = excluded.cover,
                    mark = excluded.mark,
                    channel = excluded.channel,
                    updated_at = excluded.updated_at",
                params![
                    account_key,
                    item.series_id,
                    item.title,
                    crate::hls_proxy::restore_image_url(&item.cover),
                    item.mark,
                    item.channel,
                    item.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn remove_account_favorite(&self, account_id: &str, series_id: &str) -> Result<(), String> {
        let account_key = account_key(account_id)?;
        self.connection
            .lock()
            .map_err(|_| "账号收藏数据库锁不可用。".to_string())?
            .execute(
                "DELETE FROM account_favorites WHERE account_key = ?1 AND series_id = ?2",
                params![account_key, series_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_account_history(&self, account_id: &str) -> Result<Vec<WatchHistoryItem>, String> {
        let account_key = account_key(account_id)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "账号历史数据库锁不可用。".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT series_id, episode_id, title, series_cover, episode_number, total_episodes,
                        position_seconds, duration_seconds, progress_percent, updated_at, is_finished, channel
                 FROM account_history WHERE account_key = ?1 ORDER BY updated_at DESC LIMIT 80",
            )
            .map_err(|error| error.to_string())?;
        let records = statement
            .query_map(params![account_key], |row| {
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
            .map_err(|error| error.to_string());
        records
    }
}

fn account_key(account_id: &str) -> Result<String, String> {
    account_key_if_valid(account_id).ok_or_else(|| "账号标识不能为空。".to_string())
}

fn account_key_if_valid(account_id: &str) -> Option<String> {
    let account_id = account_id.trim();
    if account_id.is_empty() {
        return None;
    }
    if let Some(key) = account_id.strip_prefix("sha256:") {
        return (key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| key.to_ascii_lowercase());
    }
    Some(format!("{:x}", Sha256::digest(account_id.as_bytes())))
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod account_session_tests {
    use super::Database;
    use rusqlite::params;
    use std::fs;

    fn test_database() -> (Database, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "ttv-account-session-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        (
            Database::open(&path).expect("open isolated test database"),
            path,
        )
    }

    #[test]
    fn account_sessions_are_encrypted_and_isolated() {
        let (database, path) = test_database();
        let alice_secret = b"alice-session-secret";
        let bob_secret = b"bob-session-secret";

        database
            .save_account_session("alice", "Alice", alice_secret)
            .expect("save Alice session");
        database
            .save_account_session("bob", "Bob", bob_secret)
            .expect("save Bob session");

        let connection = database.connection.lock().expect("database lock");
        let alice_ciphertext: Vec<u8> = connection
            .query_row(
                "SELECT protected_session FROM account_sessions WHERE account_key = ?1",
                params![super::account_key("alice").expect("valid account key")],
                |row| row.get(0),
            )
            .expect("Alice ciphertext");
        assert!(!alice_ciphertext
            .windows(alice_secret.len())
            .any(|window| window == alice_secret));
        drop(connection);

        assert_eq!(
            database.load_account_session("alice").expect("load Alice"),
            Some(("Alice".to_owned(), alice_secret.to_vec()))
        );
        let accounts = database.list_account_sessions().expect("list accounts");
        assert_eq!(accounts.len(), 2);
        let (alice_key, alice_name) = accounts
            .iter()
            .find(|(_, name)| name == "Alice")
            .expect("Alice account summary");
        assert_ne!(alice_key, "alice");
        assert_eq!(
            database
                .load_account_session(alice_key)
                .expect("load by opaque key"),
            Some(("Alice".to_owned(), alice_secret.to_vec()))
        );
        assert_eq!(alice_name, "Alice");
        assert_eq!(
            database.load_account_session("bob").expect("load Bob"),
            Some(("Bob".to_owned(), bob_secret.to_vec()))
        );

        database
            .remove_account_session("alice")
            .expect("remove Alice session");
        assert_eq!(
            database
                .load_account_session("alice")
                .expect("Alice signed out"),
            None
        );
        assert!(!database
            .list_account_sessions()
            .expect("account list after sign out")
            .iter()
            .any(|(key, _)| key == alice_key));
        assert_eq!(
            database
                .load_account_session("bob")
                .expect("Bob remains signed in"),
            Some(("Bob".to_owned(), bob_secret.to_vec()))
        );

        drop(database);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn session_load_does_not_treat_missing_or_empty_keys_as_accounts() {
        let (database, path) = test_database();
        assert!(database.save_account_session("", "", b"secret").is_err());
        assert_eq!(
            database
                .load_account_session("")
                .expect("empty key rejected"),
            None
        );
        assert_eq!(
            database
                .load_account_session("missing")
                .expect("missing key"),
            None
        );
        drop(database);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn opaque_account_keys_are_explicit_and_do_not_collide_with_hex_account_ids() {
        let account_id = "a".repeat(64);
        let account_hash = super::account_key(&account_id).expect("hash raw account id");
        assert_ne!(account_hash, account_id);
        assert_eq!(
            super::account_key(&format!("sha256:{account_hash}"))
                .expect("accept opaque account key"),
            account_hash
        );
    }

    #[test]
    fn account_sessions_are_replaced_only_for_the_same_account() {
        let (database, path) = test_database();
        database
            .save_account_session("alice", "Alice", b"old-session")
            .expect("save original session");
        database
            .save_account_session("alice", "Alice 2", b"new-session")
            .expect("refresh same account session");
        database
            .save_account_session("bob", "Bob", b"bob-session")
            .expect("save other account session");

        assert_eq!(
            database
                .load_account_session("alice")
                .expect("load refreshed session"),
            Some(("Alice 2".to_owned(), b"new-session".to_vec()))
        );
        assert_eq!(
            database
                .load_account_session("bob")
                .expect("load other session"),
            Some(("Bob".to_owned(), b"bob-session".to_vec()))
        );

        drop(database);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn account_favorites_and_history_are_separate_from_local_data_and_other_accounts() {
        use crate::models::{FavoriteItem, WatchHistoryItem};

        let (database, path) = test_database();
        let item = FavoriteItem {
            series_id: "series-1".into(),
            title: "测试短剧".into(),
            cover: "https://example.com/cover.jpg".into(),
            mark: "watching".into(),
            channel: Some("drama".into()),
            updated_at: 10,
        };
        database.save_favorite(&item).expect("save local favorite");
        database
            .save_account_favorite("alice", &item)
            .expect("save Alice account favorite");

        let history = WatchHistoryItem {
            series_id: "series-1".into(),
            episode_id: "episode-1".into(),
            title: "测试短剧".into(),
            series_cover: String::new(),
            episode_number: 3,
            total_episodes: 12,
            position_seconds: 42.0,
            duration_seconds: 100.0,
            progress_percent: 42,
            updated_at: 20,
            is_finished: false,
            channel: Some("drama".into()),
        };
        database.save_history(&history).expect("save local history");

        assert_eq!(database.list_account_favorites("alice").unwrap().len(), 1);
        assert!(database.list_account_favorites("bob").unwrap().is_empty());
        assert!(database.list_account_history("alice").unwrap().is_empty());
        assert_eq!(database.list_favorites(None).unwrap().len(), 1);
        assert_eq!(database.list_history().unwrap().len(), 1);

        database
            .remove_account_favorite("alice", "series-1")
            .expect("remove account-only favorite");
        assert!(database.list_account_favorites("alice").unwrap().is_empty());
        assert_eq!(database.list_favorites(None).unwrap().len(), 1);

        drop(database);
        let _ = fs::remove_file(path);
    }
}
