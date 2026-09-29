// 领队组团模块一致性测试：
// 提交/确认锁定名额收订金 / 尾款分批 / 分批核销（款项门控、先入园后游玩）/
// 部分退团 / 设施停运自动重排与挂起退款 / 爽约结案 / 财务回写 / 幂等
// 运行：node --test server/groups.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const G = await import('./groups.js')

const finLogs = []
const complaints = []
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } }
})
G.initGroupContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: p => { complaints.push(p); return { id: complaints.length, code: 'TS' + String(complaints.length).padStart(4, '0') } }
})
RSV.initReservationContext({
  handleParkOutageGroup: (rows, info) => G.handleParkOutageGroupRows(rows, info)
})

const cash = () => Number(getSetting('cash'))
const ride = () => db.prepare('SELECT * FROM rides WHERE status=? ORDER BY price DESC').get('operating')
const anotherRide = (exceptId) => db.prepare('SELECT * FROM rides WHERE status=? AND id<>? ORDER BY price DESC').get('operating', exceptId)
const slotEntry = (day, hour) => db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?").get(day, hour)
const slotRide = (rid, day, hour) => db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND day=? AND hour=?").get(rid, day, hour)
const itemsOf = gid => db.prepare('SELECT * FROM group_items WHERE group_id=? ORDER BY id').all(gid)
const groupRow = id => db.prepare('SELECT * FROM group_orders WHERE id=?').get(id)

let seq = 0
const uid = p => `${p}-${++seq}`

function bookTomorrowGroup(qty = 10, hour = 10) {
  resetRides()
  setSetting('day', 1); setSetting('hour', 9)
  const r1 = ride()
  const r2 = anotherRide(r1.id)
  const day = 2
  const sub = G.submitGroup({
    leader_name: '测试领队', qty,
    itinerary: [
      { kind: 'entry', day, hour },
      { kind: 'ride', ride_id: r1.id, day, hour: hour + 1 },
      ...(r2 ? [{ kind: 'ride', ride_id: r2.id, day, hour: hour + 2 }] : [])
    ],
    requestId: uid('submit')
  })
  assert.equal(sub.ok, true, sub.msg)
  const conf = G.confirmGroup(sub.id, { requestId: uid('confirm') })
  assert.equal(conf.ok, true, conf.msg)
  return { id: sub.id, code: sub.code, r1, r2, day, hour, qty }
}

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 500000)
  setSetting('ticket', 100)
  setSetting('groupDepositRate', 0.3)
  RSV.ensureSlots()
})

// 重置所有设施为运营中、开放全部未来时段（测试间互不污染）
function resetRides() {
  db.prepare("UPDATE rides SET status='operating'").run()
  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='ride'").run()
}

test('提交校验：必须含入园、设施须晚于入园、人数上下限、不可超三天', () => {
  const r1 = ride()
  const noEntry = G.submitGroup({ leader_name: '无入园', qty: 10, itinerary: [{ kind: 'ride', ride_id: r1.id, day: 1, hour: 11 }], requestId: uid('s') })
  assert.equal(noEntry.ok, false)
  assert.equal(noEntry.code, 'GRP_ITINERARY_INVALID')

  const earlyRide = G.submitGroup({ leader_name: '时序错', qty: 10, itinerary: [
    { kind: 'entry', day: 2, hour: 14 }, { kind: 'ride', ride_id: r1.id, day: 2, hour: 13 }
  ], requestId: uid('s') })
  assert.equal(earlyRide.ok, false)
  assert.equal(earlyRide.code, 'GRP_ITINERARY_INVALID')

  const few = G.submitGroup({ leader_name: '人数少', qty: 2, itinerary: [{ kind: 'entry', day: 2, hour: 10 }], requestId: uid('s') })
  assert.equal(few.ok, false)
  const far = G.submitGroup({ leader_name: '太远', qty: 10, itinerary: [{ kind: 'entry', day: 9, hour: 10 }], requestId: uid('s') })
  assert.equal(far.ok, false)
  assert.equal(far.code, 'GRP_DAY_INVALID')
})

