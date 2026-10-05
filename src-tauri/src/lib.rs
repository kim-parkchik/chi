mod db;

use db::{Databases, ExecResult};
use serde_json::{Map, Value as Json};
use tauri::State;

// ── 帳簿ファイル（SQLite）。中身は db.rs ──
#[tauri::command(async)]
fn db_open(dbs: State<'_, Databases>, path: String) -> Result<(), String> {
    dbs.open(&path)
}

#[tauri::command(async)]
fn db_close(dbs: State<'_, Databases>, path: String) -> Result<(), String> {
    dbs.close(&path)
}

#[tauri::command(async)]
fn db_execute(dbs: State<'_, Databases>, path: String, sql: String, params: Vec<Json>) -> Result<ExecResult, String> {
    dbs.with(&path, |c| db::execute(c, &sql, &params))
}

#[tauri::command(async)]
fn db_select(dbs: State<'_, Databases>, path: String, sql: String, params: Vec<Json>) -> Result<Vec<Map<String, Json>>, String> {
    dbs.with(&path, |c| db::select(c, &sql, &params))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Databases::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![db_open, db_close, db_execute, db_select])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
