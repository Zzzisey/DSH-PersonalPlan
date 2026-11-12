import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPlannerRepo,
  openForTest,
} from './helpers/repoHarness.ts'
import { createRouteHarness } from './helpers/routeHarness.ts'
import { PlannerService } from '../src/host/planner-service.ts'
import { BUILD_ID, BUILD_VERSION } from '../src/generated/build-info.ts'

test('month / day 路由返回 legacy 日历口径', async () => {
  const db = openForTest()
  const server = await createRouteHarness(db)
  try {
    const repo = createPlannerRepo(db)
    const goal = repo.createGoal({ title: '路由目标', deadline: '2026-11-30' })
    repo.createTask({ goalId: goal.id, title: '待完成', day: '2026-11-10', estMinutes: 60 })
    const done = repo.createTask({ goalId: goal.id, title: '已完成', day: '2026-11-10', estMinutes: 45 })
    const dropped = repo.createTask({ goalId: goal.id, title: '已放弃', day: '2026-11-10', estMinutes: 30 })
    repo.updateTasks([{ id: done.id, status: 'done' }, { id: dropped.id, status: 'dropped' }])

    const monthResponse = await server.request({ path: '/personal-planner/api/month?month=2026-11' })
    assert.equal(monthResponse.status, 200)
    assert.equal(monthResponse.headers['cache-control'], 'no-store')
    const month = monthResponse.body as {
      ok: boolean
      month: string
      days: Array<{ day: string; planned: number; count: number }>
      goals: Array<{ id: string; done: number; total: number }>
    }
    assert.equal(month.ok, true)
    assert.equal(month.month, '2026-11')
    assert.deepEqual(
      { ...month.days.find((entry) => entry.day === '2026-11-10')! },
      { day: '2026-11-10', planned: 60, limit: 240, count: 2, inMonth: true },
    )
    assert.equal(month.goals.find((entry) => entry.id === goal.id)?.done, 1)
    assert.equal(month.goals.find((entry) => entry.id === goal.id)?.total, 2, 'dropped 默认不进入 legacy 查询')

    const dayResponse = await server.request({ path: '/personal-planner/api/day?day=2026-11-10' })
    assert.equal(dayResponse.status, 200)
    const day = dayResponse.body as { planned: number; tasks: Array<{ title: string }> }
    assert.equal(day.planned, 60)
    assert.deepEqual(day.tasks.map((task) => task.title), ['待完成', '已完成'])

    const invalid = await server.request({ path: '/personal-planner/api/day?day=11-10-2026' })
    assert.equal(invalid.status, 400)
    assert.deepEqual(invalid.body, { ok: false, error: '需要 day=YYYY-MM-DD' })
  } finally {
    await server.close()
    db.close()
  }
})

test('ping returns the generated package version and git build id', async () => {
  const db = openForTest()
  const server = await createRouteHarness(db)
  try {
    const response = await server.request({ path: '/personal-planner/api/ping' })
    assert.equal(response.status, 200)
    const body = response.body as { version: string; build: string }
    assert.equal(body.version, BUILD_VERSION)
    assert.equal(body.build, BUILD_ID)
    assert.match(body.build, /^0\.2\.0\+[0-9a-f]{8}(?:\.dirty)?$/)
  } finally {
    await server.close()
    db.close()
  }
})

test('proposal preview API authenticates by token and commits the exact revision', async () => {
  const db = openForTest()
  const repo = createPlannerRepo(db)
  const service = new PlannerService(repo)
  const server = await createRouteHarness(db, service)
  try {
    const goal = service.createGoal({ title: '发布', acceptanceCriteria: '发布成功', deadline: '2026-11-30' })
    const started = service.startCreateProposal('route-session', goal.id)
    const structure = service.advanceStructure('route-session', started.id, 0, { phases: [{ title: '交付', acceptanceCriteria: '验收', seq: 1, tasks: [{ title: '发布成品', priority: 'P0', seq: 1 }] }] })
    assert.equal(structure.status, 'accepted')
    if (structure.status !== 'accepted') return
    const taskId = structure.proposal.candidate.phases[0]!.tasks[0]!.localId
    service.advanceEstimate('route-session', started.id, 1, { tasks: [{ taskLocalId: taskId, estMinutes: 30 }] })
    const ready = service.advanceSchedule('route-session', started.id, 2, { tasks: [{ taskLocalId: taskId, day: '2026-11-20' }], orderingConstraints: [] })
    assert.equal(ready.status, 'ready_for_preview')
    if (ready.status !== 'ready_for_preview') return
    const query = `/personal-planner/api/proposal/preview?proposal=${encodeURIComponent(started.id)}&revision=3&month=2026-11&token=${encodeURIComponent(ready.previewToken)}`
    const preview = await server.request({ path: query })
    assert.equal(preview.status, 200)
    const committed = await server.request({ method: 'POST', path: '/personal-planner/api/proposal/commit', body: { proposalId: started.id, revision: 3, token: ready.previewToken } })
    assert.equal(committed.status, 200)
    const repeated = await server.request({ method: 'POST', path: '/personal-planner/api/proposal/commit', body: { proposalId: started.id, revision: 3, token: ready.previewToken } })
    assert.equal(repeated.status, 409)
  } finally {
    await server.close()
    db.close()
  }
})