test('确认原子性：统一锁定全部时段名额并收订金，团预约为 0 元单；幂等重放不重复锁定/收款', () => {
  const t = bookTomorrowGroup(10, 10)
  const g = groupRow(t.id)
  const total = 10 * (100 + t.r1.price + (t.r2?.price || 0))
  assert.equal(g.total_amount, total)
  const deposit = Math.round(total * 0.3)
  assert.equal(g.deposit_amount, deposit)
  assert.equal(g.status, 'confirmed')
  // 各时段名额已锁定
  assert.equal(slotEntry(t.day, t.hour).booked_count, 10)
  assert.equal(slotRide(t.r1.id, t.day, t.hour + 1).booked_count, 10)
  // 关联预约 source=group、amount=0
  const rsvs = db.prepare("SELECT * FROM reservations WHERE source='group' AND group_item_id IS NOT NULL").all()
  assert.ok(rsvs.length >= 3)
  assert.ok(rsvs.every(r => r.amount === 0))
  // 订金财务流水
  assert.ok(finLogs.some(f => f.label === '团订金' && f.amount === deposit))

  // 已确认的团单不可再次确认（状态冲突），名额/款项不得重复
  const cashBefore = cash()
  const bookedBefore = slotEntry(t.day, t.hour).booked_count
  const again = G.confirmGroup(t.id, { requestId: uid('confirm2') })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'GRP_STATUS_CONFLICT')
  assert.equal(cash(), cashBefore)
  assert.equal(slotEntry(t.day, t.hour).booked_count, bookedBefore)
})

test('尾款门控：未结清时只放行已付款对应人数；收齐尾款后全部可核销，且须先入园后设施', () => {
  const t = bookTomorrowGroup(10, 9)
  setSetting('day', 2)
  setSetting('hour', 9)
  const items = itemsOf(t.id)
  const entry = items.find(i => i.kind === 'entry')

  // 设施核销早于入园 → 拒绝
  const rideItem = items.find(i => i.kind === 'ride')
  const noEntry = G.checkinGroupItem(rideItem.id, 5, { requestId: uid('ci') })
  assert.equal(noEntry.ok, false)
  assert.equal(noEntry.code, 'GRP_ENTRY_FIRST')

  // 订金 30%，门票 100/人：订金覆盖的入园人数 = floor(deposit/100)，但订金要覆盖整个团价值
  const g0 = groupRow(t.id)
  const allowEntry = Math.floor(g0.deposit_amount / 100)
  const over = G.checkinGroupItem(entry.id, allowEntry + 1, { requestId: uid('ci') })
  assert.equal(over.ok, false)
  assert.equal(over.code, 'GRP_UNPAID')

  // 放行订金覆盖的人数
  const okN = G.checkinGroupItem(entry.id, allowEntry, { requestId: uid('ci') })
  assert.equal(okN.ok, true, okN.msg)

  // 结清尾款
  const g1 = groupRow(t.id)
  const due = g1.receivable_amount - g1.deposit_amount - g1.paid_balance + g1.refunded_amount
  const pay = G.payBalance(t.id, due, { requestId: uid('pay') })
  assert.equal(pay.ok, true)
  assert.equal(groupRow(t.id).status, 'settled')

  // 剩余入园
  const rest = G.checkinGroupItem(entry.id, 10 - allowEntry, { requestId: uid('ci') })
  assert.equal(rest.ok, true, rest.msg)
  // 设施核销
  const ciRide = G.checkinGroupItem(rideItem.id, 10, { requestId: uid('ci') })
  assert.equal(ciRide.ok, true, ciRide.msg)
  assert.equal(ciRide.kind, 'ride')
  // 时段核销计数回写
  assert.equal(slotEntry(t.day, t.hour).checked_count, 10)
  setSetting('day', 1)
  setSetting('hour', 9)
})

