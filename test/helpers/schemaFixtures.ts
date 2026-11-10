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

/**
 * 阶段 4 的迁移输入基线。这里故意复制真实 v2 DDL，而不调用生产 migrate()：
 * 生产版本升到 v3 后，这份 fixture 仍必须生成精确的 v2 数据库。
 */
const V2_SCHEMA = `
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
  expires_at text not null,
  decision_required integer not null default 0,
  options_json text
);
create table check_log (
  id integer primary key autoincrement,
  at text not null,
  kind text not null check (kind in ('capacity','semantic','commit','override')),
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
PRAGMA user_version = 2;
`

function seedV2MigrationInput(db: DatabaseSync): void {
  const created = '2026-01-01T00:00:00.000Z'
  const updated = '2026-01-02T00:00:00.000Z'

  const insertGoal = db.prepare(`insert into goal
    (id,title,motivation,deadline,status,created_at,updated_at) values (?,?,?,?,?,?,?)`)
  insertGoal.run('g_active', '进行中的目标', '验证 v2 迁移', '2026-12-31', 'active', created, updated)
  insertGoal.run('g_done', '已完成目标', null, '2026-01-31', 'done', created, updated)
  insertGoal.run('g_dropped', '已放弃目标', null, null, 'dropped', created, updated)

  const insertPhase = db.prepare(`insert into phase
    (id,goal_id,title,seq,start_day,end_day,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)`)
  insertPhase.run('p_planned', 'g_active', '待开始阶段', 1, null, null, 'planned', created, updated)
  insertPhase.run('p_active', 'g_active', '进行中阶段', 2, '2026-11-01', '2026-11-30', 'active', created, updated)
  insertPhase.run('p_done', 'g_done', '已完成阶段', 1, '2026-01-01', '2026-01-15', 'done', created, updated)
  insertPhase.run('p_dropped', 'g_dropped', '已放弃阶段', 1, null, null, 'dropped', created, updated)

  const insertTask = db.prepare(`insert into task
    (id,goal_id,phase_id,title,day,est_minutes,actual_minutes,priority,status,note,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)`)
  insertTask.run('t_todo', 'g_active', 'p_planned', '待办任务', '2026-11-11', 45, null, 'P0', 'todo', null, created, updated)
  insertTask.run('t_doing', 'g_active', 'p_active', '进行中任务', '2026-11-12', 60, null, 'P1', 'doing', null, created, updated)
  insertTask.run('t_done', 'g_done', 'p_done', '已完成任务', '2026-01-10', 30, 25, 'P2', 'done', '保留执行记录', created, updated)
  insertTask.run('t_dropped', 'g_dropped', 'p_dropped', '已放弃任务', '2026-01-11', 30, null, 'P2', 'dropped', null, created, updated)
  insertTask.run('t_loose', 'g_active', null, '旧 loose task', null, 30, null, 'P2', 'todo', null, created, updated)

  const insertDraft = db.prepare(`insert into draft
    (id,goal_id,mode,payload_json,verdict,status,created_at,expires_at,decision_required,options_json)
    values (?,?,?,?,?,?,?,?,?,?)`)
  insertDraft.run('d_open', 'g_active', 'new', '{"phases":[]}', 'warn', 'open', created, '2027-01-01T00:00:00.000Z', 1, '[{"code":"shrink","label":"缩减任务"}]')
  insertDraft.run('d_committed', 'g_done', 'new', '{"phases":[]}', 'pass', 'committed', created, '2027-01-01T00:00:00.000Z', 0, null)
  insertDraft.run('d_discarded', 'g_dropped', 'adjust', '{"tasks":[]}', 'fail', 'discarded', created, '2027-01-01T00:00:00.000Z', 0, null)

  const insertLog = db.prepare(`insert into check_log
    (at,kind,target,verdict,issues_json,model) values (?,?,?,?,?,?)`)
  insertLog.run(created, 'capacity', 'd_open', 'warn', '[]', null)
  insertLog.run(created, 'semantic', 'd_open', 'pass', '[]', 'fixture-model')
  insertLog.run(created, 'commit', 'd_committed', 'pass', '[]', null)
  insertLog.run(created, 'override', 'd_open', 'warn', '[]', 'user')

  const insertSetting = db.prepare('insert into setting (key,value,updated_at) values (?,?,?)')
  insertSetting.run('capacity', '{"weekdayMinutes":300,"weekendMinutes":150,"overrides":{"2026-11-14":90}}', updated)
  insertSetting.run('fixture_marker', '"v2-migration-input"', updated)
}

/**
 * 在内存或调用方提供的空文件中生成一份确定的 v2 迁移输入副本。
 * 调用方拥有连接并负责 close；已有表或数据会明确失败，不做覆盖或清理。
 */
export function createV2MigrationInputCopy(dbPath = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(V2_SCHEMA)
  seedV2MigrationInput(db)
  return db
}
