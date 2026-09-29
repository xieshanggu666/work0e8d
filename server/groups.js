import db, { getSetting, setSetting, tx } from './db.js'
import {
  RESERVATION_CONST, ensureSlots,
  getSlotById, findGroupAltSlots
} from './reservations.js'

// 领队组团模块：领队提交入园 + 多设施行程 → 运营确认统一锁定名额并收订金
// → 分批核销 / 尾款结算 / 部分退团 → 设施停运时重排行程或退款，回写预约、客流与财务。
const { ENTRY_HOURS, RIDE_HOURS, GENERATE_DAYS } = RESERVATION_CONST
const LATE_CANCEL_FEE = 0.5       // 游玩当日领队退团：已付部分扣 50% 手续费
const MAX_GROUP_QTY = 120
const MIN_GROUP_QTY = 5
const CHECKIN_EARLY = 1          // 最多提前 1 个游戏小时放行核销

export const GRP_ERR = {
  NOT_FOUND: 'GRP_NOT_FOUND',
  STATUS_CONFLICT: 'GRP_STATUS_CONFLICT',
  ITEM_NOT_FOUND: 'GRP_ITEM_NOT_FOUND',
  ITEM_STATUS: 'GRP_ITEM_STATUS',
  SLOT_NOT_FOUND: 'SLOT_NOT_FOUND',
  SLOT_CLOSED: 'SLOT_CLOSED',
  SLOT_FULL: 'SLOT_FULL',
  SLOT_PAST: 'SLOT_PAST',
  SLOT_MISMATCH: 'SLOT_MISMATCH',
  RIDE_UNAVAILABLE: 'RIDE_UNAVAILABLE',
  ITINERARY_INVALID: 'GRP_ITINERARY_INVALID',
  DAY_INVALID: 'GRP_DAY_INVALID',
  ENTRY_FIRST: 'GRP_ENTRY_FIRST',            // 须先核销入园，再核销设施
  UNPAID: 'GRP_UNPAID',                      // 尾款未结清，款项不足以放行
  LATE: 'GRP_LATE',
  TX_FAILED: 'TX_FAILED'
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })
class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟、现金、财务、投诉、时段查询/重排候选）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  ticket: () => num(getSetting('ticket'), 120),
  depositRate: () => Math.max(0, Math.min(1, num(getSetting('groupDepositRate'), 0.3))),
  logFinance: null,
  createComplaint: null
}
export function initGroupContext(deps) { Object.assign(ctx, deps) }

function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    console.error('[groups] 事务执行失败，已整体回滚:', e)
    return fail(GRP_ERR.TX_FAILED, '系统繁忙，本次操作未生效，请稍后重试')
  }
}

// 幂等执行：组团各动作（提交/确认/收款/核销/退团/重排）携带 requestId，重放返回首次结果
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== GRP_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

// ---------------- 基础工具 ----------------
function getGroup(id) { return db.prepare('SELECT * FROM group_orders WHERE id=?').get(id) }
function getItems(groupId) {
  return db.prepare('SELECT * FROM group_items WHERE group_id=? ORDER BY slot_day, slot_hour, id').all(groupId)
}
function getItem(id) { return db.prepare('SELECT * FROM group_items WHERE id=?').get(id) }

