import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { getDay, getMonth, patchTasks, putCapacity, type Capacity, type DayData, type MonthData, type PublicTask } from './api.js'
import { addDays, dayLabel, loadColor, loadWidth, monthLabel, shiftMonth, todayStr, WEEKDAYS } from './format.js'

const CARD: React.CSSProperties = {
  borderRadius: 12,
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
}

const BUTTON: React.CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-secondary)',
  borderRadius: 8,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function LoadBar({ planned, limit }: { planned: number; limit: number }): React.ReactElement {
  return (
    <div
      role="progressbar"
      aria-valuenow={planned}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-label={`已排 ${planned} / ${limit} 分钟`}
      style={{ height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l1)', overflow: 'hidden' }}
    >
      <div style={{ height: '100%', width: loadWidth(planned, limit), background: loadColor(planned, limit) }} />
    </div>
  )
}

function TaskRow({ task, onToggle, onMove, movable }: {
  task: PublicTask
  onToggle: () => void
  onMove?: () => void
  movable: boolean
}): React.ReactElement {
  const done = task.status === 'done'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, opacity: done ? 0.55 : 1 }}>
      <input type="checkbox" checked={done} onChange={onToggle} aria-label={`切换完成：${task.title}`} />
      <span style={{ flex: 1, fontSize: 13, textDecoration: done ? 'line-through' : 'none', color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task.title}
      </span>
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
        {task.estMinutes}min · {task.priority}
      </span>
      {movable && onMove !== undefined && (
        <button type="button" style={BUTTON} onClick={onMove}>明天 →</button>
      )}
    </div>
  )
}

function CapacityEditor({ capacity, onSave, onCancel }: {
  capacity: Capacity
  onSave: (next: Capacity) => void
  onCancel: () => void
}): React.ReactElement {
  const [weekday, setWeekday] = useState(String(capacity.weekdayMinutes))
  const [weekend, setWeekend] = useState(String(capacity.weekendMinutes))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', ...CARD }}>
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>工作日</span>
      <input value={weekday} onChange={(event) => setWeekday(event.target.value)} style={{ width: 56, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }} aria-label="工作日容量（分钟）" />
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>分钟 · 周末</span>
      <input value={weekend} onChange={(event) => setWeekend(event.target.value)} style={{ width: 56, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' }} aria-label="周末容量（分钟）" />
      <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)' }}>分钟</span>
      <button type="button" style={BUTTON} onClick={() => onSave({ ...capacity, weekdayMinutes: Number(weekday), weekendMinutes: Number(weekend) })}>保存</button>
      <button type="button" style={BUTTON} onClick={onCancel}>取消</button>
    </div>
  )
}

/**
 * 计划面板：月网格 + 选中日清单 + 目标进度 + 容量编辑。
 */
