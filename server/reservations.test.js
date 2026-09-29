// 预约模块并发一致性与异常恢复测试：
// 幂等请求 / 失败回滚 / 库存原子校验 / 重复退款与重复核销防护
// 运行：node --test server/reservations.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')

// ---- 测试上下文：记录财务流水与投诉，替代 index.js 的真实实现 ----
const finLogs = []
const complaints = []
const realLogFinance = (day, label, amount, detail) => finLogs.push({ day, label, amount, detail })
RSV.initReservationContext({
  logFinance: realLogFinance,
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } }
})

const cash = () => Number(getSetting('cash'))
const slotById = id => db.prepare('SELECT * FROM reservation_slots WHERE id=?').get(id)
const rsvById = id => db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
const rsvCount = () => db.prepare('SELECT COUNT(*) n FROM reservations').get().n
const entrySlot = (day, hour) => db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?").get(day, hour)

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 100000)
  setSetting('ticket', 100)
  RSV.ensureSlots()
})

test('下单幂等：同一 requestId 重复提交只建一单、只扣一次库存、只收一次款', () => {
  const s = entrySlot(1, 10)
  const before = { cash: cash(), booked: slotById(s.id).booked_count, orders: rsvCount() }
  const p = { scope: 'entry', slotId: s.id, qty: 2, guest_name: '幂等测试', requestId: 't1-create-1' }

  const r1 = RSV.createReservation(p)
  const r2 = RSV.createReservation(p)   // 网络重试/双击重放

  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true, '第二次应命中幂等缓存')
  assert.equal(r2.code, r1.code, '重放应返回同一预约号')
  assert.equal(rsvCount(), before.orders + 1, '只应创建一张预约单')
  assert.equal(cash(), before.cash + 200, '预收款只入账一次')
  assert.equal(slotById(s.id).booked_count, before.booked + 2, '库存只扣减一次')
})

test('库存校验：余量不足时下单失败（SLOT_FULL），库存/现金/订单零残留', () => {
  const s = entrySlot(1, 11)
  db.prepare('UPDATE reservation_slots SET capacity=1, oversell=0, booked_count=0 WHERE id=?').run(s.id)
  const before = { cash: cash(), orders: rsvCount() }

  const r = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, requestId: 't2-full-1' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SLOT_FULL')
  assert.equal(slotById(s.id).booked_count, 0, '库存不得被扣减')
  assert.equal(cash(), before.cash, '现金不得变化')
  assert.equal(rsvCount(), before.orders, '不得产生预约单')

  // 时段关闭后下单返回 SLOT_CLOSED
  db.prepare("UPDATE reservation_slots SET status='closed' WHERE id=?").run(s.id)
  const r2 = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, requestId: 't2-closed-1' })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'SLOT_CLOSED')
  db.prepare("UPDATE reservation_slots SET status='open', capacity=400, oversell=20 WHERE id=?").run(s.id)
})

test('失败回滚：事务中途异常（流水写入失败）→ 订单/库存/现金/流水全部回滚', () => {
  const s = entrySlot(1, 12)
  const before = { cash: cash(), booked: slotById(s.id).booked_count, orders: rsvCount(), fin: finLogs.length }

  // 注入会在事务中段抛错的流水函数
  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟流水写入失败') } })
  const r = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, requestId: 't3-tx-1' })
  RSV.initReservationContext({ logFinance: realLogFinance })

  assert.equal(r.ok, false)
  assert.equal(r.code, 'TX_FAILED')
  assert.equal(rsvCount(), before.orders, '订单必须回滚')
  assert.equal(slotById(s.id).booked_count, before.booked, '库存必须回滚')
  assert.equal(cash(), before.cash, '现金必须回滚')
  assert.equal(finLogs.length, before.fin, '流水不得残留')

  // 系统异常不缓存：同一 requestId 修复后可安全重试成功
  const retry = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, requestId: 't3-tx-1' })
  assert.equal(retry.ok, true, 'TX_FAILED 不缓存，同键重试应能成功')
  assert.equal(rsvCount(), before.orders + 1)
})

test('重复退款：状态条件更新防重 + 同键重放返回首次结果，现金只退一次', () => {
  const s = entrySlot(2, 10)   // 明天时段：全额退
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, requestId: 't4-book-1' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  const c1 = RSV.cancelReservation(book.id, 't4-cancel-1')
  assert.equal(c1.ok, true)
  assert.equal(c1.back, 200, '未来时段全额退')
  assert.equal(cash(), cashAfterBook - 200)

  const c2 = RSV.cancelReservation(book.id, 't4-cancel-1')   // 同键重放
  assert.equal(c2.ok, true)
  assert.equal(c2.replay, true)
  assert.equal(c2.back, c1.back)
  assert.equal(cash(), cashAfterBook - 200, '重放不得重复扣款')

  const c3 = RSV.cancelReservation(book.id, 't4-cancel-2')   // 不同键：状态冲突
  assert.equal(c3.ok, false)
  assert.equal(c3.code, 'RSV_STATUS_CONFLICT')
  assert.equal(cash(), cashAfterBook - 200, '现金不得二次扣减')

  // 直接重复退款：返回首次退款留痕（幂等 dup），现金不变
  const dup = RSV.refundReservation(book.id, 'guest')
  assert.equal(dup.ok, true)
  assert.equal(dup.dup, true)
  assert.equal(dup.back, 200)
  assert.equal(cash(), cashAfterBook - 200)

  // 退款金额留痕可对账
  const row = rsvById(book.id)
  assert.equal(row.refund_amount, 200)
  assert.equal(row.refund_fee, 0)
})