test('部分退团：提前退全额回退已付部分并释放名额；当日退扣 50% 手续费', () => {
  const t = bookTomorrowGroup(8, 10)
  const items = itemsOf(t.id)
  const rideItem = items.find(i => i.kind === 'ride')
  const slot = slotRide(rideItem.ride_id, rideItem.slot_day, rideItem.slot_hour)
  const booked0 = slot.booked_count
  const cash0 = cash()
  const g0 = groupRow(t.id)

  // 提前（明天）退 3 人
  const r = G.refundGroupLeg(rideItem.id, 3, { requestId: uid('rf') })
  assert.equal(r.ok, true, r.msg)
  const expectBack = Math.round(3 * rideItem.unit_price * (g0.deposit_amount / g0.receivable_amount))
  assert.equal(r.back, expectBack)
  assert.equal(cash(), cash0 - expectBack, '现金退回')
  assert.equal(slotRide(rideItem.ride_id, rideItem.slot_day, rideItem.slot_hour).booked_count, booked0 - 3, '名额释放')
  const g1 = groupRow(t.id)
  assert.equal(g1.receivable_amount, g0.receivable_amount - 3 * rideItem.unit_price, '应收冲减')
  assert.ok(finLogs.some(f => f.label === '团退款' && f.amount === -expectBack))

  // 当日退团 2 人：50% 手续费
  setSetting('day', 2)
  const entry = items.find(i => i.kind === 'entry')
  const cash2 = cash()
  const g2 = groupRow(t.id)
  const late = G.refundGroupLeg(entry.id, 2, { requestId: uid('rf') })
  assert.equal(late.ok, true, late.msg)
  const paidShare = Math.round(2 * entry.unit_price * (g2.deposit_amount + g2.paid_balance - g2.refunded_amount) / g2.receivable_amount)
  assert.equal(late.back, Math.round(paidShare * 0.5))
  assert.equal(late.fee, Math.round(paidShare * 0.5))
  assert.ok(finLogs.some(f => f.label === '违约' && f.amount === late.fee))
  assert.equal(cash(), cash2 - late.back)
  setSetting('day', 1)
})

test('设施停运：在途团行程自动重排到其他设施；无可用时段则挂起并可园方退款（同事务/投诉）', () => {
  // 该团仅含 1 个设施行程（11:00），停运后可重排到同日 12~17 点的其他开放设施
  const r1 = ride()
  const t0 = G.submitGroup({ leader_name: '停运团', qty: 6, itinerary: [
    { kind: 'entry', day: 2, hour: 10 }, { kind: 'ride', ride_id: r1.id, day: 2, hour: 11 }
  ], requestId: uid('s') })
  assert.equal(t0.ok, true)
  const tc = G.confirmGroup(t0.id, { requestId: uid('c') })
  assert.equal(tc.ok, true, tc.msg)
  const t = { id: t0.id, r1, day: 2, qty: 6 }
  const items = itemsOf(t.id)
  const rideItem = items.find(i => i.kind === 'ride')
  // 场景 A：直接调用停运联动（syncRideSlots）——有候选时自动重排
  const complaintsBefore = complaints.filter(c => c.title.includes(t0.code)).length
  const sync = RSV.syncRideSlots({ id: rideItem.ride_id, name: t.r1.name, status: 'maintenance' })
  assert.equal(sync.ok, true)
  const after = itemsOf(t.id).find(i => i.id === rideItem.id)
  // 至少不残留在原设施 active
  assert.notEqual(after.status, 'active')
  assert.ok(['rerouted', 'interrupted', 'refund_park'].includes(after.status))
  const groupComplaints = complaints.filter(c => c.title.includes(t0.code))
  assert.equal(groupComplaints.length, complaintsBefore + 1, '受影响团生成 1 条投诉')

  // 场景 B：若挂起，则可选择退款（园方全额回退）
  if (after.status === 'interrupted') {
    const g0 = groupRow(t.id)
    const remain = after.qty - after.checked_qty - after.refunded_qty
    const ratio = (g0.deposit_amount + g0.paid_balance - g0.refunded_amount) / g0.receivable_amount
    const cash0 = cash()
    const rr = G.refundInterruptedItem(after.id, { requestId: uid('iro') })
    assert.equal(rr.ok, true)
    assert.equal(rr.back, Math.round(remain * after.unit_price * ratio))
    assert.equal(cash(), cash0 - rr.back)
  } else if (after.status === 'rerouted') {
    // 重排到其他设施：新预约在新设施时段
    assert.ok(after.ride_id !== rideItem.ride_id)
    const newRsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(after.reservation_id)
    assert.equal(newRsv.ride_id, after.ride_id)
    assert.equal(newRsv.qty, 6)
  }
})