function logGroup(gid, action, note = '', staffId = null) {
  db.prepare('INSERT INTO group_logs(group_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(gid, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}

function addPayment(gid, kind, amount, note = '') {
  db.prepare('INSERT INTO group_payments(group_id,kind,amount,day,tick,note) VALUES(?,?,?,?,?,?)')
    .run(gid, kind, Math.round(amount), ctx.day(), ctx.tick(), note)
}

// 现金与财务流水（标签：团订金/团尾款/团退款/违约）
function receiveCash(amount) { setSetting('cash', Math.round(ctx.cash() + amount)) }
function payoutCash(amount) { setSetting('cash', Math.round(ctx.cash() - amount)) }
function fin(label, amount, detail) { ctx.logFinance?.(ctx.day(), label, Math.round(amount), detail) }

// 团队收款比例（已付净额 / 当前应收）：用于退团/停运按比例回退领队实付部分
function payRatio(g) {
  const netPaid = g.deposit_amount + g.paid_balance - g.refunded_amount
  if (netPaid <= 0) return 0
  if (g.receivable_amount <= 0) return 1
  return Math.max(0, Math.min(1, netPaid / g.receivable_amount))
}

// ---------------- 行程校验与报价 ----------------
// itinerary: [{ kind:'entry'|'ride', ride_id?, day?, hour? }]
// 归一化：仅 1 条入园（以首条为准）+ 若干设施（须在入园当日且晚于入园时刻）
function normalizeItinerary(itinerary, qty) {
  const list = Array.isArray(itinerary) ? itinerary : []
  const entries = [], rides = []
  for (const it of list) {
    if (it.kind === 'entry') entries.push(it)
    else if (it.kind === 'ride' && num(it.ride_id)) rides.push(it)
  }
  if (!entries.length) throw new TxError(GRP_ERR.ITINERARY_INVALID, '行程必须包含一个入园时段')
  if (rides.length > 6) throw new TxError(GRP_ERR.ITINERARY_INVALID, '每团最多预约 6 个设施时段')
  const entry = entries[0]
  const day = Math.round(num(entry.day))
  const entryHour = Math.round(num(entry.hour))
  if (!day || !ENTRY_HOURS.includes(entryHour)) throw new TxError(GRP_ERR.ITINERARY_INVALID, '入园时段无效（9:00~18:00 整点）')
  if (day < ctx.day()) throw new TxError(GRP_ERR.DAY_INVALID, '不可预约已过期的日期')
  if (day > ctx.day() + GENERATE_DAYS - 1) throw new TxError(GRP_ERR.DAY_INVALID, `仅开放未来 ${GENERATE_DAYS} 天内的团队预约`)

  const normRides = []
  const seen = new Set()
  for (const r of rides) {
    const ride = db.prepare("SELECT * FROM rides WHERE id=?").get(num(r.ride_id))
    if (!ride) throw new TxError(GRP_ERR.RIDE_UNAVAILABLE, `设施 #${r.ride_id} 不存在`)
    const rh = Math.round(num(r.hour))
    const rday = Math.round(num(r.day) || day)
    if (rday !== day) throw new TxError(GRP_ERR.ITINERARY_INVALID, `设施「${ride.name}」须与入园同为第 ${day} 天`)
    if (!RIDE_HOURS.includes(rh)) throw new TxError(GRP_ERR.ITINERARY_INVALID, `设施「${ride.name}」时段无效（9:00~17:00）`)
    if (rh <= entryHour) throw new TxError(GRP_ERR.ITINERARY_INVALID, `设施「${ride.name}」游玩时段须晚于入园 ${entryHour}:00`)
    const key = `${ride.id}@${rh}`
    if (seen.has(key)) throw new TxError(GRP_ERR.ITINERARY_INVALID, `行程重复：${ride.name} ${rh}:00`)
    seen.add(key)
    normRides.push({ ride, day, hour: rh })
  }
  return { day, entryHour, rides: normRides, qty }
}

function quoteItinerary(norm) {
  const items = [{ kind: 'entry', ride_id: null, day: norm.day, hour: norm.entryHour, unit: ctx.ticket() }]
  for (const r of norm.rides) items.push({ kind: 'ride', ride_id: r.ride.id, day: r.day, hour: r.hour, unit: r.ride.price })
  return items.map(x => ({ ...x, amount: x.unit * norm.qty }))
}

// ---------------- 领队提交 / 运营确认 / 拒绝 / 撤回 ----------------
export function submitGroup({ leader_name, leader_phone = '', qty, itinerary, source = 'leader', requestId = '', note = '' }) {
  return idempotent('grp_submit', requestId, () => {
    ensureSlots()
    const name = String(leader_name || '').trim()
    if (!name) return fail(GRP_ERR.ITINERARY_INVALID, '请填写领队姓名')
    const q = Math.round(num(qty))
    if (!Number.isInteger(q) || q < MIN_GROUP_QTY || q > MAX_GROUP_QTY) {
      return fail(GRP_ERR.ITINERARY_INVALID, `团队人数需为 ${MIN_GROUP_QTY}~${MAX_GROUP_QTY} 人`)
    }
    let norm
    try { norm = normalizeItinerary(itinerary, q) } catch (e) {
      if (e instanceof TxError) return fail(e.code, e.message)
      throw e
    }
    const quoted = quoteItinerary(norm)
    const total = quoted.reduce((s, x) => s + x.amount, 0)

    return runAtomic(() => {
      const r = db.prepare(`INSERT INTO group_orders
          (code,leader_name,leader_phone,qty,visit_day,entry_hour,status,total_amount,receivable_amount,deposit_rate,source,note,created_tick,created_day)
          VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`)
        .run('', name, String(leader_phone || '').slice(0, 30), q, norm.day, norm.entryHour,
          total, total, ctx.depositRate(), source === 'auto' ? 'auto' : 'leader', String(note || '').slice(0, 200),
          ctx.tick(), ctx.day())
      const id = Number(r.lastInsertRowid)
      const code = 'TU' + String(id).padStart(4, '0')
      db.prepare('UPDATE group_orders SET code=? WHERE id=?').run(code, id)
      const ii = db.prepare(`INSERT INTO group_items
          (group_id,kind,ride_id,slot_day,slot_hour,qty,unit_price,amount,status)
          VALUES(?,?,?,?,?,?,?,?,'pending')`)
      for (const x of quoted) {
        ii.run(id, x.kind, x.ride_id, x.day, x.hour, q, x.unit, x.amount)
      }
      logGroup(id, 'submit', `领队 ${name} 提交 ${q} 人团行程：入园 ${norm.day}日 ${norm.entryHour}:00 + ${norm.rides.length} 个设施，应收 ¥${total}`)
      return { ok: true, id, code, total, deposit: Math.round(total * ctx.depositRate()) }
    })
  })
}

// 原子占用团时段库存（开放且余量充足才命中），与散客同一套库存，互斥可见
function claimStock(slot, qty) {
  const u = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                        WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`)
    .run(qty, slot.id, qty)
  if (u.changes === 0) {
    const cur = getSlotById(slot.id)
    if (!cur || cur.status !== 'open') throw new TxError(GRP_ERR.SLOT_CLOSED, '该时段已关闭，无法锁定名额')
    throw new TxError(GRP_ERR.SLOT_FULL, `第 ${slot.day} 天 ${slot.hour}:00 时段余量不足（剩 ${Math.max(0, cur.capacity + cur.oversell - cur.booked_count)}），请联系领队调整行程`)
  }
}

// 为团行程建立 0 元预约单（款项在团账统一结算），与散客预约共用库存/核销/客流回写
function createGroupReservation(g, item, slot) {
  const r = db.prepare(`INSERT INTO reservations
      (code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day,group_item_id)
      VALUES(?,?,?,?,?,?,?,?,?,0,'booked','group',?,?,?)`)
    .run('', `${g.leader_name}团队`, g.leader_phone, item.kind, item.ride_id, slot.id,
      item.slot_day, item.slot_hour, item.qty, ctx.tick(), ctx.day(), item.id)
  const rid = Number(r.lastInsertRowid)
  const rcode = 'YY' + String(rid).padStart(4, '0')
  db.prepare('UPDATE reservations SET code=? WHERE id=?').run(rcode, rid)
  db.prepare('UPDATE group_items SET reservation_id=?, slot_id=? WHERE id=?').run(rid, slot.id, item.id)
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(rid, ctx.tick(), ctx.day(), ctx.hour(), 'create',
      `团队 ${g.code} 锁定 ${item.qty} 个名额（团账统一结算，0 元单）`)
  return rid
}

// 运营确认：统一锁定各时段名额 + 收订金，全程同一事务，任一时段锁定失败整体回滚（不收订金、不留占位）
export function confirmGroup(id, { requestId = '', staffId = null } = {}) {
  return idempotent('grp_confirm', requestId, () => {
    const g = getGroup(id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (g.status !== 'pending') return fail(GRP_ERR.STATUS_CONFLICT, '仅待确认的团单可以确认锁定')
    const items = getItems(id)
    return runAtomic(() => {
      ensureSlots()
      // 先解析并锁定各时段（库存条件更新，余量不足即抛错整体回滚）
      const locked = items.map(item => {
        const slot = item.kind === 'entry'
          ? db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?").get(item.slot_day, item.slot_hour)
          : db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND day=? AND hour=?").get(item.ride_id, item.slot_day, item.slot_hour)
        if (!slot) throw new TxError(GRP_ERR.SLOT_NOT_FOUND, `第 ${item.slot_day} 天 ${item.slot_hour}:00 时段尚未开放`)
        if (item.kind === 'ride') {
          const ride = db.prepare("SELECT status FROM rides WHERE id=?").get(item.ride_id)
          if (!ride || ride.status !== 'operating') throw new TxError(GRP_ERR.RIDE_UNAVAILABLE, '行程包含已停运设施，请先调整后再确认')
        }
        claimStock(slot, item.qty)
        return { item, slot }
      })
      // 建立团预约单（0 元，款项走团账）
      for (const { item, slot } of locked) {
        createGroupReservation(g, item, slot)
        db.prepare("UPDATE group_items SET status='active' WHERE id=?").run(item.id)
      }
      // 3) 收取订金
      const deposit = Math.round(g.total_amount * g.deposit_rate)
      receiveCash(deposit)
      fin('团订金', deposit, `团队 ${g.code} 确认锁定 ${g.qty} 人 · 订金 ${Math.round(g.deposit_rate * 100)}%`)
      addPayment(id, 'deposit', deposit, '运营确认，统一锁定名额并收取订金')
      // 订金若已覆盖全款（如全程退改后），直接进入已结清
      const settled = deposit >= g.receivable_amount
      db.prepare(`UPDATE group_orders SET status=?, deposit_amount=?, confirm_tick=? WHERE id=?`)
        .run(settled ? 'settled' : 'confirmed', deposit, ctx.tick(), id)
      logGroup(id, 'confirm', `运营确认锁定全部时段名额，收取订金 ¥${deposit}${settled ? '（已结清全款）' : ''}`, staffId)
      return { ok: true, deposit, status: settled ? 'settled' : 'confirmed' }
    })
  })
}

// 运营拒绝待确认团单（未锁定名额、未收款，无资金影响）
export function rejectGroup(id, { requestId = '', reason = '', staffId = null } = {}) {
  return idempotent('grp_reject', requestId, () => {
    const g = getGroup(id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (g.status !== 'pending') return fail(GRP_ERR.STATUS_CONFLICT, '仅待确认的团单可以拒绝')
    return runAtomic(() => {
      db.prepare("UPDATE group_items SET status='refund_guest' WHERE group_id=? AND status='pending'").run(id)
      db.prepare("UPDATE group_orders SET status='cancelled', closed_tick=?, closed_day=? WHERE id=?").run(ctx.tick(), ctx.day(), id)
      logGroup(id, 'reject', `运营拒绝团单：${reason || '行程名额无法安排'}`, staffId)
      return { ok: true }
    })
  })
}

// 领队撤回待确认团单
export function cancelGroup(id, { requestId = '' } = {}) {
  return idempotent('grp_cancel', requestId, () => {
    const g = getGroup(id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (g.status !== 'pending') return fail(GRP_ERR.STATUS_CONFLICT, '已确认的团单不可整体撤回，请走部分退团/尾款流程')
    return runAtomic(() => {
      db.prepare("UPDATE group_items SET status='refund_guest' WHERE group_id=?").run(id)
      db.prepare("UPDATE group_orders SET status='cancelled', closed_tick=?, closed_day=? WHERE id=?").run(ctx.tick(), ctx.day(), id)
      logGroup(id, 'cancel', '领队撤回团单（确认前撤回，无费用）')
      return { ok: true }
    })
  })
}

// ---------------- 尾款结算（可分批收取） ----------------
export function payBalance(id, amount, { requestId = '' } = {}) {
  return idempotent('grp_balance', requestId, () => {
    const g = getGroup(id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (!['confirmed', 'settled'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前团单状态不可收尾款')
    const pay = Math.round(num(amount))
    if (!Number.isFinite(pay) || pay <= 0) return fail(GRP_ERR.STATUS_CONFLICT, '收款金额需大于 0')
    const due = Math.max(0, g.receivable_amount - g.deposit_amount - g.paid_balance + g.refunded_amount)
    if (pay > due) return fail(GRP_ERR.STATUS_CONFLICT, `尾款最多还应收 ¥${due}，请勿超额收款`)
    return runAtomic(() => {
      receiveCash(pay)
      fin('团尾款', pay, `团队 ${g.code} 收取尾款`)
      addPayment(id, 'balance', pay, '领队分批结算尾款')
      db.prepare('UPDATE group_orders SET paid_balance=paid_balance+? WHERE id=?').run(pay, id)
      const ng = getGroup(id)
      const fully = ng.deposit_amount + ng.paid_balance - ng.refunded_amount >= ng.receivable_amount
      if (fully) db.prepare("UPDATE group_orders SET status='settled' WHERE id=? AND status='confirmed'").run(id)
      logGroup(id, 'balance', `收到尾款 ¥${pay}，累计收款 ¥${ng.deposit_amount + ng.paid_balance}${fully ? '，团款已结清，可放行核销' : `，仍欠 ¥${ng.receivable_amount - ng.deposit_amount - ng.paid_balance + ng.refunded_amount}`}`)
      return { ok: true, paid: pay, status: fully ? 'settled' : 'confirmed', balanceDue: Math.max(0, ng.receivable_amount - ng.deposit_amount - ng.paid_balance + ng.refunded_amount) }
    })
  })
}

// ---------------- 核销落库（人工分批 / 引擎自动共用） ----------------
function entryItem(gid) {
  return db.prepare("SELECT * FROM group_items WHERE group_id=? AND kind='entry'").get(gid)
}
function checkedWorth(gid, exceptItemId = 0, addQty = 0, addPrice = 0) {
  const rows = db.prepare(`SELECT COALESCE(SUM(checked_qty*unit_price),0) s FROM group_items
                           WHERE group_id=? AND id<>? AND status IN ('active','rerouted','checked')`).all(gid, exceptItemId)
  const s = rows[0]?.s || 0
  return s + addQty * addPrice
}

// 核销一个行程的一批人；返回核销后入园/设施人数（供引擎回写客流与游玩量）
export function checkinGroupItem(itemId, qty, { requestId = '', source = 'manual' } = {}) {
  return idempotent('grp_checkin', requestId, () => {
    const item = getItem(itemId)
    if (!item) return fail(GRP_ERR.ITEM_NOT_FOUND, '行程不存在')
    const g = getGroup(item.group_id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (!['confirmed', 'settled'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前团单状态不可核销')
    if (!['active', 'rerouted'].includes(item.status)) return fail(GRP_ERR.ITEM_STATUS, '该行程已退改/核销完毕，不可核销')
    const q = Math.round(num(qty))
    const remain = item.qty - item.checked_qty - item.refunded_qty
    if (!Number.isInteger(q) || q <= 0 || q > remain) return fail(GRP_ERR.STATUS_CONFLICT, `本批核销人数需为 1~${remain} 人`)

    // 时间窗：最早提前 1 小时，迟到 1 小时内仍放行
    if (item.slot_day > ctx.day() || (item.slot_day === ctx.day() && item.slot_hour > ctx.hour() + CHECKIN_EARLY)) {
      return fail(GRP_ERR.LATE, `未到核销时间（第 ${item.slot_day} 天 ${item.slot_hour}:00），最早可提前 ${CHECKIN_EARLY} 小时放行`)
    }
    if (item.slot_day < ctx.day() || (item.slot_day === ctx.day() && item.slot_hour < ctx.hour() - 1)) {
      return fail(GRP_ERR.LATE, '该行程时段已过，无法核销（未到场部分按爽约处理）')
    }
    // 先入园、后游玩：设施核销要求入园已核销
    if (item.kind === 'ride') {
      const en = entryItem(g.id)
      if (!en || en.checked_qty <= 0) return fail(GRP_ERR.ENTRY_FIRST, '团队尚未核销入园，请先在入园时段完成闸机核销')
    }

    return runAtomic(() => {
      // 款项门控：核销部分对应的应收不得超过领队已付净额（尾款未结清时只放行已付款对应人数）
      const netPaid = g.deposit_amount + g.paid_balance - g.refunded_amount
      const worthAfter = checkedWorth(g.id, item.id, item.checked_qty + q, item.unit_price)
      if (worthAfter > netPaid) {
        const payableNow = netPaid - checkedWorth(g.id, item.id, item.checked_qty, item.unit_price)
        const allow = Math.max(0, Math.floor(payableNow / item.unit_price))
        throw new TxError(GRP_ERR.UNPAID,
          `团款未结清，本程最多可放行 ${allow} 人；请先结算尾款（本程单价 ¥${item.unit_price}/人）`)
      }
      // 预约单/时段回写：全部人核销完将团预约置为 checked
      const newChecked = item.checked_qty + q
      db.prepare('UPDATE group_items SET checked_qty=?, status=? WHERE id=?')
        .run(newChecked, newChecked >= item.qty - item.refunded_qty ? 'checked' : item.status, item.id)
      if (item.reservation_id) {
        if (newChecked >= item.qty - item.refunded_qty) {
          const u = db.prepare("UPDATE reservations SET status='checked', checked_tick=? WHERE id=? AND status='booked'")
            .run(ctx.tick(), item.reservation_id)
          if (u.changes === 0) throw new TxError(GRP_ERR.STATUS_CONFLICT, '关联预约状态已变化，核销失败')
        }
        db.prepare('UPDATE reservation_slots SET checked_count=checked_count+? WHERE id=?').run(q, item.slot_id)
      }
      db.prepare('INSERT INTO group_checkins(group_id,item_id,qty,source,day,hour,tick,note) VALUES(?,?,?,?,?,?,?,?)')
        .run(g.id, item.id, q, source === 'auto' ? 'auto' : 'manual', ctx.day(), ctx.hour(), ctx.tick(),
          item.kind === 'entry' ? '闸机入园核销' : '设施口核销')
      logGroup(g.id, 'checkin', `${item.kind === 'entry' ? '入园' : '设施'}分批核销 ${qty} 人（累计 ${newChecked}/${item.qty}）`)
      db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
        .run(item.reservation_id, ctx.tick(), ctx.day(), ctx.hour(), 'checkin',
          `${g.code} 团队${source === 'auto' ? '自动' : '分批'}核销 ${qty} 人（累计 ${newChecked}/${item.qty}）`)
      maybeComplete(g.id)
      return { ok: true, qty: q, kind: item.kind, rideId: item.ride_id, entry: item.kind === 'entry' ? q : 0 }
    })
  })
}

// 全部行程终结（无 active/rerouted/interrupted/pending）且有人核销 → completed；全未到 → closed_noshow
function maybeComplete(gid) {
  const g = getGroup(gid)
  if (!['confirmed', 'settled'].includes(g.status)) return g?.status
  const items = getItems(gid)
  const live = items.some(i => ['pending', 'active', 'rerouted', 'interrupted'].includes(i.status))
  if (live) return g.status
  const anyChecked = items.some(i => i.checked_qty > 0)
  const status = anyChecked ? 'completed' : 'closed_noshow'
  db.prepare("UPDATE group_orders SET status=?, closed_tick=?, closed_day=? WHERE id=?").run(status, ctx.tick(), ctx.day(), gid)
  logGroup(gid, anyChecked ? 'complete' : 'noshow_close', anyChecked ? '全部行程核销/退改完成，团队行程结案' : '团队全程未到场，结案')
  return status
}

// ---------------- 退团与停运处置（共用切片退款） ----------------
// 对一行程退回 n 人：release 名额、缩减/关闭关联预约、按已付比例回退团款、逐笔下账
function sliceItemRefund(item, n, reason, note) {
  const g = getGroup(item.group_id)
  // 团账：应收按牌价冲减；已付部分按比例退现金/没收手续费。退款不得超过团账净收款上限
  const netPaidBefore = g.deposit_amount + g.paid_balance - g.refunded_amount
  const sliceAmount = n * item.unit_price
  const ratio = payRatio(g)
  const wantBack = reason === 'guest_late' ? Math.round(sliceAmount * ratio * (1 - LATE_CANCEL_FEE)) : Math.round(sliceAmount * ratio)
  const back = Math.max(0, Math.min(wantBack, netPaidBefore))
  const fee = Math.max(0, Math.round(sliceAmount * ratio) - back)

  // 名额与预约回写：释放 booked，记录 refund；全退则预约置退款态（0 元团单，现金在团账处理）
  const newRefunded = item.refunded_qty + n
  const remaining = item.qty - item.checked_qty - newRefunded
  if (item.reservation_id && item.slot_id) {
    db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?), refund_count=refund_count+? WHERE id=?')
      .run(n, n, item.slot_id)
    if (remaining <= 0) {
      // 全程终结：有人到场则按已核销态关闭，否则园方/领队退款态
      const terminalRsv = item.checked_qty > 0 ? 'checked' : 'refunded'
      db.prepare("UPDATE reservations SET status=?, reason=?, closed_tick=?, closed_day=?, qty=? WHERE id=?")
        .run(terminalRsv, reason.startsWith('park') ? 'park' : 'guest', ctx.tick(), ctx.day(), Math.max(0, item.checked_qty), item.reservation_id)
    } else {
      db.prepare('UPDATE reservations SET qty=? WHERE id=?').run(remaining, item.reservation_id)
    }
  }
  const terminal = remaining <= 0
  const itemStatus = reason.startsWith('park') ? 'refund_park' : 'refund_guest'
  db.prepare('UPDATE group_items SET refunded_qty=?, status=? WHERE id=?')
    .run(newRefunded, terminal ? itemStatus : item.status, item.id)

  // 团账：应收按牌价冲减；已付部分按比例退现金/没收手续费
  db.prepare('UPDATE group_orders SET receivable_amount=MAX(0,receivable_amount-?), refunded_amount=refunded_amount+?, fee_amount=fee_amount+? WHERE id=?')
    .run(sliceAmount, back, fee, g.id)
  if (back > 0) {
    payoutCash(back)
    fin('团退款', -back, `团队 ${g.code} ${note}（${n} 人）`)
    addPayment(g.id, reason.startsWith('park') ? 'refund_park' : 'refund_guest', -back, note)
  }
  if (fee > 0) {
    fin('违约', fee, `团队 ${g.code} 当日退团手续费（${n} 人）`)
    addPayment(g.id, 'fee', fee, '当日退团扣 50% 手续费')
  }
  logGroup(g.id, 'refund', `${note}：${n} 人 · 应收冲减 ¥${sliceAmount} · 退领队 ¥${back}${fee ? ` · 手续费 ¥${fee}` : ''}`)
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(item.reservation_id, ctx.tick(), ctx.day(), ctx.hour(), 'refund',
      `团队 ${g.code} ${note}：${n} 人，释放名额并回退团款 ¥${back}`)
  maybeComplete(g.id)
  return { ok: true, back, fee, sliceAmount }
}

// 领队部分退团：行程开始前可退（当日退扣已付部分 50% 手续费）；已核销部分不退
export function refundGroupLeg(itemId, qty, { requestId = '' } = {}) {
  return idempotent('grp_refund_leg', requestId, () => {
    const item = getItem(itemId)
    if (!item) return fail(GRP_ERR.ITEM_NOT_FOUND, '行程不存在')
    const g = getGroup(item.group_id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (!['confirmed', 'settled'].includes(g.status)) return fail(GRP_ERR.STATUS_CONFLICT, '当前团单状态不可退团')
    if (!['active', 'rerouted'].includes(item.status)) return fail(GRP_ERR.ITEM_STATUS, '该行程已退改完毕，不可再退')
    const n = Math.round(num(qty))
    const remain = item.qty - item.checked_qty - item.refunded_qty
    if (!Number.isInteger(n) || n <= 0 || n > remain) return fail(GRP_ERR.STATUS_CONFLICT, `退团人数需为 1~${remain} 人`)
    if (item.slot_day < ctx.day() || (item.slot_day === ctx.day() && item.slot_hour <= ctx.hour())) {
      return fail(GRP_ERR.SLOT_PAST, '该行程时段已开始/结束，未核销部分按爽约处理，不可主动退团')
    }
    const late = item.slot_day === ctx.day()
    return runAtomic(() => sliceItemRefund(item, n, late ? 'guest_late' : 'guest',
      late ? '领队当日申请部分退团（扣 50% 手续费）' : '领队提前申请部分退团（全额退已付部分）'))
  })
}

// ---------------- 设施停运：重排行程或退款（在散客模块同事务内调用，不自建事务） ----------------
// rows: source='group' 的在途预约；逐团处理：能自动重排则原子转移，不能则入园直接退、设施挂起待运营/领队决策
export function handleParkOutageGroupRows(rows, info = {}) {
  const byGroup = new Map()
  for (const r of rows) {
    const item = db.prepare('SELECT * FROM group_items WHERE id=?').get(r.group_item_id)
    if (!item || !['active', 'rerouted'].includes(item.status)) continue
    if (!byGroup.has(item.group_id)) byGroup.set(item.group_id, [])
    byGroup.get(item.group_id).push({ rsv: r, item })
  }
  const affectedGroups = []
  for (const [gid, list] of byGroup) {
    const g = getGroup(gid)
    if (!g) continue
    let interrupted = 0, autoRefunded = 0, rerouted = 0
    const rideName = info.ride?.name || ''
    for (const { rsv, item } of list) {
      const remain = item.qty - item.checked_qty - item.refunded_qty
      if (remain <= 0) continue
      const alts = findGroupAltSlots({
        kind: item.kind, rideId: item.ride_id, excludeRideId: item.ride_id,
        day: item.slot_day, hour: item.slot_hour, qty: remain
      })
      const alt = alts[0]
      if (alt) {
        rerouteToSlot(g, item, alt, remain,
          `关联设施「${rideName}」停运，系统自动重排至 ${alt.day}日 ${alt.hour}:00`, { releaseOld: true })
        rerouted += remain
      } else if (item.kind === 'entry') {
        // 入园时段无法安置：该程园方全额回退团款（否则团队无法入园）
        sliceItemRefund(item, remain, 'park', '入园时段关闭且无可改时段，园方全额回退团款')
        autoRefunded += remain
      } else {
        // 设施无法立即重排：释放名额并挂起，领队/运营随后选择重排其他设施或退款
        suspendInterruptedItem(g, item, rsv, remain,
          `设施「${rideName || '停运'}」，第 ${item.slot_day} 天 ${item.slot_hour}:00 行程暂停，等待重排或退款`)
        interrupted += remain
      }
    }
    if (rerouted + interrupted + autoRefunded > 0) {
      affectedGroups.push({ g, interrupted, rerouted, autoRefunded })
      logGroup(gid, 'outage',
        `设施停运联动：自动重排 ${rerouted} 人${autoRefunded ? `，入园回退 ${autoRefunded} 人` : ''}${interrupted ? `，${interrupted} 人行程挂起待重排/退款` : ''}`)
      // 一团一投诉（园方原因，团队行程受影响）
      ctx.createComplaint?.({
        category: 'facility', severity: 2,
        title: `团队行程变更 · ${rideName || '设施停运'} · ${g.code}`,
        content: `领队 ${g.leader_name} 的 ${g.qty} 人团队行程受设施停运影响：重排 ${rerouted} 人、待处置 ${interrupted} 人、退款 ${autoRefunded} 人，领队要求园方给出说法。`,
        target: info.ride ? { type: 'ride', id: info.ride.id, name: rideName } : { type: '', id: null, name: '' },
        source: 'guest'
      })
    }
  }
  return { ok: true, affected: affectedGroups.length }
}

// 行程挂起：释放关闭时段名额，关联 0 元预约置园方退款态（团款暂留团账，待重排/退款决策）
function suspendInterruptedItem(g, item, rsv, remain, note) {
  db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?), refund_count=refund_count+? WHERE id=?')
    .run(remain, remain, item.slot_id)
  db.prepare("UPDATE reservations SET status='refunded', reason='park', closed_tick=?, closed_day=? WHERE id=?")
    .run(ctx.tick(), ctx.day(), rsv.id)
  db.prepare("UPDATE group_items SET status='interrupted', note=? WHERE id=?").run(note, item.id)
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(rsv.id, ctx.tick(), ctx.day(), ctx.hour(), 'refund', `团队 ${g.code} 设施停运，名额释放，团款待重排/退款决策`)
}

// 重排到新时段：占用新名额 + 建立新团预约单（0 元）。
// releaseOld=true（停运批处理/在途改期）释放旧时段名额并关闭旧单；false（挂起后手动重排）旧名额已释放。
function rerouteToSlot(g, item, slot, remain, note, { releaseOld = true } = {}) {
  // 新时段原子占用
  const claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                            WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`)
    .run(remain, slot.id, remain)
  if (claim.changes === 0) throw new TxError(GRP_ERR.SLOT_FULL, '目标时段名额不足，重排失败')
  // 旧时段释放（挂起行程在 suspendInterruptedItem 中已释放，不重复扣减）
  if (releaseOld && item.slot_id && item.slot_id !== slot.id) {
    db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?) WHERE id=?').run(remain, item.slot_id)
    if (item.reservation_id) {
      db.prepare("UPDATE reservations SET status='refunded', reason='park', closed_tick=?, closed_day=? WHERE id=?")
        .run(ctx.tick(), ctx.day(), item.reservation_id)
    }
  }
  const newItem = {
    ...item,
    kind: slot.scope === 'entry' ? 'entry' : 'ride',
    ride_id: slot.ride_id,
    slot_day: slot.day,
    slot_hour: slot.hour,
    qty: item.qty
  }
  // 新团预约单（未核销部分）；已核销的人不随重排移动
  const rid = (() => {
    const r = db.prepare(`INSERT INTO reservations
        (code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day,group_item_id)
        VALUES(?,?,?,?,?,?,?,?,?,0,'booked','group',?,?,?)`)
      .run('', `${g.leader_name}团队`, g.leader_phone, newItem.kind, slot.ride_id, slot.id,
        slot.day, slot.hour, remain, ctx.tick(), ctx.day(), item.id)
    const id2 = Number(r.lastInsertRowid)
    const code = 'YY' + String(id2).padStart(4, '0')
    db.prepare('UPDATE reservations SET code=? WHERE id=?').run(code, id2)
    return id2
  })()
  db.prepare(`UPDATE group_items SET kind=?, ride_id=?, slot_id=?, slot_day=?, slot_hour=?, reservation_id=?, status='rerouted', note=? WHERE id=?`)
    .run(newItem.kind, slot.ride_id, slot.id, slot.day, slot.hour, rid, note, item.id)
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(rid, ctx.tick(), ctx.day(), ctx.hour(), 'auto_reschedule', `团队 ${g.code} 行程重排，新预约单 YY${String(rid).padStart(4, '0')}（${remain} 人）`)
  logGroup(g.id, 'reroute', `${note}；新预约单 YY${String(rid).padStart(4, '0')} 已锁定，已核销 ${item.checked_qty} 人不随改`)
  return rid
}