test('改签原子性：目标满员改签失败原库存不动；成功改签库存精确转移且可幂等重放', () => {
  const a = entrySlot(2, 14)
  const b = entrySlot(2, 15)
  const book = RSV.createReservation({ scope: 'entry', slotId: a.id, qty: 3, requestId: 't5-book-1' })
  assert.equal(book.ok, true)
  const aBooked0 = slotById(a.id).booked_count
  const bBooked0 = slotById(b.id).booked_count

  // 目标时段塞满 → 改签失败，原时段库存与单据不动
  db.prepare('UPDATE reservation_slots SET capacity=0, oversell=0 WHERE id=?').run(b.id)
  const f = RSV.rescheduleReservation(book.id, b.id, 't5-rs-1')
  assert.equal(f.ok, false)
  assert.equal(f.code, 'SLOT_FULL')
  assert.equal(slotById(a.id).booked_count, aBooked0, '原时段库存不得变化')
  assert.equal(rsvById(book.id).slot_id, a.id, '单据仍挂原时段')

  // 恢复容量 → 改签成功，库存精确转移
  db.prepare('UPDATE reservation_slots SET capacity=400, oversell=20 WHERE id=?').run(b.id)
  const ok = RSV.rescheduleReservation(book.id, b.id, 't5-rs-2')
  assert.equal(ok.ok, true)
  assert.equal(slotById(a.id).booked_count, aBooked0 - 3, '原时段释放')
  assert.equal(slotById(b.id).booked_count, bBooked0 + 3, '新时段占用')
  assert.equal(rsvById(book.id).slot_id, b.id)
  assert.equal(rsvById(book.id).reschedules, 1)

  // 同键重放：返回首次结果，库存不二次转移
  const replay = RSV.rescheduleReservation(book.id, b.id, 't5-rs-2')
  assert.equal(replay.ok, true)
  assert.equal(replay.replay, true)
  assert.equal(slotById(a.id).booked_count, aBooked0 - 3)
  assert.equal(slotById(b.id).booked_count, bBooked0 + 3)
})

test('核销幂等：重复扫码不重复放行；不同请求号返回状态冲突', () => {
  setSetting('hour', 10)
  const s = entrySlot(1, 10)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, requestId: 't6-book-1' })
  assert.equal(book.ok, true)
  const checked0 = slotById(s.id).checked_count

  const k1 = RSV.checkinReservation(book.id, 't6-ck-1')
  assert.equal(k1.ok, true)
  assert.equal(slotById(s.id).checked_count, checked0 + 2)

  const k2 = RSV.checkinReservation(book.id, 't6-ck-1')   // 同键重放
  assert.equal(k2.ok, true)
  assert.equal(k2.replay, true)

  const k3 = RSV.checkinReservation(book.id, 't6-ck-2')   // 不同键：冲突
  assert.equal(k3.ok, false)
  assert.equal(k3.code, 'RSV_STATUS_CONFLICT')
  assert.equal(slotById(s.id).checked_count, checked0 + 2, '核销计数不得重复累加')
})

test('超售核销：本场容量已满自动改签后续时段，库存原子转移', () => {
  setSetting('hour', 11)
  const s = entrySlot(1, 12)
  // 本场真实容量 2，且已核销满员；超售额度允许再约 1 人
  db.prepare('UPDATE reservation_slots SET capacity=2, oversell=5, booked_count=0, checked_count=2 WHERE id=?').run(s.id)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, requestId: 't7-book-1' })
  assert.equal(book.ok, true, '超售额度内可下单')

  setSetting('hour', 12)
  const r = RSV.checkinReservation(book.id, 't7-ck-1')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'OVERBOOK_AUTO_RESCHEDULED', '容量已满应自动改签后续时段')
  const row = rsvById(book.id)
  assert.equal(row.status, 'booked', '改签后仍为在途预约')
  assert.equal(row.slot_hour, 13, '改签到下一时段')
  assert.equal(row.reschedules, 1)
  assert.equal(slotById(s.id).booked_count, 0, '原时段库存释放')
  const moved = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=1 AND hour=13").get()
  assert.equal(moved.booked_count, 1, '新时段库存占用')
  // 恢复
  db.prepare("UPDATE reservation_slots SET capacity=400, oversell=20, checked_count=0 WHERE id=?").run(s.id)
})

test('自动核销容错：批量处理返回结构完整，正常单被核销入账', () => {
  setSetting('hour', 13)
  const s = entrySlot(1, 14)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 4, source: 'manual', requestId: 't8-book-1' })
  assert.equal(book.ok, true)
  setSetting('hour', 14)
  const r = RSV.autoCheckin(14)
  assert.equal(typeof r.entry, 'number')
  assert.ok(r.ride instanceof Map)
  assert.equal(r.errors, 0, '正常批量处理不应有失败单')
  assert.ok(r.entry >= 4, 'manual 来源必到场，应计入入园人数')
  assert.equal(rsvById(book.id).status, 'checked')
  setSetting('hour', 9)
})

test('爽约批处理：过时段未核销标记 noshow 且预收款没收，不重复处理', () => {
  setSetting('hour', 15)
  const s = entrySlot(1, 15)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, requestId: 't9-book-1' })
  assert.equal(book.ok, true)
  const fin0 = finLogs.length

  setSetting('hour', 16)
  const q1 = RSV.expireNoShow(16)
  assert.ok(q1 >= 2, '爽约人数应包含本单（含前序用例遗留过时段单）')
  assert.equal(rsvById(book.id).status, 'noshow')
  assert.ok(finLogs.slice(fin0).some(f => f.label === '违约' && f.amount === 200), '预收款没收记入违约')

  const q2 = RSV.expireNoShow(16)   // 重复执行不得重复没收
  assert.equal(q2, 0)
  setSetting('hour', 9)
})