test('PATCH tasks 成功，并在整批任一任务不存在时全部回滚', async () => {
  const db = openForTest()
  const server = await createRouteHarness(db)
  try {
    const repo = createPlannerRepo(db)
    const first = repo.createTask({ title: 'A', day: '2026-11-10', estMinutes: 60 })
    const second = repo.createTask({ title: 'B', day: '2026-11-11', estMinutes: 30 })
    const success = await server.request({
      method: 'PATCH',
      path: '/personal-planner/api/tasks',
      body: [{ id: first.id, status: 'done', day: '2026-11-12' }],
    })
    assert.equal(success.status, 200)
    const successBody = success.body as { ok: boolean; tasks: Array<{ id: string; status: string; day: string }> }
    assert.equal(successBody.ok, true)
    assert.deepEqual(
      { id: successBody.tasks[0]!.id, status: successBody.tasks[0]!.status, day: successBody.tasks[0]!.day },
      { id: first.id, status: 'done', day: '2026-11-12' },
    )

    const failed = await server.request({
      method: 'PATCH',
      path: '/personal-planner/api/tasks',
      body: [
        { id: first.id, day: '2026-11-20' },
        { id: 't_missing', day: '2026-11-20' },
      ],
    })
    assert.equal(failed.status, 400)
    assert.match((failed.body as { error: string }).error, /t_missing/)
    assert.equal(repo.getTask(first.id)?.day, '2026-11-12')
    assert.equal(repo.getTask(first.id)?.status, 'done')
    assert.equal(repo.getTask(second.id)?.day, '2026-11-11')
  } finally {
    await server.close()
    db.close()
  }
})

test('PUT capacity 校验、持久化并返回当前月份容量报告', async () => {
  const db = openForTest()
  const server = await createRouteHarness(db)
  try {
    const repo = createPlannerRepo(db)
    const updated = await server.request({
      method: 'PUT',
      path: '/personal-planner/api/capacity',
      body: {
        weekdayMinutes: 180,
        weekendMinutes: 90,
        overrides: { '2026-11-14': 60 },
      },
    })
    assert.equal(updated.status, 200)
    const body = updated.body as { ok: boolean; capacity: unknown; report: { verdict: string } }
    assert.equal(body.ok, true)
    assert.deepEqual(body.capacity, { weekdayMinutes: 180, weekendMinutes: 90, overrides: { '2026-11-14': 60 } })
    assert.deepEqual(repo.getCapacity(), body.capacity)
    assert.equal(typeof body.report.verdict, 'string')

    const invalid = await server.request({
      method: 'PUT',
      path: '/personal-planner/api/capacity',
      body: { weekdayMinutes: 10, weekendMinutes: 90, overrides: {} },
    })
    assert.equal(invalid.status, 400)
    assert.equal(repo.getCapacity().weekdayMinutes, 180, '非法容量不能覆盖上一份设置')
  } finally {
    await server.close()
    db.close()
  }
})

test('路由拒绝非回环地址、非本机 Host 与跨站 Origin', async () => {
  const db = openForTest()
  const server = await createRouteHarness(db)
  try {
    const remote = await server.request({
      path: '/personal-planner/api/ping',
      remoteAddress: '192.0.2.10',
    })
    assert.equal(remote.status, 403)
    assert.deepEqual(remote.body, { ok: false, error: 'forbidden: loopback only' })

    const badHost = await server.request({
      path: '/personal-planner/api/ping',
      headers: { host: 'planner.example' },
    })
    assert.equal(badHost.status, 403)
    assert.deepEqual(badHost.body, { ok: false, error: 'forbidden: loopback only' })

    const crossSite = await server.request({
      path: '/personal-planner/api/ping',
      headers: { origin: 'https://planner.example' },
    })
    assert.equal(crossSite.status, 403)
  } finally {
    await server.close()
    db.close()
  }
})
