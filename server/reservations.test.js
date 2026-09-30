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

// ---- 超售退款事务失败：不虚报 / 不被爽约误伤 / 异常重试可恢复 ----
test('超售异常恢复：自动核销退款失败不计数为安置/退款，保持待核销并挂起，重试后原子补退', () => {
  setSetting('hour', 16)
  // 17 点是本场超售时段；关闭所有更晚入园时段，迫使走「无法改签→全额退款」分支
  const s17 = entrySlot(1, 17)
  db.prepare('UPDATE reservation_slots SET status=? WHERE day=1 AND hour IN (16,18) AND scope=?')
    .run('closed', 'entry')
  db.prepare('UPDATE reservation_slots SET status=? WHERE day IN (2,3) AND scope=?').run('closed', 'entry')
  db.prepare('UPDATE reservation_slots SET capacity=0, oversell=2, booked_count=0, checked_count=0 WHERE id=?').run(s17.id)

  const book = RSV.createReservation({ scope: 'entry', slotId: s17.id, qty: 1, source: 'manual', requestId: 't10-book-1' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  // ① 退款事务在资金流水环节失败（整体回滚）
  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟退款流水写入失败') } })
  setSetting('hour', 17)
  const r = RSV.autoCheckin(17)
  RSV.initReservationContext({ logFinance: realLogFinance })

  // 批处理结果如实：不记为已安置/已退款；挂起单独计数并计入失败
  assert.equal(r.refunded, 0, '退款失败不得计入已退款人数')
  assert.equal(r.moved, 0)
  assert.equal(r.displaced, 0, 'displaced 不得包含失败单')
  assert.equal(r.pending, 1, '失败单计入挂起人数')
  assert.equal(r.pendingNew, 1)
  assert.ok(r.errors >= 1)

  // 资金流水 / 库存 / 单据三者一致：现金未退、名额未释放、预约仍待核销
  assert.equal(cash(), cashAfterBook, '退款回滚，现金不得减少')
  assert.equal(rsvById(book.id).status, 'booked', '预约必须保持待核销')
  assert.equal(slotById(s17.id).refund_count, 0, 'refund_count 不得累加')
  assert.equal(slotById(s17.id).booked_count, 1, 'booked_count 不得释放')
  const pendingRow = db.prepare("SELECT * FROM reservation_pending_actions WHERE reservation_id=? AND status='pending'").get(book.id)
  assert.ok(pendingRow, '必须持久化挂起记录，供异常重试')
  assert.ok(pendingRow.last_error.includes('TX_FAILED'))

  // ② 爽约扫描不得把园方超售欠退款的单按爽约没收（否则欠款变违约金、虚报收入）
  setSetting('hour', 18)
  const finBefore = finLogs.length
  const noshowQty = RSV.expireNoShow(18)
  assert.equal(noshowQty, 0, '挂起补退单不得被爽约没收')
  assert.equal(rsvById(book.id).status, 'booked', '爽约扫描后仍保持待核销')
  assert.ok(!finLogs.slice(finBefore).some(f => f.label === '违约'), '不得产生爽约违约收入')
  assert.equal(cash(), cashAfterBook)

  // ③ 补偿队列重试：仍无更晚时段可改签，执行真正的全额退款（同事务完成资金/库存/投诉/状态）
  const complaintsBefore = complaints.length
  const retry = RSV.retryPendingOverbookRefunds()
  assert.equal(retry.recovered, 1)
  assert.equal(retry.qty, 1)
  assert.equal(retry.amount, 100, '按原预收款全额补退')
  assert.equal(retry.remaining, 0)
  assert.equal(rsvById(book.id).status, 'refunded')
  assert.equal(rsvById(book.id).reason, 'overbook')
  assert.equal(rsvById(book.id).refund_amount, 100)
  assert.equal(cash(), cashAfterBook - 100, '现金真正退回')
  assert.equal(slotById(s17.id).refund_count, 1)
  assert.equal(slotById(s17.id).booked_count, 0, '名额释放')
  assert.ok(finLogs.slice(finBefore).some(f => f.label === '门票' && f.amount === -100), '退款流水留痕')
  assert.ok(complaints.length > complaintsBefore, '补退时补齐超售投诉工单')
  assert.equal(db.prepare("SELECT status FROM reservation_pending_actions WHERE reservation_id=?").get(book.id).status, 'done', '补退成功应置 done')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reservation_pending_actions WHERE reservation_id=? AND status='pending'").get(book.id).n, 0)

  // 再次重试幂等：不得二次退款
  const retry2 = RSV.retryPendingOverbookRefunds()
  assert.equal(retry2.recovered, 0)
  assert.equal(cash(), cashAfterBook - 100, '现金不得二次扣减')

  // 恢复现场
  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='entry' AND (day IN (2,3) OR (day=1 AND hour IN (16,18)))").run()
  db.prepare('UPDATE reservation_slots SET capacity=400, oversell=20 WHERE id=?').run(s17.id)
  setSetting('hour', 9)
})

test('超售异常恢复：挂起单被人工退款处置后补退自动作废，绝不二次退款', () => {
  setSetting('hour', 15)
  const s = entrySlot(1, 17)
  // 关闭 18 点及次日/后日所有入园时段，确保无更晚可改签时段 → 走全额退款分支
  db.prepare("UPDATE reservation_slots SET status='closed' WHERE scope='entry' AND (day=1 AND hour>=18 OR day>=2)").run()
  db.prepare('UPDATE reservation_slots SET capacity=0, oversell=2, booked_count=0, checked_count=0 WHERE id=?').run(s.id)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, source: 'manual', requestId: 't11-book-1' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  // 制造挂起
  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟退款流水写入失败') } })
  setSetting('hour', 17)
  const r = RSV.autoCheckin(17)
  RSV.initReservationContext({ logFinance: realLogFinance })
  assert.equal(r.pendingNew, 1)
  assert.equal(cash(), cashAfterBook)

  // 人工/其他途径先完成了全额退款（同事务会把挂起记录置 obsolete）
  const manual = RSV.refundReservation(book.id, 'overbook', '人工补退')
  assert.equal(manual.ok, true)
  assert.equal(cash(), cashAfterBook - 100)
  const p = db.prepare("SELECT status FROM reservation_pending_actions WHERE reservation_id=?").get(book.id)
  assert.equal(p.status, 'obsolete', '退款成功应同步作废挂起记录')

  // 引擎重试不得二次退款
  const retry = RSV.retryPendingOverbookRefunds()
  assert.equal(retry.recovered, 0)
  assert.equal(cash(), cashAfterBook - 100, '现金不得二次扣减')
  assert.equal(rsvById(book.id).refund_amount, 100)

  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='entry' AND (day=1 AND hour>=18 OR day>=2)").run()
  db.prepare('UPDATE reservation_slots SET capacity=400, oversell=20 WHERE id=?').run(s.id)
  setSetting('hour', 9)
})

test('人工核销超售：退款事务失败时如实返回 TX_FAILED（不虚报已退款金额），并挂起可重试', () => {
  setSetting('hour', 17)
  const s = entrySlot(1, 18)
  // 关闭次日/后日所有入园时段，确保 18 点超售时无更晚可改签时段 → 走全额退款分支
  db.prepare("UPDATE reservation_slots SET status='closed' WHERE scope='entry' AND day>=2").run()
  db.prepare('UPDATE reservation_slots SET capacity=0, oversell=2, booked_count=0, checked_count=0 WHERE id=?').run(s.id)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, requestId: 't12-book-1' })
  assert.equal(book.ok, true)
  const cashAfterBook = cash()

  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟退款流水写入失败') } })
  setSetting('hour', 18)
  const r = RSV.checkinReservation(book.id, 't12-ck-1')
  RSV.initReservationContext({ logFinance: realLogFinance })

  assert.equal(r.ok, false)
  assert.equal(r.code, 'TX_FAILED', '必须如实告知退款未生效，不得返回 OVERBOOK_REFUNDED')
  assert.ok(!String(r.msg).includes('¥0'), '不得谎报已退款 ¥0')
  assert.equal(rsvById(book.id).status, 'booked', '预约保持待核销')
  assert.equal(cash(), cashAfterBook, '现金未退')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reservation_pending_actions WHERE reservation_id=? AND status='pending'").get(book.id).n, 1)

  // 恢复后重试：引擎补退成功
  const retry = RSV.retryPendingOverbookRefunds()
  assert.equal(retry.recovered, 1)
  assert.equal(retry.amount, 100)
  assert.equal(rsvById(book.id).status, 'refunded')
  assert.equal(cash(), cashAfterBook - 100)

  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='entry' AND day>=2").run()
  db.prepare('UPDATE reservation_slots SET capacity=400, oversell=20 WHERE id=?').run(s.id)
  setSetting('hour', 9)
})

