//! 帳簿ファイル（SQLite）へのアクセス
//!
//! 以前は tauri-plugin-sql を使っていたが、内部が接続プールのため BEGIN / COMMIT が同じ接続で
//! 実行される保証がなく、トランザクションが使えなかった。ここでは帳簿ファイルごとに接続を1本だけ持ち、
//! 画面側（src/db/repo.ts）から BEGIN / COMMIT / ROLLBACK を送れるようにしている。
//!
//! この層は SQL をそのまま実行するだけ。SQL はすべて src/db/repo.ts と src/db/schema.ts にある。

use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Number, Value as Json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// 開いている帳簿ファイル（パス → 接続）
#[derive(Default)]
pub struct Databases(pub Mutex<HashMap<String, Connection>>);

#[derive(Serialize, Debug, PartialEq)]
pub struct ExecResult {
    pub rows_affected: u64,
    pub last_insert_id: i64,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// 画面から来た値（JSON）を SQLite の値に変える
fn to_sql(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        Json::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

/// SQLite の値を JSON に変える（BLOB は使っていないが、来たら数値の配列にする）
fn to_json(v: ValueRef) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Json::Number).unwrap_or(Json::Null),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Json::Array(b.iter().map(|x| Json::Number((*x).into())).collect()),
    }
}

pub fn open_connection(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(err)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(err)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(err)?;
    Ok(conn)
}

fn bind(stmt: &mut rusqlite::Statement, params: &[Json]) -> Result<(), String> {
    let expected = stmt.parameter_count();
    if expected != params.len() {
        return Err(format!("SQL のパラメータの数が合いません（必要 {}、渡された数 {}）", expected, params.len()));
    }
    for (i, p) in params.iter().enumerate() {
        stmt.raw_bind_parameter(i + 1, to_sql(p)).map_err(err)?;
    }
    Ok(())
}

/// 1文を実行する（INSERT / UPDATE / DELETE / BEGIN / COMMIT / PRAGMA など）
pub fn execute(conn: &Connection, sql: &str, params: &[Json]) -> Result<ExecResult, String> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    bind(&mut stmt, params)?;
    if stmt.column_count() > 0 {
        // 行を返す文（PRAGMA など）は最後まで読み捨てる
        let mut rows = stmt.raw_query();
        while rows.next().map_err(err)?.is_some() {}
    } else {
        stmt.raw_execute().map_err(err)?;
    }
    Ok(ExecResult { rows_affected: conn.changes(), last_insert_id: conn.last_insert_rowid() })
}

/// 1文を実行して、行を「列名 → 値」の形で返す
pub fn select(conn: &Connection, sql: &str, params: &[Json]) -> Result<Vec<Map<String, Json>>, String> {
    let mut stmt = conn.prepare(sql).map_err(err)?;
    bind(&mut stmt, params)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.raw_query();
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            m.insert(name.clone(), to_json(row.get_ref(i).map_err(err)?));
        }
        out.push(m);
    }
    Ok(out)
}

impl Databases {
    pub fn open(&self, path: &str) -> Result<(), String> {
        let mut map = self.0.lock().map_err(err)?;
        if !map.contains_key(path) {
            map.insert(path.to_string(), open_connection(path)?);
        }
        Ok(())
    }

    pub fn close(&self, path: &str) -> Result<(), String> {
        let mut map = self.0.lock().map_err(err)?;
        if let Some(conn) = map.remove(path) {
            // 途中のトランザクションが残っていたら取り消してから閉じる
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK;");
            }
            conn.close().map_err(|(_, e)| err(e))?;
        }
        Ok(())
    }

    pub fn with<T>(&self, path: &str, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let map = self.0.lock().map_err(err)?;
        let conn = map.get(path).ok_or_else(|| "帳簿ファイルが開かれていません".to_string())?;
        f(conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        execute(&c, "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, n INTEGER, x REAL)", &[]).unwrap();
        c
    }

    #[test]
    fn insert_and_select() {
        let c = mem();
        let r = execute(&c, "INSERT INTO t (name, n, x) VALUES (?, ?, ?)", &[json!("現金"), json!(1000), json!(1.5)]).unwrap();
        assert_eq!(r, ExecResult { rows_affected: 1, last_insert_id: 1 });
        let rows = select(&c, "SELECT * FROM t WHERE n >= ?", &[json!(500)]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], json!("現金"));
        assert_eq!(rows[0]["n"], json!(1000));
        assert_eq!(rows[0]["x"], json!(1.5));
        let empty = select(&c, "SELECT * FROM t WHERE name IS ?", &[Json::Null]).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn transaction_rolls_back() {
        let c = mem();
        execute(&c, "BEGIN IMMEDIATE", &[]).unwrap();
        execute(&c, "INSERT INTO t (name) VALUES (?)", &[json!("a")]).unwrap();
        execute(&c, "ROLLBACK", &[]).unwrap();
        assert!(select(&c, "SELECT * FROM t", &[]).unwrap().is_empty());
    }

    #[test]
    fn trigger_message_reaches_caller() {
        let c = mem();
        execute(&c, "CREATE TRIGGER no_del BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, '削除できません'); END;", &[]).unwrap();
        execute(&c, "INSERT INTO t (name) VALUES ('a')", &[]).unwrap();
        let e = execute(&c, "DELETE FROM t", &[]).unwrap_err();
        assert!(e.contains("削除できません"), "{}", e);
    }

    #[test]
    fn pragma_and_param_count() {
        let c = mem();
        execute(&c, "PRAGMA foreign_keys = ON;", &[]).unwrap();
        let cols = select(&c, "PRAGMA table_info(t)", &[]).unwrap();
        assert_eq!(cols.len(), 4);
        assert!(execute(&c, "INSERT INTO t (name) VALUES (?)", &[]).is_err());
    }

    #[test]
    fn open_twice_and_close_with_open_transaction() {
        let dir = std::env::temp_dir().join(format!("chi_db_test_{}.chi", std::process::id()));
        let path = dir.to_string_lossy().to_string();
        let dbs = Databases::default();
        dbs.open(&path).unwrap();
        dbs.open(&path).unwrap();
        dbs.with(&path, |c| execute(c, "CREATE TABLE IF NOT EXISTS t (a)", &[])).unwrap();
        dbs.with(&path, |c| execute(c, "BEGIN", &[])).unwrap();
        dbs.with(&path, |c| execute(c, "INSERT INTO t VALUES (1)", &[])).unwrap();
        dbs.close(&path).unwrap(); // 途中のトランザクションは取り消される
        dbs.open(&path).unwrap();
        let n = dbs.with(&path, |c| select(c, "SELECT COUNT(*) AS n FROM t", &[])).unwrap();
        assert_eq!(n[0]["n"], json!(0));
        dbs.close(&path).unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
