/**
 * Client 半区入口：注册两个 slot —— 输入框下方的负载徽章、对话视图里的计划面板。
 * @module @local/planner/client
 */
import React, { useEffect, useState } from 'react'
import { getMonth } from './api.js'
import { PlannerView } from './PlannerView.js'
import { loadColor, todayStr } from './format.js'

export const inject = ['slots']

const BADGE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 10px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '20px',
  whiteSpace: 'nowrap',
  userSelect: 'none',
}

const DOT: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flex: 'none',
}

/** 输入框下方的今日负载徽章；拿不到数据时显示未连接。 */
function PlannerBadge(): React.ReactElement {
  const [text, setText] = useState('计划 · 连接中')
  const [color, setColor] = useState('var(--dsw-alias-label-tertiary)')

  useEffect(() => {
    let alive = true
    const today = todayStr()
    getMonth(today.slice(0, 7))
      .then((data) => {
        if (!alive) return
        const entry = data.days.find((day) => day.day === today)
        if (entry === undefined) {
          setText('计划 · 今日空闲')
          return
        }
        setText(`今日 ${entry.planned}/${entry.limit} 分钟`)
        setColor(loadColor(entry.planned, entry.limit))
      })
      .catch(() => {
        if (alive) setText('计划 · 未连接')
      })
    return () => { alive = false }
  }, [])

  return (
    <div style={BADGE} role="status" aria-live="polite" title="个人计划：今日负载">
      <span aria-hidden style={{ ...DOT, background: color }} />
      <span>{text}</span>
    </div>
  )
}

/**
 * 注册徽章与面板。
 * @param ctx - 客户端上下文，`slots` 由 inject 保证可用。
 */
export function apply(ctx: any): void {
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'planner', order: 20 },
    PlannerBadge,
  ))
  ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: 'planner', order: 20, label: '计划' },
    PlannerView,
  ))
}
