/**
 * SQLite 访问层。
 * 使用 Node 22 内置 node:sqlite（零原生依赖，避免 better-sqlite3 的编译问题），
 * 通过 createRequire 引入以获得稳定的运行时加载，并在此收口最小类型。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  // node:sqlite 返回的行在类型层面是 Record<string, unknown>，
  // 这里统一收敛为 any，由调用方用行接口（StockRow 等）接管类型责任。
  /* eslint-disable @typescript-eslint/no-explicit-any */
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseSyncCtor = new (path: string) => Database;

const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