export function PlannerView(): React.ReactElement {
  const today = useMemo(() => todayStr(), [])
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const [monthData, setMonthData] = useState<MonthData | null>(null)
  const [selected, setSelected] = useState(today)
  const [dayData, setDayData] = useState<DayData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingCapacity, setEditingCapacity] = useState(false)

  const loadMonth = useCallback(async (target: string) => {
    try {
      setMonthData(await getMonth(target))
      setError(null)
    } catch (loadError) {
      setError(message(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDay = useCallback(async (day: string) => {
    try {
      setDayData(await getDay(day))
    } catch (loadError) {
      setError(message(loadError))
    }
  }, [])

  useEffect(() => { void loadMonth(month) }, [month, loadMonth])
  useEffect(() => { void loadDay(selected) }, [selected, loadDay])

  const refresh = useCallback(async () => {
    await Promise.all([loadMonth(month), loadDay(selected)])
  }, [loadMonth, loadDay, month, selected])

  const toggle = useCallback(async (task: PublicTask) => {
    const next = task.status === 'done' ? 'todo' : 'done'
    setDayData((current) => current === null ? current : {
      ...current,
      tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status: next } : item),
    })
    try {
      await patchTasks([{ id: task.id, status: next }])
      await refresh()
    } catch (patchError) {
      setError(message(patchError))
      await refresh()
    }
  }, [refresh])

  const moveTomorrow = useCallback(async (task: PublicTask) => {
    const target = addDays(selected, 1)
    setDayData((current) => current === null ? current : {
      ...current,
      tasks: current.tasks.filter((item) => item.id !== task.id),
    })
    try {
      await patchTasks([{ id: task.id, day: target }])
      await refresh()
    } catch (patchError) {
      setError(message(patchError))
      await refresh()
    }
  }, [refresh, selected])

  /** 把未排期任务放进当前选中日。 */
  const scheduleToSelected = useCallback(async (task: PublicTask) => {
    try {
      await patchTasks([{ id: task.id, day: selected }])
      await refresh()
    } catch (patchError) {
      setError(message(patchError))
    }
  }, [refresh, selected])

  const saveCapacity = useCallback(async (next: Capacity) => {
    try {
      await putCapacity(next)
      setEditingCapacity(false)
      await refresh()
    } catch (saveError) {
      setError(message(saveError))
    }
  }, [refresh])

  const isEmpty = monthData !== null && monthData.goals.length === 0 && monthData.days.every((day) => day.count === 0)

  return (
    <div style={{ padding: '20px 24px 40px', display: 'flex', flexDirection: 'column', gap: 12, color: 'var(--dsw-alias-label-primary)' }}>
      {error !== null && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" style={BUTTON} onClick={() => setError(null)}>关闭</button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 16 }}>{monthLabel(month)}</strong>
        <button type="button" style={BUTTON} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="上个月">‹</button>
        <button type="button" style={BUTTON} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="下个月">›</button>
        <button type="button" style={BUTTON} onClick={() => { setMonth(today.slice(0, 7)); setSelected(today) }}>今天</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={BUTTON} onClick={() => setEditingCapacity((open) => !open)}>⚙ 容量</button>
      </div>

      {editingCapacity && monthData !== null && (
        <CapacityEditor capacity={monthData.capacity} onSave={saveCapacity} onCancel={() => setEditingCapacity(false)} />
      )}

      {monthData !== null && monthData.goals.length > 0 && (
        <div style={{ ...CARD, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {monthData.goals.map((goal) => (
            <div key={goal.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{goal.title}</span>
              <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
                {goal.done}/{goal.total} · {goal.percent}%
              </span>
              {goal.deadline !== null && (
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>截止 {goal.deadline}</span>
              )}
              {goal.atRisk && <span title="剩余任务超出截止前可用容量" style={{ fontSize: 12, color: 'var(--dsw-alias-state-warning-primary)' }}>⚠ 紧张</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ ...CARD, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
          {WEEKDAYS.map((name) => (
            <div key={name} style={{ fontSize: 11, textAlign: 'center', color: 'var(--dsw-alias-label-caption)' }}>{name}</div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
          {loading && monthData === null && (
            <div style={{ gridColumn: '1 / -1', height: 240, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>加载中…</div>
          )}
          {monthData?.days.map((item) => {
            const isSelected = item.day === selected
            const isToday = item.day === today
            return (
              <button
                key={item.day}
                type="button"
                onClick={() => setSelected(item.day)}
                aria-pressed={isSelected}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  minHeight: 64,
                  padding: 6,
                  borderRadius: 8,
                  cursor: 'pointer',
                  textAlign: 'left',
                  background: isSelected ? 'var(--dsw-alias-bg-base)' : 'transparent',
                  border: `1px solid ${isSelected ? 'var(--dsw-alias-state-business-primary)' : isToday ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l1)'}`,
                  opacity: item.inMonth ? 1 : 0.4,
                }}
              >
                <span style={{ fontSize: 12, color: isToday ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)', fontWeight: isToday ? 700 : 400 }}>
                  {Number(item.day.slice(8))}
                </span>
                {item.count > 0 && (
                  <>
                    <LoadBar planned={item.planned} limit={item.limit} />
                    <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-caption)' }}>{item.count} 项 · {item.planned}min</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
        {isEmpty && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
            还没有计划——在对话里说「帮我拆一个两周计划」开始。
          </div>
        )}
      </div>

      <div style={{ ...CARD, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>{dayLabel(selected)}</strong>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>
            {dayData === null ? '' : `${dayData.planned} / ${dayData.limit} 分钟`}
          </span>
        </div>
        {dayData === null || dayData.tasks.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', padding: '8px 0' }}>这天没有任务。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {dayData.tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                movable={selected === today}
                onToggle={() => { void toggle(task) }}
                {...(selected === today ? { onMove: () => { void moveTomorrow(task) } } : {})}
              />
            ))}
          </div>
        )}
      </div>

      {monthData !== null && monthData.unscheduled.length > 0 && (
        <div style={{ ...CARD, padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>未排期 · {monthData.unscheduled.length}</strong>
            <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>点「排到这天」放进 {dayLabel(selected)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {monthData.unscheduled.map((task) => (
              <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32 }}>
                <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-caption)', fontVariantNumeric: 'tabular-nums' }}>{task.estMinutes}min · {task.priority}</span>
                <button type="button" style={BUTTON} onClick={() => { void scheduleToSelected(task) }}>排到这天</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
