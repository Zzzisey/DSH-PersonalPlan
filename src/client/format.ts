/** 纯格式化函数；不碰 React、不碰网络。 */

const MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 今天的本地日期字符串 `YYYY-MM-DD`。 */
export function todayStr(): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

/** `2026-10` → `2026 年 10 月`。 */
export function monthLabel(month: string): string {
  const [year, index] = month.split('-')
  const name = MONTHS[Number(index) - 1] ?? index
  return `${year} 年 ${name} 月`
}

/** 月份加减，返回 `YYYY-MM`。 */
export function shiftMonth(month: string, amount: number): string {
  const [yearRaw, indexRaw] = month.split('-')
  const date = new Date(Date.UTC(Number(yearRaw), Number(indexRaw) - 1 + amount, 1))
  return date.toISOString().slice(0, 7)
}

/** `2026-10-30` → `10 月 30 日 周四`。 */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  const weekday = WEEKDAYS[(date.getUTCDay() + 6) % 7]
  return `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日 周${weekday}`
}

/** 日期加减天数。 */
export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

/** 负载配色：正常用主题蓝，接近上限用警示色，超载用错误色。 */
export function loadColor(planned: number, limit: number): string {
  if (limit <= 0) return 'var(--dsw-alias-border-l1)'
  const ratio = planned / limit
  if (ratio > 1) return 'var(--dsw-alias-state-error-primary)'
  if (ratio >= 0.85) return 'var(--dsw-alias-state-warning-primary)'
  return 'var(--dsw-alias-state-business-primary)'
}

/** 负载条宽度百分比（超载也按 100% 显示，颜色说明问题）。 */
export function loadWidth(planned: number, limit: number): string {
  if (limit <= 0) return '0%'
  return `${Math.min(100, Math.round((planned / limit) * 100))}%`
}