// 手动重排挂起行程（领队/运营选择新时段；同事务）
export function rerouteGroupItem(itemId, targetSlotId, { requestId = '' } = {}) {
  return idempotent('grp_reroute', requestId, () => {
    const item = getItem(itemId)
    if (!item) return fail(GRP_ERR.ITEM_NOT_FOUND, '行程不存在')
    const g = getGroup(item.group_id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    const slot = getSlotById(num(targetSlotId))
    if (!slot) return fail(GRP_ERR.SLOT_NOT_FOUND, '目标时段不存在')
    const remain = item.qty - item.checked_qty - item.refunded_qty
    if (remain <= 0) return fail(GRP_ERR.ITEM_STATUS, '该行程已无待安排人员')
    // 仅挂起行程可手动重排（active 行程如需调整请先退该程）
    if (item.status !== 'interrupted') {
      // 也允许运营对在途行程直接改期：目标必须同类
      if (!['active', 'rerouted'].includes(item.status)) return fail(GRP_ERR.ITEM_STATUS, '当前行程状态不可重排')
    }
    if (slot.scope !== item.kind) return fail(GRP_ERR.SLOT_MISMATCH, '目标时段类型与行程不匹配')
    if (item.kind === 'ride' && slot.status === 'open') {
      const ride = db.prepare("SELECT status FROM rides WHERE id=?").get(slot.ride_id)
      if (!ride || ride.status !== 'operating') return fail(GRP_ERR.RIDE_UNAVAILABLE, '目标设施当前不开放')
    }
    if (slot.status !== 'open') return fail(GRP_ERR.SLOT_CLOSED, '目标时段已关闭')
    if (slot.day < ctx.day() || (slot.day === ctx.day() && slot.hour <= ctx.hour())) {
      return fail(GRP_ERR.SLOT_PAST, '目标时段已过期')
    }
    return runAtomic(() => {
      // 设施换设施：同一团不得与其他在途设施时段重复
      if (item.kind === 'ride') {
        const dup = db.prepare("SELECT id FROM group_items WHERE group_id=? AND id<>? AND status IN ('active','rerouted') AND ride_id=? AND slot_day=? AND slot_hour=?")
          .get(g.id, item.id, slot.ride_id, slot.day, slot.hour)
        if (dup) throw new TxError(GRP_ERR.SLOT_MISMATCH, '目标时段与团队其他设施行程重复')
      }
      // interrupted 的旧名额已在挂起时释放（releaseOld=false）；在途改期则转移旧名额
      rerouteToSlot(g, item, slot, remain,
        item.status === 'interrupted' ? '停运挂起后手动选择新时段重排' : '运营/领队手动调整行程时段',
        { releaseOld: item.status !== 'interrupted' })
      return { ok: true }
    })
  })
}

// 挂起行程选择退款（园方原因，全额回退已付部分）
export function refundInterruptedItem(itemId, { requestId = '' } = {}) {
  return idempotent('grp_refund_item', requestId, () => {
    const item = getItem(itemId)
    if (!item) return fail(GRP_ERR.ITEM_NOT_FOUND, '行程不存在')
    const g = getGroup(item.group_id)
    if (!g) return fail(GRP_ERR.NOT_FOUND, '团单不存在')
    if (item.status !== 'interrupted') return fail(GRP_ERR.ITEM_STATUS, '仅停运挂起的行程可以按园方原因退款')
    const remain = item.qty - item.checked_qty - item.refunded_qty
    if (remain <= 0) return fail(GRP_ERR.ITEM_STATUS, '该行程已无待退人员')
    // 旧名额已在挂起时释放，这里只走团款回退（不再动库存）
    return runAtomic(() => {
      const sliceAmount = remain * item.unit_price
      const netPaidBefore = g.deposit_amount + g.paid_balance - g.refunded_amount
      const back = Math.max(0, Math.min(Math.round(sliceAmount * payRatio(getGroup(g.id))), netPaidBefore))
      db.prepare('UPDATE group_items SET refunded_qty=refunded_qty+?, status=? WHERE id=?')
        .run(remain, 'refund_park', item.id)
      db.prepare('UPDATE group_orders SET receivable_amount=MAX(0,receivable_amount-?), refunded_amount=refunded_amount+? WHERE id=?')
        .run(sliceAmount, back, g.id)
      if (back > 0) {
        payoutCash(back)
        fin('团退款', -back, `团队 ${g.code} 设施停运，领队选择退款（${remain} 人）`)
        addPayment(g.id, 'refund_park', -back, '设施停运挂起行程，园方全额回退团款')
      }
      logGroup(g.id, 'refund', `停运行程领队选择退款：${remain} 人 · 应收冲减 ¥${sliceAmount} · 退领队 ¥${back}`)
      maybeComplete(g.id)
      return { ok: true, back, sliceAmount }
    })
  })
}

// ---------------- 引擎自动：模拟团 / 自动核销 / 爽约结案 ----------------
const LEADER_SURNAMES = ['赵', '钱', '孙', '周', '吴', '郑', '冯', '秦']
const LEADER_NAMES = ['团长', '领队', '老师', '导览']
function randomLeader() {
  return LEADER_SURNAMES[Math.floor(Math.random() * LEADER_SURNAMES.length)] +
    LEADER_NAMES[Math.floor(Math.random() * LEADER_NAMES.length)]
}

// 每个营业小时低频生成模拟团：为明天提交并自动确认（锁定名额+订金），演示完整团队闭环
export function autoSimulateGroup() {
  if (!ENTRY_HOURS.includes(ctx.hour())) return
  if (Math.random() > 0.16) return
  const day = ctx.day() + 1
  const opsRides = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY attr DESC LIMIT 5").all()
  if (!opsRides.length) return
  const qty = 8 + Math.floor(Math.random() * 28)
  const entryHour = ENTRY_HOURS[Math.floor(Math.random() * 4)]   // 9~12 入园
  const later = RIDE_HOURS.filter(h => h > entryHour)
  const rideCount = 1 + Math.floor(Math.random() * Math.min(3, later.length))
  const picked = new Set()
  const itinerary = [{ kind: 'entry', day, hour: entryHour }]
  for (let i = 0; i < rideCount; i++) {
    const candidates = opsRides.filter(r => !picked.has(r.id))
    if (!candidates.length) break
    const ride = candidates[Math.floor(Math.random() * candidates.length)]
    const h = later[Math.floor(Math.random() * later.length)]
    picked.add(ride.id)
    itinerary.push({ kind: 'ride', ride_id: ride.id, day, hour: h })
  }
  const sub = submitGroup({
    leader_name: randomLeader(),
    leader_phone: '',
    qty, itinerary, source: 'auto',
    requestId: `auto-grp-${ctx.tick()}-${Math.floor(Math.random() * 1e6)}`
  })
  if (sub.ok) confirmGroup(sub.id, { requestId: `auto-grp-confirm-${sub.id}` })
}

// 自动收尾款（游玩日开场前结清）与分批核销（到点整团到场，入园优先于设施）
// 返回 { entry, rides:Map } 供主循环回写客流与设施游玩量
export function autoGroupTick() {
  const day = ctx.day()
  const hour = ctx.hour()
  const entry = { qty: 0 }
  const rides = new Map()

  // 1) 游玩日当天的团：自动补齐尾款（模拟领队现场结清）
  const dueGroups = db.prepare("SELECT * FROM group_orders WHERE visit_day=? AND status='confirmed'").all(day)
  for (const g of dueGroups) {
    const due = Math.max(0, g.receivable_amount - g.deposit_amount - g.paid_balance + g.refunded_amount)
    if (due > 0) payBalance(g.id, due, { requestId: `auto-grp-balance-${g.id}-${ctx.tick()}` })
  }

  // 2) 到点行程：入园优先，逐团按行程时刻自动核销剩余人数（已人工分批核销的只补剩余）
  const groups = db.prepare("SELECT * FROM group_orders WHERE visit_day=? AND status IN ('confirmed','settled') ORDER BY id").all(day)
  for (const g of groups) {
    const items = getItems(g.id).filter(i => ['active', 'rerouted'].includes(i.status) && i.slot_hour === hour)
    // 入园行程先于设施
    items.sort((a, b) => a.kind === 'entry' ? -1 : b.kind === 'entry' ? 1 : 0)
    for (const item of items) {
      const remain = item.qty - item.checked_qty - item.refunded_qty
      if (remain <= 0) continue
      if (item.kind === 'ride') {
        const en = entryItem(g.id)
        if (!en || en.checked_qty <= 0) continue   // 尚未入园，设施核销等待入园批次
      }
      const r = checkinGroupItem(item.id, remain, { requestId: `auto-grp-checkin-${item.id}-${ctx.tick()}`, source: 'auto' })
      if (r.ok) {
        if (item.kind === 'entry') entry.qty += remain
        else rides.set(item.ride_id, (rides.get(item.ride_id) || 0) + remain)
      }
    }
  }

  // 3) 跨天爽约结案：昨日及以前未完成的团，未核销行程没收已付部分；挂起行程按园方原因退回
  expireGroupNoShow()
  return { entry: entry.qty, rides }
}

// 爽约结案：在途未核销行程按已付比例没收（违约收入）；停运挂起行程园方退回；名额转 noshow
export function expireGroupNoShow() {
  const rows = db.prepare("SELECT * FROM group_orders WHERE status IN ('confirmed','settled') AND visit_day<?").all(ctx.day())
  let forfeited = 0
  for (const g of rows) {
    runAtomic(() => {
      const items = getItems(g.id)
      for (const item of items) {
        const remain = item.qty - item.checked_qty - item.refunded_qty
        if (remain <= 0) continue
        if (item.status === 'interrupted') {
          // 园方停运且一直未安排：直接按园方原因退回已付部分（旧名额已在挂起时释放，不再动库存）
          const r0 = refundInterruptedItem(item.id, { requestId: `auto-grp-intrefund-${item.id}` })
          if (r0.ok) continue
        }
        if (!['active', 'rerouted'].includes(item.status)) continue
        const share = remain * item.unit_price
        const ratio = payRatio(getGroup(g.id))
        const paidShare = Math.round(share * ratio)
        if (item.reservation_id && item.slot_id) {
          db.prepare('UPDATE reservation_slots SET noshow_count=noshow_count+? WHERE id=?').run(remain, item.slot_id)
          db.prepare("UPDATE reservations SET status='noshow', reason='noshow', closed_tick=?, closed_day=? WHERE id=?")
            .run(ctx.tick(), ctx.day(), item.reservation_id)
        }
        db.prepare('UPDATE group_items SET status=? WHERE id=?').run('noshow', item.id)
        db.prepare('UPDATE group_orders SET fee_amount=fee_amount+?, receivable_amount=MAX(0,receivable_amount-?) WHERE id=?')
          .run(paidShare, share, g.id)
        if (paidShare > 0) {
          fin('违约', paidShare, `团队 ${g.code} 爽约，未核销 ${remain} 人已付部分没收`)
          addPayment(g.id, 'noshow', paidShare, '团队爽约没收订金/尾款')
        }
        forfeited += paidShare
        logGroup(g.id, 'noshow', `${item.kind === 'entry' ? '入园' : '设施'}行程 ${remain} 人未到场，按爽约没收 ¥${paidShare}`)
      }
      maybeComplete(g.id)
    })
  }
  return forfeited
}

// 设施拆除：该设施全部团行程按园方原因直接回退团款并释放名额（不挂起、不尝试重排）
export function refundGroupsByRide(rideId) {
  const rows = db.prepare(`SELECT r.* FROM reservations r
                           WHERE r.scope='ride' AND r.ride_id=? AND r.status='booked'
                           AND r.source='group' AND r.group_item_id IS NOT NULL`).all(rideId)
  let n = 0
  for (const r of rows) {
    const item = getItem(r.group_item_id)
    if (!item || !['active', 'rerouted', 'interrupted'].includes(item.status)) continue
    if (item.status === 'interrupted') {
      refundInterruptedItem(item.id, { requestId: `auto-grp-destroy-${item.id}` })
      continue
    }
    const remain = item.qty - item.checked_qty - item.refunded_qty
    if (remain > 0) {
      sliceItemRefund(item, remain, 'park', '设施拆除，园方对团队行程全额回退团款')
      n += remain
    }
  }
  return n
}

// ---------------- 查询 ----------------
const GROUP_STATUS_NAMES = {
  pending: '待确认', confirmed: '已锁定·待尾款', settled: '已结清', completed: '已完成',
  cancelled: '已撤回', rejected: '已拒绝', closed_noshow: '爽约结案'
}

function enrichGroup(g) {
  const items = getItems(g.id).map(i => ({
    ...i,
    ride_name: i.ride_id ? (db.prepare('SELECT name FROM rides WHERE id=?').get(i.ride_id)?.name || `设施#${i.ride_id}`) : '',
    remain: Math.max(0, i.qty - i.checked_qty - i.refunded_qty),
    status_name: ITEM_STATUS_NAMES[i.status] || i.status
  }))
  const balanceDue = Math.max(0, g.receivable_amount - g.deposit_amount - g.paid_balance + g.refunded_amount)
  const totalChecked = items.reduce((s, i) => s + i.checked_qty, 0)
  const interrupted = items.filter(i => i.status === 'interrupted').length
  return {
    ...g,
    status_name: GROUP_STATUS_NAMES[g.status] || g.status,
    items,
    balance_due: balanceDue,
    net_paid: g.deposit_amount + g.paid_balance - g.refunded_amount,
    total_checked: totalChecked,
    interrupted_count: interrupted
  }
}

const ITEM_STATUS_NAMES = {
  pending: '待锁定', active: '待核销', rerouted: '已重排·待核销', interrupted: '停运挂起',
  refund_park: '园方退款', refund_guest: '领队退团', noshow: '爽约', checked: '已核销'
}

export function listGroups({ status = null, day = null, limit = 100 } = {}) {
  const conds = []
  const vals = []
  if (status && status !== 'all') { conds.push('status=?'); vals.push(status) }
  if (day) { conds.push('visit_day=?'); vals.push(num(day)) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM group_orders ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 100))
  return rows.map(enrichGroup)
}

