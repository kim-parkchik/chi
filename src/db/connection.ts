/**
 * 帳簿ファイル（SQLite）への接続。中身は Rust 側（src-tauri/src/db.rs）
 *
 * 帳簿ファイルごとに接続を1本だけ持つので、BEGIN / COMMIT のトランザクションが使える
 * （以前の tauri-plugin-sql は接続プールのため使えなかった）。トランザクションは repo.ts の tx() から使う
 */
import { invoke } from "@tauri-apps/api/core";

export interface QueryResult {
  rowsAffected: number;
  lastInsertId: number;
}

/** repo.ts が使う形（テストでは bun:sqlite で同じ形を用意する） */
export default class Database {
  private constructor(readonly path: string) {}

  static async load(path: string) {
    await invoke("db_open", { path });
    return new Database(path);
  }

  select<T>(sql: string, params: unknown[] = []): Promise<T> {
    return invoke<T>("db_select", { path: this.path, sql, params });
  }

  async execute(sql: string, params: unknown[] = []): Promise<QueryResult> {
    const r = await invoke<{ rows_affected: number; last_insert_id: number }>("db_execute", { path: this.path, sql, params });
    return { rowsAffected: r.rows_affected, lastInsertId: r.last_insert_id };
  }

  close() {
    return invoke<void>("db_close", { path: this.path });
  }
}
