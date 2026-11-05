/**
 * 建库与迁移。只有这里知道 DDL 与 `user_version`。
 * @module @local/planner/db/schema
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 当前 schema 版本；加字段时 +1 并在 migrate 里补一段。 */
export const SCHEMA_VERSION = 2

export interface DbConfig {
  /** 绝对路径；留空用 `~/.dsh/personal-planner/planner.sqlite`。 */
  dbPath?: string
}

/** 数据库比插件新：用户装回了旧版插件。降级为只读会误导，所以直接报错并让调用方降级空转。 */
export class SchemaTooNewError extends Error {
  readonly dbVersion: number
  readonly supportedVersion: number

  constructor(dbVersion: number, supportedVersion: number) {
    super(`数据库 schema 版本 ${dbVersion} 比插件支持的 ${supportedVersion} 新`)
    this.name = 'SchemaTooNewError'
    this.dbVersion = dbVersion
    this.supportedVersion = supportedVersion
  }
}

/**
 * 解析数据库路径。
 * @param config - 插件配置；`dbPath` 优先。
 * @returns 绝对路径。
 */
export function resolveDbPath(config: DbConfig = {}): string {
  const raw = config.dbPath?.trim()
  if (raw !== undefined && raw !== '') return raw
  return join(homedir(), '.dsh', 'personal-planner', 'planner.sqlite')
}

const DDL_V1 = `
create table if not exists goal (
  id          text primary key,
  title       text not null check (length(trim(title)) > 0),
  motivation  text,
  deadline    text,
  status      text not null default 'active' check (status in ('active','done','dropped')),
  created_at  text not null,
  updated_at  text not null
);

create table if not exists phase (
  id        text primary key,
  goal_id   text not null references goal(id) on delete cascade,
  title     text not null,
  seq       integer not null,
  start_day text,
  end_day   text,
  status    text not null default 'planned' check (status in ('planned','active','done','dropped')),
  created_at text not null,
  updated_at text not null
);

create table if not exists task (
  id          text primary key,
  goal_id     text references goal(id) on delete set null,
  phase_id    text references phase(id) on delete set null,
  title       text not null check (length(trim(title)) > 0),
  day         text,
  est_minutes integer not null default 30 check (est_minutes > 0),
  actual_minutes integer,
  priority    text not null default 'P2' check (priority in ('P0','P1','P2')),
  status      text not null default 'todo' check (status in ('todo','doing','done','dropped')),
  note        text,
  created_at  text not null,
  updated_at  text not null
);

create table if not exists draft (
  id           text primary key,
  goal_id      text,
  mode         text not null check (mode in ('new','adjust')),
  payload_json text not null,
  verdict      text check (verdict in ('pass','warn','fail','unverified')),
  status       text not null default 'open' check (status in ('open','committed','discarded')),
  created_at   text not null,
  expires_at   text not null
);

create table if not exists check_log (
  id          integer primary key autoincrement,
  at          text not null,
  kind        text not null check (kind in ('capacity','semantic','commit')),
  target      text not null,
  verdict     text not null check (verdict in ('pass','warn','fail','unverified')),
  issues_json text not null,
  model       text
);

create table if not exists setting (
  key        text primary key,
  value      text not null,
  updated_at text not null
);

create index if not exists idx_task_day on task(day);
create index if not exists idx_task_goal_status on task(goal_id, status);
create index if not exists idx_draft_status on draft(status);
`

/**
 * v2：草稿记录"是否需要用户决定"与选项；check_log 允许 `override`。
 *
 * SQLite 改不了 CHECK 约束，所以 check_log 走"建新表 → 搬家 → 改名"。
 * @param db - 已打开的连接。
 */
function migrateToV2(db: DatabaseSync): void {
  db.exec(`
    alter table draft add column decision_required integer not null default 0;
    alter table draft add column options_json text;

    create table check_log_v2 (
      id          integer primary key autoincrement,
      at          text not null,
      kind        text not null check (kind in ('capacity','semantic','commit','override')),
      target      text not null,
      verdict     text not null check (verdict in ('pass','warn','fail','unverified')),
      issues_json text not null,
      model       text
    );
    insert into check_log_v2 (id, at, kind, target, verdict, issues_json, model)
      select id, at, kind, target, verdict, issues_json, model from check_log;
    drop table check_log;
    alter table check_log_v2 rename to check_log;
  `)
}

/**
 * 建表或升级到当前版本。
 * @param db - 已打开的连接。
 * @throws {SchemaTooNewError} 库版本高于插件支持版本。
 */
export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  const version = row?.user_version ?? 0
  if (version > SCHEMA_VERSION) throw new SchemaTooNewError(version, SCHEMA_VERSION)
  if (version < 1) {
    db.exec(DDL_V1)
    db.exec('PRAGMA user_version = 1')
  }
  if (version < 2) {
    migrateToV2(db)
    db.exec('PRAGMA user_version = 2')
  }
}

/**
 * 打开数据库并确保 schema 就绪。
 * @param config - `dbPath` 覆盖默认位置。
 * @returns 已启用 WAL / 外键 / busy_timeout 的连接。
 */
export function openPlannerDb(config: DbConfig = {}): DatabaseSync {
  const path = resolveDbPath(config)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}