export function groupDetail(id) {
  const g = getGroup(id)
  if (!g) return null
  const payments = db.prepare('SELECT * FROM group_payments WHERE group_id=? ORDER BY id').all(id)
  const checkins = db.prepare('SELECT * FROM group_checkins WHERE group_id=? ORDER BY id').all(id)
  const logs = db.prepare('SELECT * FROM group_logs WHERE group_id=? ORDER BY id').all(id)
  return { group: enrichGroup(g), payments, checkins, logs }
}

export function groupStats() {
  const day = ctx.day()
  const get0 = sql => db.prepare(sql).get()
  const getD = sql => db.prepare(sql).get(day)
  const pending = get0("SELECT COUNT(*) n FROM group_orders WHERE status='pending'").n
  const pendingQty = get0("SELECT COALESCE(SUM(qty),0) q FROM group_orders WHERE status='pending'").q
  const todayGroups = getD("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM group_orders WHERE visit_day=? AND status IN ('confirmed','settled')")
  const activeToday = todayGroups.n
  const activeQtyToday = todayGroups.q
  const interrupted = get0("SELECT COUNT(*) n FROM group_items WHERE status='interrupted'").n
  const depositToday = getD("SELECT COALESCE(SUM(amount),0) s FROM group_payments WHERE kind='deposit' AND day=?").s
  const balanceToday = getD("SELECT COALESCE(SUM(amount),0) s FROM group_payments WHERE kind='balance' AND day=?").s
  const refundToday = getD("SELECT COALESCE(SUM(-amount),0) s FROM group_payments WHERE kind LIKE 'refund%' AND day=?").s
  const checkedToday = getD(`SELECT COALESCE(SUM(gi.checked_qty),0) q FROM group_items gi
                            JOIN group_orders g ON g.id=gi.group_id
                            WHERE gi.kind='entry' AND g.visit_day=?`).q
  return {
    pending, pendingQty, activeToday, activeQtyToday, interrupted,
    depositToday, balanceToday, refundToday, checkedToday
  }
}

export const GROUP_CONST = { MIN_GROUP_QTY, MAX_GROUP_QTY, GENERATE_DAYS, ENTRY_HOURS, RIDE_HOURS, STATUS_NAMES: GROUP_STATUS_NAMES }
