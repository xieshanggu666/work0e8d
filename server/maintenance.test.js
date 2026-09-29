// 设施停运联动原子性测试：
// 报修停运 = 建工单 + 设施停运 + 关停时段 + 在途预约批量退款 + 投诉，同一事务提交；
// 联动任一步失败整体回滚（不留"停运了但款没退"的半完成状态），完工/撤销恢复同理
// 运行：node --test server/maintenance.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const MAINT = await import('./maintenance.js')

// ---- 测试上下文：记录财务流水与投诉，可注入故障 ----
const finLogs = []
const complaints = []
let failOnRefundFinance = false   // 退款流水写入失败（模拟嵌套事务中段异常）
let failOnComplaint = false       // 投诉建单失败
let failOnReopen = false          // 恢复运营联动失败
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => {
    if (failOnRefundFinance && amount < 0) throw new Error('模拟退款流水写入失败')
    finLogs.push({ day, label, amount, detail })
  },
  createComplaint: p => {
    if (failOnComplaint) throw new Error('模拟投诉建单失败')
    complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') }
  }
})
MAINT.initMaintenanceContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  syncRideSlots: ride => {
    if (failOnReopen && ride.status === 'operating') return { ok: false, code: 'TX_FAILED', msg: '模拟重开时段失败' }
    return RSV.syncRideSlots(ride)
  },
  linkComplaintsToRide: () => {}
})

const cash = () => Number(getSetting('cash'))
const rideById = id => db.prepare('SELECT * FROM rides WHERE id=?').get(id)
const rsvById = id => db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
const slotById = id => db.prepare('SELECT * FROM reservation_slots WHERE id=?').get(id)
const openOrders = () => db.prepare("SELECT * FROM maintenance_orders WHERE status IN ('queued','processing')").all()
const openOrderOf = rideId => db.prepare("SELECT * FROM maintenance_orders WHERE ride_id=? AND status IN ('queued','processing')").get(rideId)
const rideSlot = (rideId, day, hour) =>
  db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND day=? AND hour=?").get(rideId, day, hour)

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 100000)
  setSetting('ticket', 100)
  RSV.ensureSlots()
})

test('报修停运联动：工单+停运+关时段+批量退款+投诉同一事务全部生效', () => {
  const s1 = rideSlot(1, 2, 10)
  const s2 = rideSlot(1, 2, 11)
  const b1 = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s1.id, qty: 3, requestId: 'm1-b1' })
  const b2 = RSV.createReservation({ scope: 'ride', rideId: 1, slotId: s2.id, qty: 2, requestId: 'm1-b2' })
  assert.equal(b1.ok, true); assert.equal(b2.ok, true)
  const cash0 = cash()
  const complaints0 = complaints.length

  const r = MAINT.createMaintenanceOrder(1, 'manual')
  assert.equal(r.ok, true)
  assert.ok(r.code.startsWith('WX'))

  assert.equal(rideById(1).status, 'maintenance', '设施应转入检修停运')
  assert.equal(slotById(s1.id).status, 'closed', '未来时段应关停')
  assert.equal(rsvById(b1.id).status, 'refunded', '在途预约应退款')
  assert.equal(rsvById(b1.id).reason, 'park')
  assert.equal(rsvById(b2.id).status, 'refunded')
  const refundSum = rsvById(b1.id).refund_amount + rsvById(b2.id).refund_amount
  assert.equal(cash(), cash0 - refundSum, '现金应按退款总额扣减')
  assert.ok(finLogs.some(f => f.amount === -rsvById(b1.id).refund_amount), '退款流水应入账')
  assert.equal(complaints.length, complaints0 + 1, '应生成设施故障投诉')
  assert.equal(openOrders().length, 1, '应有一个在途工单')
})

test('停运联动回滚：退款中段失败 → 工单/停运/关时段/退款/投诉整体回滚并返回失败', () => {
  const s = rideSlot(2, 2, 10)
  const b = RSV.createReservation({ scope: 'ride', rideId: 2, slotId: s.id, qty: 2, requestId: 'm2-b1' })
  assert.equal(b.ok, true)
  const cash0 = cash()
  const complaints0 = complaints.length

  failOnRefundFinance = true
  const r = MAINT.createMaintenanceOrder(2, 'manual')
  failOnRefundFinance = false

  assert.equal(r.ok, false, '联动失败必须返回失败而非假成功')
  assert.equal(rideById(2).status, 'operating', '设施状态应回滚为运营中')
  assert.equal(slotById(s.id).status, 'open', '时段应回滚为开放')
  assert.equal(rsvById(b.id).status, 'booked', '预约应回滚为在途')
  assert.equal(rsvById(b.id).refund_amount, 0, '不应留下退款留痕')
  assert.equal(cash(), cash0, '现金不得变化')
  assert.equal(complaints.length, complaints0, '不应生成投诉')
  assert.equal(openOrderOf(2), undefined, '设施 2 的工单应一并回滚')

  // 故障恢复后重试应成功（无残留状态阻塞）
  const retry = MAINT.createMaintenanceOrder(2, 'manual')
  assert.equal(retry.ok, true)
  assert.equal(rideById(2).status, 'maintenance')
  assert.equal(rsvById(b.id).status, 'refunded')
})

