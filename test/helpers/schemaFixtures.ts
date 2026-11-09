import { DatabaseSync } from 'node:sqlite'

/** 阶段一冻结的真实 v1 形状；用于证明 migrate() 确实能从 v1 保留数据升级。 */
const V1_SCHEMA = `
create table goal (
  id text primary key,
  title text not null check (length(trim(title)) > 0),
  motivation text,
  deadline text,
  status text not null default 'active' check (status in ('active','done','dropped')),
  created_at text not null,
  updated_at text not null
);
create table phase (
  id text primary key,
  goal_id text not null references goal(id) on delete cascade,
  title text not null,
  seq integer not null,
  start_day text,
  end_day text,
  status text not null default 'planned' check (status in ('planned','active','done','dropped')),
  created_at text not null,
  updated_at text not null
);
create table task (
  id text primary key,
  goal_id text references goal(id) on delete set null,
  phase_id text references phase(id) on delete set null,
  title text not null check (length(trim(title)) > 0),
  day text,
  est_minutes integer not null default 30 check (est_minutes > 0),
  actual_minutes integer,
  priority text not null default 'P2' check (priority in ('P0','P1','P2')),
  status text not null default 'todo' check (status in ('todo','doing','done','dropped')),
  note text,
  created_at text not null,
  updated_at text not null
);
create table draft (
  id text primary key,
  goal_id text,
  mode text not null check (mode in ('new','adjust')),
  payload_json text not null,
  verdict text check (verdict in ('pass','warn','fail','unverified')),
  status text not null default 'open' check (status in ('open','committed','discarded')),
  created_at text not null,
  expires_at text not null
);
create table check_log (
  id integer primary key autoincrement,
  at text not null,
  kind text not null check (kind in ('capacity','semantic','commit')),
  target text not null,
  verdict text not null check (verdict in ('pass','warn','fail','unverified')),
  issues_json text not null,
  model text
);
create table setting (
  key text primary key,
  value text not null,
  updated_at text not null
);
create index idx_task_day on task(day);
create index idx_task_goal_status on task(goal_id, status);
create index idx_draft_status on draft(status);
PRAGMA user_version = 1;
`

export function openV1ForTest(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(V1_SCHEMA)
  const stamp = '2026-01-01T00:00:00.000Z'
  db.prepare(`insert into goal (id,title,motivation,deadline,status,created_at,updated_at)
    values ('g_v1','旧目标',null,null,'active',?,?)`).run(stamp, stamp)
  db.prepare(`insert into draft (id,goal_id,mode,payload_json,verdict,status,created_at,expires_at)
    values ('d_v1','g_v1','new','{"phases":[]}',null,'open',?,?)`).run(stamp, '2027-01-01T00:00:00.000Z')
  db.prepare(`insert into check_log (at,kind,target,verdict,issues_json,model)
    values (?,'capacity','d_v1','pass','[]',null)`).run(stamp)
  return db
}