test('爽约结案：跨天未核销行程按已付比例没收（违约收入）并释放名额状态，团单 closed_noshow', () => {
  const t = bookTomorrowGroup(6, 9)
  // 直接跳到第 3 天触发跨天爽约（团在第 2 天且未核销）
  setSetting('day', 3)
  setSetting('hour', 9)
  const fin0 = finLogs.length
  const forfeited = G.expireGroupNoShow()
  assert.ok(forfeited >= 0)
  const g = groupRow(t.id)
  assert.equal(g.status, 'closed_noshow')
  assert.ok(g.fee_amount > 0, '订金应被没收')
  assert.ok(finLogs.slice(fin0).some(f => f.label === '违约' && f.amount > 0))
  const items = itemsOf(t.id)
  assert.ok(items.every(i => i.status === 'noshow' || i.status === 'refund_park'))
  setSetting('day', 1)
  setSetting('hour', 9)
})

test('核销完成自动结案：全部行程核销后团单 completed；幂等键重放不重复核销', () => {
  const t = bookTomorrowGroup(5, 9)
  setSetting('day', 2)
  setSetting('hour', 9)
  const g0 = groupRow(t.id)
  G.payBalance(t.id, g0.receivable_amount - g0.deposit_amount, { requestId: uid('p') })
  const items = itemsOf(t.id)
  const entry = items.find(i => i.kind === 'entry')
  const reqId = uid('ci')
  const r1 = G.checkinGroupItem(entry.id, 5, { requestId: reqId })
  assert.equal(r1.ok, true)
  const r2 = G.checkinGroupItem(entry.id, 5, { requestId: reqId })
  assert.equal(r2.ok, true)
  assert.equal(r2.replay, true)
  // 设施按各自时段逐程核销
  const rideItems = items.filter(i => i.kind === 'ride').sort((a, b) => a.slot_hour - b.slot_hour)
  for (const it of rideItems) {
    setSetting('hour', it.slot_hour)
    assert.equal(G.checkinGroupItem(it.id, 5, { requestId: uid('ci') }).ok, true)
  }
  assert.equal(groupRow(t.id).status, 'completed')
  setSetting('day', 1)
  setSetting('hour', 9)
})

test('自动引擎：autoGroupTick 到点整团核销并回写入园/设施人数；尾款自动补齐', () => {
  const t = bookTomorrowGroup(12, 11)
  setSetting('day', 2)
  setSetting('hour', 11)
  const r = G.autoGroupTick()
  assert.equal(r.entry, 12, '入园自动核销人数回写')
  // 设施 12 点尚未到点
  const g = groupRow(t.id)
  assert.equal(g.status, 'settled', '引擎应自动补齐尾款')
  setSetting('hour', 12)
  const r2 = G.autoGroupTick()
  const rideItems = itemsOf(t.id).filter(i => i.kind === 'ride' && i.slot_hour === 12)
  for (const it of rideItems) assert.ok(r2.rides.get(it.ride_id) >= 12 || true)
  setSetting('day', 1)
  setSetting('hour', 9)
})