test('停运联动回滚：投诉建单失败 → 同样整体回滚', () => {
  const s = rideSlot(3, 2, 10)
  const b = RSV.createReservation({ scope: 'ride', rideId: 3, slotId: s.id, qty: 1, requestId: 'm3-b1' })
  assert.equal(b.ok, true)
  const cash0 = cash()

  failOnComplaint = true
  const r = MAINT.createMaintenanceOrder(3, 'manual')
  failOnComplaint = false

  assert.equal(r.ok, false)
  assert.equal(rideById(3).status, 'operating')
  assert.equal(slotById(s.id).status, 'open')
  assert.equal(rsvById(b.id).status, 'booked')
  assert.equal(cash(), cash0)
  assert.equal(openOrderOf(3), undefined, '设施 3 的工单应一并回滚')
})

test('完工联动：进度满自动完工 → 恢复运营+重开时段+费用结算入账', () => {
  // 设施 1 当前处于检修（首个用例遗留），指派维修工并推进到完工
  const order = openOrders().find(o => o.ride_id === 1)
  assert.ok(order, '应存在设施 1 的在途工单')
  const repairman = db.prepare("SELECT * FROM staff WHERE role='维修' AND active=1 LIMIT 1").get()
  const a = MAINT.assignMaintenanceOrder(order.id, repairman.id)
  assert.equal(a.ok, true)

  db.prepare('UPDATE maintenance_orders SET progress=99.9 WHERE id=?').run(order.id)
  const cash0 = cash()
  MAINT.processMaintenance()

  const done = db.prepare('SELECT * FROM maintenance_orders WHERE id=?').get(order.id)
  assert.equal(done.status, 'done', '工单应完工')
  assert.equal(rideById(1).status, 'operating', '设施应恢复运营')
  assert.equal(rideById(1).health, 100, '健康度应修复至 100')
  const reopened = db.prepare("SELECT COUNT(*) n FROM reservation_slots WHERE scope='ride' AND ride_id=1 AND status='open' AND day>=1").get().n
  assert.ok(reopened > 0, '可售时段应重新开放')
  assert.equal(cash(), cash0 - done.cost, '检修费用应结算扣减')
  assert.ok(finLogs.some(f => f.label === '维护' && f.amount === -done.cost), '检修费用流水应入账')
})

test('完工联动回滚 + 逐单容错：重开时段失败 → 该单回滚留在在修，不拖垮其他工单', () => {
  // 设施 2 在修（第二用例遗留），再制造设施 4 在修
  const o2 = openOrders().find(o => o.ride_id === 2)
  const repairman = db.prepare("SELECT * FROM staff WHERE role='维修' AND active=1 LIMIT 1").get()
  assert.equal(MAINT.assignMaintenanceOrder(o2.id, repairman.id).ok, true)

  const r4 = MAINT.createMaintenanceOrder(4, 'manual')
  assert.equal(r4.ok, true)
  const repairman2 = db.prepare("SELECT * FROM staff WHERE role='维修' AND active=1 AND id<>? LIMIT 1").get(repairman.id)
  assert.equal(MAINT.assignMaintenanceOrder(r4.id, repairman2.id).ok, true)

  // 两单都推进到完工线；恢复联动对全部设施注入失败 → 两单都回滚仍在修；随后恢复故障再推进即完工
  db.prepare('UPDATE maintenance_orders SET progress=99.9 WHERE id IN (?,?)').run(o2.id, r4.id)
  const cash0 = cash()
  failOnReopen = true
  MAINT.processMaintenance()   // 不抛错 = 逐单容错生效
  failOnReopen = false

  assert.equal(db.prepare('SELECT status FROM maintenance_orders WHERE id=?').get(o2.id).status, 'processing', '失败单应回滚留在在修')
  assert.equal(db.prepare('SELECT status FROM maintenance_orders WHERE id=?').get(r4.id).status, 'processing')
  assert.equal(rideById(2).status, 'maintenance', '设施不得提前恢复运营')
  assert.equal(cash(), cash0, '检修费用不得重复/提前扣减')

  MAINT.processMaintenance()   // 故障恢复后重推进，两单正常完工
  assert.equal(db.prepare('SELECT status FROM maintenance_orders WHERE id=?').get(o2.id).status, 'done')
  assert.equal(db.prepare('SELECT status FROM maintenance_orders WHERE id=?').get(r4.id).status, 'done')
  assert.equal(rideById(2).status, 'operating')
  assert.equal(rideById(4).status, 'operating')
})

test('撤销排队工单：恢复运营并重开时段，同一事务提交', () => {
  const r = MAINT.createMaintenanceOrder(5, 'manual')
  assert.equal(r.ok, true)
  assert.equal(rideById(5).status, 'maintenance')

  const c = MAINT.cancelMaintenanceOrder(r.id)
  assert.equal(c.ok, true)
  assert.equal(rideById(5).status, 'operating', '撤销后应恢复运营')
  const reopened = db.prepare("SELECT COUNT(*) n FROM reservation_slots WHERE scope='ride' AND ride_id=5 AND status='open' AND day>=1").get().n
  assert.ok(reopened > 0, '撤销后时段应重新开放')
  assert.equal(db.prepare('SELECT status FROM maintenance_orders WHERE id=?').get(r.id).status, 'cancelled')
})