test('引擎跨小时恢复：失败当时不虚报不没收，下一小时按 补退→爽约 顺序自动恢复', () => {
  // 复刻 index.js tick 顺序：retryPendingOverbookRefunds() → expireNoShow(h) → autoCheckin(h)
  setSetting('hour', 15)
  const s = entrySlot(1, 16)
  db.prepare("UPDATE reservation_slots SET status='closed' WHERE scope='entry' AND (day=1 AND hour>=17 OR day>=2)").run()
  db.prepare('UPDATE reservation_slots SET capacity=0, oversell=2, booked_count=0, checked_count=0 WHERE id=?').run(s.id)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 2, source: 'manual', requestId: 't13-book-1' })
  assert.equal(book.ok, true)
  const cashBase = cash()
  const fin0 = finLogs.length

  // —— 第 1 小时：补退（空）→ 爽约（无过期）→ 核销（超售退款事务失败，挂起）——
  setSetting('hour', 16)
  const rec1 = RSV.retryPendingOverbookRefunds()
  assert.equal(rec1.remaining, 0)
  assert.equal(RSV.expireNoShow(16), 0)
  RSV.initReservationContext({ logFinance: () => { throw new Error('模拟退款流水写入失败') } })
  const arr = RSV.autoCheckin(16)
  RSV.initReservationContext({ logFinance: realLogFinance })
  assert.equal(arr.displaced, 0, '失败当小时不得统计为已安置/退款')
  assert.equal(arr.pending, 2)
  assert.equal(arr.pendingNew, 1)
  assert.equal(cash(), cashBase, '现金未动')
  assert.equal(rsvById(book.id).status, 'booked')
  assert.ok(!finLogs.slice(fin0).some(f => f.label === '违约'), '失败当时无任何爽约没收')

  // —— 第 2 小时：资金服务仍故障 —— 补退重试失败，但爽约扫描仍不得没收 ——
  setSetting('hour', 17)
  RSV.initReservationContext({ logFinance: () => { throw new Error('退款流水仍失败') } })
  const rec2 = RSV.retryPendingOverbookRefunds()
  RSV.initReservationContext({ logFinance: realLogFinance })
  assert.equal(rec2.failed, 1)
  assert.equal(rec2.remaining, 1)
  assert.equal(RSV.expireNoShow(17), 0, '持续失败期间不得按爽约没收（不产生虚假违约收入）')
  assert.equal(rsvById(book.id).status, 'booked')
  assert.equal(cash(), cashBase)

  // —— 第 3 小时：资金恢复，补退成功；之后爽约扫描不再触及该单 ——
  setSetting('hour', 18)
  const complaintsBefore = complaints.length
  const rec3 = RSV.retryPendingOverbookRefunds()
  assert.equal(rec3.recovered, 1)
  assert.equal(rec3.qty, 2)
  assert.equal(rec3.amount, 200)
  assert.equal(rec3.remaining, 0)
  assert.equal(RSV.expireNoShow(18), 0, '已补退单不会再进爽约')
  assert.equal(rsvById(book.id).status, 'refunded')
  assert.equal(rsvById(book.id).refund_amount, 200)
  assert.equal(cash(), cashBase - 200, '现金一次性退回，无重复无遗漏')
  assert.equal(slotById(s.id).refund_count, 2)
  assert.equal(slotById(s.id).booked_count, 0, '名额正确释放')
  assert.ok(finLogs.slice(fin0).some(f => f.label === '门票' && f.amount === -200), '补退流水留痕')
  assert.ok(!finLogs.slice(fin0).some(f => f.label === '违约' && f.amount > 0), '全程不得产生违约没收收入')
  assert.ok(complaints.length > complaintsBefore, '补齐投诉工单')

  // 现场恢复
  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='entry' AND (day=1 AND hour>=17 OR day>=2)").run()
  db.prepare('UPDATE reservation_slots SET capacity=400, oversell=20 WHERE id=?').run(s.id)
  setSetting('hour', 9)
})
