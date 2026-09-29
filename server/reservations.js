import db, { getSetting, setSetting, tx } from './db.js'

// 分时预约模块：入园时段 9:00~18:00；设施时段 9:00~17:00（末班需留出运行时间）
const OPEN_HOUR = 9
const ENTRY_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
const RIDE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17]
const DEFAULT_ENTRY_CAP = 400
const DEFAULT_RIDE_CAP = 220
const DEFAULT_ENTRY_OVERSELL = 20 // 入园默认 5% 超售额度对冲爽约
const GENERATE_DAYS = 3           // 始终维护今/明/后三天的库存
const CHECKIN_RATE = 0.82         // 模拟客流的自然核销（到场）概率
const LATE_CANCEL_FEE = 0.5       // 当日取消保留 50% 手续费

// ---------------- 业务错误码（前端可追踪：code + reqId 定位问题） ----------------
export const RSV_ERR = {
  NOT_FOUND: 'RSV_NOT_FOUND',              // 预约不存在
  STATUS_CONFLICT: 'RSV_STATUS_CONFLICT',  // 状态已变化（重复操作/并发冲突），需刷新
  SLOT_NOT_FOUND: 'SLOT_NOT_FOUND',
  SLOT_CLOSED: 'SLOT_CLOSED',
  SLOT_FULL: 'SLOT_FULL',
  SLOT_PAST: 'SLOT_PAST',
  SLOT_MISMATCH: 'SLOT_MISMATCH',
  RIDE_UNAVAILABLE: 'RIDE_UNAVAILABLE',
  RESCHED_SAME: 'RESCHED_SAME_SLOT',
  CHECKIN_EARLY: 'CHECKIN_TOO_EARLY',
  CHECKIN_LATE: 'CHECKIN_TOO_LATE',
  OVERBOOK_MOVED: 'OVERBOOK_AUTO_RESCHEDULED', // 超售已自动改签（业务提示，非系统故障）
  OVERBOOK_REFUNDED: 'OVERBOOK_REFUNDED',      // 超售无法安置已全额退款（业务提示）
  TX_FAILED: 'TX_FAILED'                       // 事务异常已回滚
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })

// 事务内抛出的业务错误：触发整体回滚，由 runAtomic 转换为可追踪的失败响应
class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}

// 原子执行：fn 内所有写入同事务，TxError/异常 → 回滚并返回失败响应（系统异常不缓存，允许重试）
function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    console.error('[reservations] 事务执行失败，已整体回滚:', e)
    return fail(RSV_ERR.TX_FAILED, '系统繁忙，本次操作未生效，请稍后重试')
  }
}

// 幂等执行：同一 scope+requestId 的重复请求直接返回首次结果（replay 标记），不产生重复副作用。
// 业务结果（含业务失败）都缓存，保证重试响应一致；系统异常（TX_FAILED，已回滚无副作用）不缓存，允许同键安全重试。
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== RSV_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

// 清理过期幂等键（保留最近 3 个游戏日，随 ensureSlots 每小时调用）
function cleanupIdempotencyKeys() {
  db.prepare('DELETE FROM idempotency_keys WHERE created_day < ?').run(ctx.day() - 2)
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟、财务、投诉；会员联动由 index.js 反向接线）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  ticket: () => num(getSetting('ticket'), 120),
  logFinance: null,
  createComplaint: null,
  // 领队组团联动：设施停运/时段关闭时，source='group' 的在途预约交团模块重排或退款（同事务）
  handleParkOutageGroup: null,
  // 会员联动：报价（折扣/免票券/快速通行券）、建单后（核销权益+发积分）、退款后（返还权益+回退积分）
  quoteReservation: null,
  onReservationBooked: null,
  onReservationRefunded: null
}
export function initReservationContext(deps) {
  Object.assign(ctx, deps)
}

const SLOT_SELECT = `SELECT s.*,
  (s.capacity + s.oversell - s.booked_count) AS remain,
  (s.booked_count - s.checked_count - s.refund_count) AS pending
  FROM reservation_slots s`

function getSlot(id) {
  return db.prepare(`${SLOT_SELECT} WHERE s.id=?`).get(id)
}
function getReservation(id) {
  return db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
}

function logReservation(rid, action, note = '') {
  db.prepare('INSERT INTO reservation_logs(reservation_id,tick,day,hour,action,note) VALUES(?,?,?,?,?,?)')
    .run(rid, ctx.tick(), ctx.day(), ctx.hour(), action, note)
}

function entryPrice() { return ctx.ticket() }
function ridePrice(r) { return r?.price ?? 30 }

// ---------------- 库存生成与同步 ----------------
// 确保未来 GENERATE_DAYS 天的入园 / 设施时段库存存在（幂等）
export function ensureSlots() {
  cleanupIdempotencyKeys()
  const today = ctx.day()
  const rideIds = db.prepare('SELECT id,status FROM rides').all()
  const insertEntry = db.prepare(`INSERT OR IGNORE INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell)
                                  VALUES('entry',NULL,?,?,?,?)`)
  const insertRide = db.prepare(`INSERT OR IGNORE INTO reservation_slots(scope,ride_id,day,hour,capacity,oversell,status)
                                 VALUES('ride',?,?,?,?,?,?)`)
  for (let d = 0; d < GENERATE_DAYS; d++) {
    const day = today + d
    for (const h of ENTRY_HOURS) insertEntry.run(day, h, DEFAULT_ENTRY_CAP, DEFAULT_ENTRY_OVERSELL)
    for (const r of rideIds) {
      for (const h of RIDE_HOURS) {
        insertRide.run(r.id, day, h, DEFAULT_RIDE_CAP, 0, r.status === 'operating' ? 'open' : 'closed')
      }
    }
  }
}

// 设备状态变化时联动未来时段：停运则关闭时段并强制退款在途预约；恢复则重新开放
// 关时段 + 批量退款 + 投诉在同一事务内提交，任一步失败整体回滚（不会时段关了款没退）
export function syncRideSlots(ride) {
  if (!ride) return
  return runAtomic(() => {
    if (ride.status === 'operating') {
      db.prepare(`UPDATE reservation_slots SET status='open' WHERE scope='ride' AND ride_id=? AND day>=?`)
        .run(ride.id, ctx.day())
      return { ok: true }
    }
    // 关闭/检修：关停全部时段（含历史，恢复运营时再统一开放）；在途预约园方全额退款
    db.prepare(`UPDATE reservation_slots SET status='closed' WHERE scope='ride' AND ride_id=?`)
      .run(ride.id)
    const pendingAll = db.prepare(`SELECT * FROM reservations WHERE scope='ride' AND ride_id=? AND status='booked'
                  AND (slot_day>? OR (slot_day=? AND slot_hour>=?))`).all(ride.id, ctx.day(), ctx.day(), ctx.hour())
    // 领队团预约（0 元团单，款项在团账）：交团模块同事务重排行程或全额回退团账（不自建投诉，避免重复）
    const groupRows = pendingAll.filter(r => r.source === 'group' && r.group_item_id)
    const guestRows = pendingAll.filter(r => !(r.source === 'group' && r.group_item_id))
    if (groupRows.length && ctx.handleParkOutageGroup) {
      ctx.handleParkOutageGroup(groupRows, { type: 'ride', ride: { id: ride.id, name: ride.name }, reason: ride.status === 'maintenance' ? 'maintenance' : 'closed' })
    }
    forceRefundByPark(
      guestRows,
      `关联设施「${ride.name}」${ride.status === 'maintenance' ? '检修' : '关闭'}，园方强制退款`,
      { title: `设施故障 · ${ride.name}`, skipComplaint: groupRows.length > 0 }
    )
    return { ok: true }
  })
}

// 园方原因强制全额退款（设备停运 / 超售无法改签）：款全额退回，生成投诉工单
// 不自建事务：在调用方（syncRideSlots / updateSlot）的事务内逐单退款，
// 任一单失败即抛出 → 外层整体回滚（不会时段关了款没退完 / 部分单半完成）
function forceRefundByPark(rows, note, complaintInfo = {}) {
  let n = 0
  for (const rsv of rows) {
    refundOne(rsv, 'park', note, { skipComplaint: true })
    n += rsv.qty
  }
  if (rows.length && ctx.createComplaint) {
    const anyRide = rows[0].ride_id ? db.prepare('SELECT * FROM rides WHERE id=?').get(rows[0].ride_id) : null
    ctx.createComplaint({
      category: complaintInfo.category || (anyRide ? 'facility' : 'service'),
      severity: complaintInfo.severity || 2,
      title: complaintInfo.title || `预约爽约补偿 · ${anyRide?.name || '园区'}`,
      content: complaintInfo.content || `已预约 ${rows.length} 单被园方取消，虽已全额退款，但行程受影响，游客要求说法。`,
      target: anyRide ? { type: 'ride', id: anyRide.id, name: anyRide.name } : { type: '', id: null, name: '' },
      source: 'guest'
    })
  }
  return n
}

// ---------------- 下单 / 改签 / 退款 ----------------
// 核心一致性：建单+扣库存+预收款+流水+日志在同一事务提交；库存用条件更新原子扣减，
// 容量不足/时段关闭时条件更新命中 0 行 → 抛 TxError 整体回滚，不留半完成状态
function bookSlot(slot, { guest_name, guest_phone, qty, amount, scope, rideId, source, memberId = null, benefitId = null, fastpass = false }) {
  return runAtomic(() => {
    // 库存原子校验+扣减：普通单要求真实余位（容量+超售额度）；
    // 快速通行券单不受真实余位约束，仅受 2 倍总名额的硬上限保护（防极端超卖）
    let claim
    if (fastpass) {
      claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                          WHERE id=? AND status='open' AND (capacity+oversell)*2-booked_count>=?`)
        .run(qty, slot.id, qty)
    } else {
      claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                          WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`)
        .run(qty, slot.id, qty)
    }
    if (claim.changes === 0) {
      const cur = getSlot(slot.id)
      if (!cur || cur.status !== 'open') throw new TxError(RSV_ERR.SLOT_CLOSED, '该时段已关闭预约')
      if (fastpass) throw new TxError(RSV_ERR.SLOT_FULL, '该时段快速通道名额也已用尽，请改选其他时段')
      throw new TxError(RSV_ERR.SLOT_FULL,
        `该时段余量不足，仅剩 ${Math.max(0, cur.remain)} 个名额${cur.oversell > 0 ? `（含 ${cur.oversell} 超售额度）` : ''}`)
    }
    const result = db.prepare(`INSERT INTO reservations(code,guest_name,guest_phone,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day,member_id,benefit_id)
                               VALUES(?,?,?,?,?,?,?,?,?,?,'booked',?,?,?,?,?)`)
      .run('', guest_name || '游客', guest_phone || '', scope, rideId, slot.id, slot.day, slot.hour,
           qty, amount, source || 'guest', ctx.tick(), ctx.day(), memberId, benefitId)
    const id = Number(result.lastInsertRowid)
    const code = 'YY' + String(id).padStart(4, '0')
    db.prepare('UPDATE reservations SET code=? WHERE id=?').run(code, id)
    // 预收款即时入账（现金制：下单即确认收入，核销不重复收费；免票券 0 元单只做权益核销留痕）
    setSetting('cash', Math.round(ctx.cash() + amount))
    if (amount > 0) {
      ctx.logFinance?.(ctx.day(), scope === 'entry' ? '门票' : '游乐', amount,
        `预约预收 ${code} · ${slot.day}日${slot.hour}:00 ${scope === 'entry' ? '入园' : '设施'} · ${qty} 人${memberId ? '（会员）' : ''}${benefitId ? ' · 权益支付' : ''}`)
    } else {
      ctx.logFinance?.(ctx.day(), '会员权益', 0, `预约 ${code} · 会员免票券核销（0 元单）`)
    }
    // 会员权益核销 + 积分发放（同事务）；抛错整体回滚，不会收了款却把券核销丢了
    if (memberId && ctx.onReservationBooked) {
      ctx.onReservationBooked({ reservationId: id, memberId, benefitId, amount, scope })
    }
    logReservation(id, source === 'auto' ? 'auto_book' : 'create',
      `${scope === 'entry' ? '入园' : '设施'}预约 ${slot.day}日 ${slot.hour}:00 · ${qty} 人 · 预收 ¥${amount}${fastpass ? ' · 快速通行券' : ''}`)
    return { ok: true, id, code }
  })
}

// 会员模拟下单入口：金额/快速通行标记已由 members.quoteReservation 核定，库存与权益在同事务保证一致。
// 不走幂等键（模拟流量每单独立），库存不足/时段关闭直接返回失败由调用方容错跳过。
export function autoBookMember(slot, { memberId, guestName = '会员', amount = 0, benefitId = null }) {
  const isFp = benefitId ? db.prepare("SELECT kind FROM member_benefits WHERE id=?").get(benefitId)?.kind === 'fastpass' : false
  return bookSlot(slot, {
    guest_name: guestName, qty: 1, amount: num(amount),
    scope: slot.scope, rideId: slot.ride_id ?? null, source: 'auto',
    memberId: num(memberId), benefitId: benefitId ?? null, fastpass: isFp
  })
}

// 退款核心逻辑（不包事务）：状态条件更新（仅 booked 可退，防重复退款）→ 退现金/记流水 → 释放库存。
// 失败抛 TxError 由调用方处置：批量场景（forceRefundByPark）直接传播触发外层整体回滚；
// 单退场景由 refundReservation 包一层 runAtomic 独立事务。reason=park/overbook 全额；late 半价
function refundOne(rsv, reason, note, opts = {}) {
  const half = reason === 'late'
  const back = half ? Math.round(rsv.amount * (1 - LATE_CANCEL_FEE)) : rsv.amount
  const fee = rsv.amount - back

  // 条件更新：仅 booked → 退款态，并发/重复调用时命中 0 行则失败
  const u = db.prepare(`UPDATE reservations SET status=?, reason=?, closed_tick=?, closed_day=?, refund_amount=?, refund_fee=?
                        WHERE id=? AND status='booked'`)
    .run(half ? 'refunded_half' : 'refunded', reason, ctx.tick(), ctx.day(), back, fee, rsv.id)
  if (u.changes === 0) throw new TxError(RSV_ERR.STATUS_CONFLICT, '该预约状态已变更，退款未执行，请刷新后重试')

  if (back > 0) {
    setSetting('cash', Math.round(ctx.cash() - back))
    const label = rsv.scope === 'entry' ? '门票' : '游乐'
    ctx.logFinance?.(ctx.day(), label, -back, `预约退款 ${rsv.code}${half ? '（当日取消扣 50% 手续费）' : ''}`)
  }
  if (fee > 0) ctx.logFinance?.(ctx.day(), '违约', fee, `预约 ${rsv.code} 取消费/爽约没收`)

  // 退款/取消释放可售名额；refund_count 单独留痕，核销容量不回补
  db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?), refund_count=refund_count+? WHERE id=?')
    .run(rsv.qty, rsv.qty, rsv.slot_id)
  // 会员退款联动（同事务）：全额退返还券类权益并按退款比例回退积分；当日退 50% 只回退一半积分、券不返还
  if (rsv.member_id && ctx.onReservationRefunded) {
    ctx.onReservationRefunded({
      reservationId: rsv.id, memberId: rsv.member_id, benefitId: rsv.benefit_id || null,
      amount: rsv.amount, refundAmount: back, fee, reason
    })
  }
  logReservation(rsv.id, half ? 'cancel' : 'refund',
    `${note || '退款'}：退回 ¥${back}${fee ? `，手续费 ¥${fee}` : ''}${rsv.benefit_id && !half ? '；会员权益已返还' : ''}`)

  if (!opts.skipComplaint && reason === 'overbook' && ctx.createComplaint) {
    const ride = rsv.ride_id ? db.prepare('SELECT * FROM rides WHERE id=?').get(rsv.ride_id) : null
    ctx.createComplaint({
      category: rsv.scope === 'entry' ? 'queue' : 'facility',
      severity: 2,
      title: `超售补偿 · ${ride?.name || '分时入园'}`,
      content: `预约 ${rsv.code} 到场时名额已满（超售无法改签），已全额退款 ¥${back}，游客不满要求补偿。`,
      target: ride ? { type: 'ride', id: ride.id, name: ride.name } : { type: '', id: null, name: '' },
      source: 'guest'
    })
  }
  return { ok: true, back, fee }
}

// 统一退款入口（单笔独立事务）：游客取消 / 超售兜底 / 设施拆除等逐单容错场景使用
export function refundReservation(rsvOrId, reason = 'guest', note = '', opts = {}) {
  const rsv = typeof rsvOrId === 'object' ? rsvOrId : getReservation(rsvOrId)
  if (!rsv) return fail(RSV_ERR.NOT_FOUND, '预约不存在')
  if (rsv.status !== 'booked') {
    // 已退款单重复退款：直接返回首次退款结果（幂等，不重复扣现金）
    if (['refunded', 'refunded_half'].includes(rsv.status) && (rsv.refund_amount > 0 || rsv.refund_fee > 0)) {
      return { ok: true, back: rsv.refund_amount, fee: rsv.refund_fee, dup: true }
    }
    return fail(RSV_ERR.STATUS_CONFLICT, '当前状态不可退款')
  }
  return runAtomic(() => refundOne(rsv, reason, note, opts))
}

// 游客取消：未来时段全额退；当日取消扣 50%；时段已过不允许（走爽约流程）
// requestId 幂等：同一请求重放返回首次退款结果，不重复扣现金
export function cancelReservation(id, requestId = '') {
  return idempotent('cancel', requestId, () => {
    const rsv = getReservation(id)
    if (!rsv) return fail(RSV_ERR.NOT_FOUND, '预约不存在')
    if (rsv.status !== 'booked') return fail(RSV_ERR.STATUS_CONFLICT, '当前状态不可取消（可能已核销/退款/爽约）')
    if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour <= ctx.hour())) {
      return fail(RSV_ERR.SLOT_PAST, '入园时段已开始/结束，不可取消；未到场将按爽约处理')
    }
    const late = rsv.slot_day === ctx.day()
    return refundReservation(rsv, late ? 'late' : 'guest', late ? '游客当日取消' : '游客提前取消')
  })
}

// 改签：目标时段有余量才可改；目标原子占用 → 预约单条件更新 → 原时段释放，全部在同一事务
// requestId 幂等：同一改签请求重放不产生二次库存转移
export function rescheduleReservation(id, targetSlotId, requestId = '') {
  return idempotent('reschedule', requestId, () => {
    const rsv = getReservation(id)
    if (!rsv) return fail(RSV_ERR.NOT_FOUND, '预约不存在')
    if (rsv.status !== 'booked') return fail(RSV_ERR.STATUS_CONFLICT, '当前状态不可改签')
    if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour < ctx.hour())) {
      return fail(RSV_ERR.SLOT_PAST, '原时段已过期，不可改签')
    }
    const target = getSlot(num(targetSlotId))
    if (!target || target.scope !== rsv.scope || (rsv.scope === 'ride' && target.ride_id !== rsv.ride_id)) {
      return fail(RSV_ERR.SLOT_MISMATCH, '改签目标时段无效')
    }
    if (target.status !== 'open') return fail(RSV_ERR.SLOT_CLOSED, '目标时段已关闭预约')
    if (target.id === rsv.slot_id) return fail(RSV_ERR.RESCHED_SAME, '目标时段与原时段相同')
    if (target.remain < rsv.qty) return fail(RSV_ERR.SLOT_FULL, `目标时段余量不足（剩 ${target.remain}）`)

    return runAtomic(() => {
      // 1) 目标时段原子占用（开放且余量充足才命中）
      const claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                                WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`)
        .run(rsv.qty, target.id, rsv.qty)
      if (claim.changes === 0) {
        const cur = getSlot(target.id)
        if (!cur || cur.status !== 'open') throw new TxError(RSV_ERR.SLOT_CLOSED, '目标时段已关闭预约')
        throw new TxError(RSV_ERR.SLOT_FULL, `目标时段余量不足（剩 ${Math.max(0, cur.remain)}）`)
      }
      // 2) 预约单条件更新：仅 booked 且仍挂原时段才成功，防止并发/重复改签
      const u = db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=?
                            WHERE id=? AND status='booked' AND slot_id=?`)
        .run(target.id, target.day, target.hour, rsv.reschedules + 1, id, rsv.slot_id)
      if (u.changes === 0) throw new TxError(RSV_ERR.STATUS_CONFLICT, '该预约状态已变更，改签未执行，请刷新后重试')
      // 3) 原时段释放（走到这里前两步已成功；任一步抛错整体回滚，库存不会凭空蒸发或重复占用）
      db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?) WHERE id=?').run(rsv.qty, rsv.slot_id)
      logReservation(id, 'reschedule', `改签为 ${target.day}日 ${target.hour}:00（第 ${rsv.reschedules + 1} 次改签）`)
      return { ok: true, reschedules: rsv.reschedules + 1 }
    })
  })
}

// 库存原子转移：超售自动改签复用（目标占用 → 单据条件更新 → 原时段释放，同一事务）
function moveToSlot(rsv, alt) {
  return runAtomic(() => {
    const claim = db.prepare(`UPDATE reservation_slots SET booked_count=booked_count+?
                              WHERE id=? AND status='open' AND capacity+oversell-booked_count>=?`)
      .run(rsv.qty, alt.id, rsv.qty)
    if (claim.changes === 0) throw new TxError(RSV_ERR.SLOT_FULL, '备选时段余量不足')
    const u = db.prepare(`UPDATE reservations SET slot_id=?, slot_day=?, slot_hour=?, reschedules=reschedules+1
                          WHERE id=? AND status='booked'`)
      .run(alt.id, alt.day, alt.hour, rsv.id)
    if (u.changes === 0) throw new TxError(RSV_ERR.STATUS_CONFLICT, '该预约状态已变更，自动改签未执行')
    db.prepare('UPDATE reservation_slots SET booked_count=MAX(0,booked_count-?) WHERE id=?').run(rsv.qty, rsv.slot_id)
    logReservation(rsv.id, 'auto_reschedule', `本场超售容量已满，自动改签到 ${alt.day}日 ${alt.hour}:00`)
    return { ok: true, alt_day: alt.day, alt_hour: alt.hour }
  })
}

// ---------------- 核销 ----------------
// 单个人工核销（运营在闸机/设施口扫码）；requestId 幂等，重复扫码不重复放行
export function checkinReservation(id, requestId = '') {
  return idempotent('checkin', requestId, () => {
    const rsv = getReservation(id)
    if (!rsv) return fail(RSV_ERR.NOT_FOUND, '预约不存在')
    if (rsv.status === 'checked') return fail(RSV_ERR.STATUS_CONFLICT, '该预约已核销，请勿重复扫码')
    if (rsv.status !== 'booked') return fail(RSV_ERR.STATUS_CONFLICT, '当前状态不可核销（可能已退款/爽约）')
    // 未到入园时段不可提前核销
    if (rsv.slot_day > ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour > ctx.hour())) {
      return fail(RSV_ERR.CHECKIN_EARLY, `未到入园时段（${rsv.slot_day}日 ${rsv.slot_hour}:00），请按时段核销`)
    }
    // 已过时段 2 小时以上视为爽约窗口已过
    if (rsv.slot_day < ctx.day() || (rsv.slot_day === ctx.day() && rsv.slot_hour < ctx.hour() - 1)) {
      return fail(RSV_ERR.CHECKIN_LATE, '该预约时段已过，未到场将按爽约处理')
    }
    const slot = getSlot(rsv.slot_id)
    // 快速通行券会员走快速通道：本场满员也直接放行，不参与超售改签/退款
    const isFastpass = rsv.benefit_id
      ? db.prepare("SELECT kind FROM member_benefits WHERE id=?").get(rsv.benefit_id)?.kind === 'fastpass'
      : false
    if (!isFastpass && slot && slot.checked_count + rsv.qty > slot.capacity) {
      const alt = findAlternativeSlot(rsv)
      if (alt) {
        const mv = moveToSlot(rsv, alt)
        if (!mv.ok) return mv
        return fail(RSV_ERR.OVERBOOK_MOVED, `本场容量已满，已为您自动改签到 ${mv.alt_day}日 ${mv.alt_hour}:00`)
      }
      const r = refundReservation(rsv, 'overbook', '本场超售且无后续时段可改签，全额退款')
      return fail(RSV_ERR.OVERBOOK_REFUNDED, `本场容量已满且无可改签时段，已全额退款 ¥${r.back ?? 0}`)
    }
    return runAtomic(() => {
      applyCheckin(rsv, slot, 'manual')
      return { ok: true }
    })
  })
}

// 核销落库：状态条件更新（仅 booked → checked），重复/并发调用命中 0 行抛错回滚
function applyCheckin(rsv, slot, source) {
  const u = db.prepare("UPDATE reservations SET status='checked', checked_tick=? WHERE id=? AND status='booked'")
    .run(ctx.tick(), rsv.id)
  if (u.changes === 0) throw new TxError(RSV_ERR.STATUS_CONFLICT, '该预约已被其他操作处理（核销/退款/爽约），请刷新查看最新状态')
  if (slot) db.prepare('UPDATE reservation_slots SET checked_count=checked_count+? WHERE id=?').run(rsv.qty, slot.id)
  logReservation(rsv.id, 'checkin', `${source === 'manual' ? '闸机扫码' : '到场自动'}核销 ${rsv.qty} 人`)
}

// 自动核销当前小时到期的预约：容量内放行；超出容量的超售名额先自动改签后段，再不行全额退款+投诉
// 每单独立事务 + 单点容错：一单处理失败不影响其余预约，失败计数随结果返回
// 返回 { entry: 实际入园人数, ride: Map<rideId, 游玩人数>, displaced: 被安置/退款人数, errors: 失败单数 }
export function autoCheckin(hour) {
  const day = ctx.day()
  // source='group' 的团预约由领队组团模块统一分批/自动核销（款项与团账联动），散客引擎不处理
  const due = db.prepare(`SELECT * FROM reservations WHERE status='booked' AND slot_day=? AND slot_hour=?
                          AND (source IS NULL OR source<>'group' OR group_item_id IS NULL)`).all(day, hour)
  const entryArrivals = { qty: 0 }
  const rideArrivals = new Map()
  let displaced = 0
  let errors = 0

  for (const rsv of due) {
    try {
      const slot = getSlot(rsv.slot_id)
      // 模拟到场率：未到场者留给小时末爽约处理
      if (rsv.source !== 'manual' && Math.random() > CHECKIN_RATE) continue

      // 快速通行券会员走快速通道：本场满员也直接放行
      const isFastpass = rsv.benefit_id
        ? db.prepare("SELECT kind FROM member_benefits WHERE id=?").get(rsv.benefit_id)?.kind === 'fastpass'
        : false
      const within = isFastpass || (slot && slot.checked_count + rsv.qty <= slot.capacity)
      if (within) {
        const r = runAtomic(() => { applyCheckin(rsv, slot, 'auto'); return { ok: true } })
        if (!r.ok) { errors++; continue }   // 状态冲突（如刚被人工退款）：跳过本单
        if (rsv.scope === 'entry') entryArrivals.qty += rsv.qty
        else rideArrivals.set(rsv.ride_id, (rideArrivals.get(rsv.ride_id) || 0) + rsv.qty)
        continue
      }
      // 超售：尝试同日后续有空余的时段（库存原子转移）
      const alt = findAlternativeSlot(rsv)
      const mv = alt ? moveToSlot(rsv, alt) : { ok: false }
      if (mv.ok) {
        displaced += rsv.qty
      } else {
        // 无可改签或备选时段被占满 → 全额退款兜底（事务内完成）
        refundReservation(rsv, 'overbook', '本场超售且无后续时段可改签，全额退款')
        displaced += rsv.qty
      }
    } catch (e) {
      errors++
      console.error(`[reservations] 自动核销预约 #${rsv.id} 处理失败（已跳过，不影响其他预约）:`, e)
    }
  }
  return { entry: entryArrivals.qty, ride: rideArrivals, displaced, errors }
}

// 为超售预约寻找当前或未来仍开放、真实容量有余（非超售名额）的同类时段
function findAlternativeSlot(rsv) {
  const rows = db.prepare(`${SLOT_SELECT} WHERE s.scope=? AND s.status='open'
    AND (s.day>? OR (s.day=? AND s.hour>?))
    ${rsv.scope === 'ride' ? 'AND s.ride_id=?' : ''}
    ORDER BY s.day, s.hour`).all(rsv.scope, ctx.day(), ctx.day(), ctx.hour(),
      ...(rsv.scope === 'ride' ? [rsv.ride_id] : []))
  // 改签必须落在目标时段真实容量内（含当前已核销占用），且仍有可售名额
  return rows.find(s =>
    s.checked_count + rsv.qty <= s.capacity &&
    s.capacity + s.oversell - s.booked_count >= rsv.qty
  )
}

// 爽约：所有已过时段未核销的预约（含跨天兜底）标记 noshow，预收款没收（记入「违约」），释放爽约计数
// 整批一个事务；状态条件更新保证与退款/核销并发时不会重复没收
export function expireNoShow(hour) {
  const day = ctx.day()
  // 领队团预约由组团模块统一核销（款项走团账），散客爽约批处理不触达
  const due = db.prepare(`SELECT * FROM reservations WHERE status='booked'
                          AND (slot_day<? OR (slot_day=? AND slot_hour<?))
                          AND (source IS NULL OR source<>'group' OR group_item_id IS NULL)`).all(day, day, hour)
  let qty = 0
  runAtomic(() => {
    for (const rsv of due) {
      const u = db.prepare("UPDATE reservations SET status='noshow', reason='noshow', closed_tick=?, closed_day=? WHERE id=? AND status='booked'")
        .run(ctx.tick(), day, rsv.id)
      if (u.changes === 0) continue   // 已被退款/核销等并发处理，跳过
      db.prepare('UPDATE reservation_slots SET noshow_count=noshow_count+? WHERE id=?').run(rsv.qty, rsv.slot_id)
      ctx.logFinance?.(day, '违约', rsv.amount, `预约 ${rsv.code} 爽约，预收款没收`)
      logReservation(rsv.id, 'noshow', `未在 ${rsv.slot_hour}:00 时段到场核销，按爽约处理，预收 ¥${rsv.amount} 不退`)
      qty += rsv.qty
    }
    return { ok: true }
  })
  return qty
}

// ---------------- 模拟客流预约（游客端需求侧） ----------------
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '林', '何']
function randomGuestName() {
  return SURNAMES[Math.floor(Math.random() * SURNAMES.length)] + '**'
}

// 每个营业小时为各开放时段补充模拟预约，填充率目标随日期衰减（越临近越满）
export function autoBookDemand(rides, base, priceFactor, repFactor) {
  if (!ENTRY_HOURS.includes(ctx.hour())) return
  const demandMul = priceFactor * repFactor
  const book = (slot, want, price, scope, rideId) => {
    if (want <= 0 || slot.status !== 'open' || slot.remain <= 0) return 0
    const qty = Math.min(slot.remain, want)
    bookSlot(slot, {
      guest_name: randomGuestName(), qty, amount: qty * price,
      scope, rideId, source: 'auto'
    })
    return qty
  }

  // 当日/次日/后日 的目标填充率（需求侧）
  const fillTargets = [0.85, 0.55, 0.3]
  for (let d = 0; d < GENERATE_DAYS; d++) {
    const day = ctx.day() + d
    const entrySlots = db.prepare(`${SLOT_SELECT} WHERE s.scope='entry' AND s.day=? ORDER BY s.hour`).all(day)
    for (const s of entrySlots) {
      // 今日已过时段不再补单
      if (day === ctx.day() && s.hour <= ctx.hour()) continue
      const booked = s.booked_count
      const target = (s.capacity + s.oversell) * fillTargets[d]
      if (booked >= target) continue
      // 每小时补目标缺口的一部分 + 随机波动
      const want = Math.round((target - booked) * (0.10 + Math.random() * 0.12) * demandMul)
      book(s, want, entryPrice(), 'entry', null)
    }
    for (const r of rides.filter(r => r.status === 'operating')) {
      const rideSlots = db.prepare(`${SLOT_SELECT} WHERE s.scope='ride' AND s.ride_id=? AND s.day=? ORDER BY s.hour`).all(r.id, day)
      for (const s of rideSlots) {
        if (day === ctx.day() && s.hour <= ctx.hour()) continue
        const attraction = 0.55 + (r.attr * (r.health / 100)) / 200   // 0.55 ~ ~1.1
        const target = (s.capacity + s.oversell) * fillTargets[d] * attraction
        if (s.booked_count >= target) continue
        const want = Math.round((target - s.booked_count) * (0.10 + Math.random() * 0.12) * demandMul)
        book(s, want, ridePrice(r), 'ride', r.id)
      }
    }
  }
}

// ---------------- 查询与统计 ----------------
function slotRideName(slot, rides) {
  if (slot.scope !== 'ride') return ''
  return rides.find(r => r.id === slot.ride_id)?.name || `设施#${slot.ride_id}`
}

export function listSlots({ scope = 'entry', rideId = null, day = null } = {}) {
  ensureSlots()
  const rides = db.prepare('SELECT id,name,status,price FROM rides').all()
  const conds = ['s.scope=?']
  const vals = [scope]
  if (day) { conds.push('s.day=?'); vals.push(num(day)) }
  if (scope === 'ride') {
    if (rideId) { conds.push('s.ride_id=?'); vals.push(num(rideId)) }
  }
  const rows = db.prepare(`${SLOT_SELECT} WHERE ${conds.join(' AND ')} ORDER BY s.day, s.hour, s.ride_id`).all(...vals)
  return rows.map(s => ({
    ...s,
    ride_name: slotRideName(s, rides),
    ride_status: s.scope === 'ride' ? (rides.find(r => r.id === s.ride_id)?.status || '') : ''
  }))
}

// 运营调度：调容量 / 超售额度 / 开关时段；调减不得低于已预约量
// 关闭时段 = 关时段 + 在途预约批量全额退款 + 投诉，同一事务提交（不会时段关了款没退完）
export function updateSlot(id, patch) {
  const s = getSlot(id)
  if (!s) return fail(RSV_ERR.SLOT_NOT_FOUND, '时段不存在')
  const sets = []
  const vals = []
  if (patch.capacity !== undefined) {
    const cap = Math.max(0, Math.round(num(patch.capacity)))
    if (cap < s.booked_count) return fail(RSV_ERR.STATUS_CONFLICT, `容量不可低于已预约人数 ${s.booked_count}`)
    sets.push('capacity=?'); vals.push(cap)
  }
  if (patch.oversell !== undefined) {
    const ov = Math.max(0, Math.min(200, Math.round(num(patch.oversell))))
    sets.push('oversell=?'); vals.push(ov)
  }
  if (patch.status !== undefined) {
    const st = ['open', 'closed'].includes(patch.status) ? patch.status : 'open'
    sets.push('status=?'); vals.push(st)
  }
  if (!sets.length) return fail(RSV_ERR.STATUS_CONFLICT, '无更新项')

  return runAtomic(() => {
    if (patch.status === 'closed') {
      // 关闭时段：在途预约园方全额退款并生成投诉
      const pendingAll = db.prepare("SELECT * FROM reservations WHERE slot_id=? AND status='booked'").all(id)
      // 领队团预约交团模块处理（重排 / 回退团账），其余园方全额退款
      const groupRows = pendingAll.filter(r => r.source === 'group' && r.group_item_id)
      const pending = pendingAll.filter(r => !(r.source === 'group' && r.group_item_id))
      if (groupRows.length && ctx.handleParkOutageGroup) {
        const ride = s.scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(s.ride_id) : null
        ctx.handleParkOutageGroup(groupRows, {
          type: s.scope,
          ride: ride || null,
          reason: 'slot_closed'
        })
      }
      if (pending.length) {
        const ride = s.scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(s.ride_id) : null
        forceRefundByPark(pending, `运营关闭 ${s.day}日 ${s.hour}:00 时段，园方强制退款`,
          { title: `${ride ? ride.name : '分时入园'} · 时段临时取消`, category: ride ? 'facility' : 'service', skipComplaint: groupRows.length > 0 })
      }
    }
    vals.push(id)
    db.prepare(`UPDATE reservation_slots SET ${sets.join(',')} WHERE id=?`).run(...vals)
    return { ok: true }
  })
}

export function listReservations({ status = null, scope = null, day = null, limit = 120, memberId = null, includeGroup = false } = {}) {
  const rides = allRideLite()
  const conds = []
  const vals = []
  if (status) { conds.push('status=?'); vals.push(status) }
  if (scope) { conds.push('scope=?'); vals.push(scope) }
  if (day) { conds.push('slot_day=?'); vals.push(num(day)) }
  if (memberId) { conds.push('member_id=?'); vals.push(num(memberId)) }
  // 团预约（source='group'）由团队模块页面管理，默认不在散客核销列表中出现
  if (!includeGroup) conds.push("(source IS NULL OR source<>'group' OR group_item_id IS NULL)")
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM reservations ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 120))
  const memberRows = db.prepare('SELECT id,code,name,card_tier FROM members').all()
  const memberMap = new Map(memberRows.map(m => [m.id, m]))
  const groupRows = db.prepare('SELECT id,code FROM group_orders').all()
  const groupMap = new Map()
  if (groupRows.length) {
    db.prepare('SELECT gi.id, g.code, g.leader_name FROM group_items gi JOIN group_orders g ON g.id=gi.group_id').all()
      .forEach(x => groupMap.set(x.id, x))
  }
  return rows.map(r => ({
    ...r,
    ride_name: r.ride_id ? (rides.find(x => x.id === r.ride_id)?.name || `设施#${r.ride_id}`) : '',
    scope_name: r.scope === 'entry' ? '分时入园' : '设施预约',
    status_name: STATUS_NAMES[r.status] || r.status,
    member_code: r.member_id ? (memberMap.get(r.member_id)?.code || '') : '',
    member_name: r.member_id ? (memberMap.get(r.member_id)?.name || '') : '',
    group_code: r.group_item_id ? (groupMap.get(r.group_item_id)?.code || '') : '',
    group_leader: r.group_item_id ? (groupMap.get(r.group_item_id)?.leader_name || '') : '',
    benefit_kind: r.benefit_id
      ? (db.prepare('SELECT kind FROM member_benefits WHERE id=?').get(r.benefit_id)?.kind || '')
      : ''
  }))
}
function allRideLite() { return db.prepare('SELECT id,name,status,price FROM rides').all() }

const STATUS_NAMES = {
  booked: '待核销', checked: '已核销', noshow: '爽约',
  refunded: '已退款', refunded_half: '退50%'
}

export function reservationLogs(id) {
  return db.prepare('SELECT * FROM reservation_logs WHERE reservation_id=? ORDER BY id').all(id)
}

// 游客端下单校验入口；requestId 幂等：同一请求号重复提交（双击/重试/刷新重发）只建一单、只收一次款
// memberId/benefitId：会员下单先经 members.quoteReservation 核价（折扣价/免票券 0 元/快速通行券），
// 权益核销与积分发放在 bookSlot 同事务内完成，价格与权益任一步失败整体回滚。
export function createReservation({ scope, rideId, slotId, qty, guest_name, guest_phone, source = 'guest', requestId = '', memberId = null, benefitId = null }) {
  return idempotent('create', requestId, () => {
    const slot = getSlot(num(slotId))
    if (!slot) return fail(RSV_ERR.SLOT_NOT_FOUND, '时段不存在')
    if (scope !== slot.scope || (scope === 'ride' && slot.ride_id !== num(rideId))) {
      return fail(RSV_ERR.SLOT_MISMATCH, '预约类型与时段不匹配')
    }
    if (slot.day < ctx.day() || (slot.day === ctx.day() && slot.hour < ctx.hour())) {
      return fail(RSV_ERR.SLOT_PAST, '不可预约已过期的时段')
    }
    const q = Math.max(1, Math.min(20, Math.round(num(qty, 1))))
    const ride = scope === 'ride' ? db.prepare('SELECT * FROM rides WHERE id=?').get(slot.ride_id) : null
    if (scope === 'ride' && (!ride || ride.status !== 'operating')) return fail(RSV_ERR.RIDE_UNAVAILABLE, '该设施当前不开放预约')
    const basePrice = scope === 'entry' ? entryPrice() : ridePrice(ride)

    // 会员核价：折扣 / 免票券（0 元单）/ 快速通行券（走快速通道名额）
    let amount = q * basePrice
    let fastpass = false
    let mId = memberId ? num(memberId) : null
    let bId = benefitId ? num(benefitId) : null
    if (mId) {
      if (!ctx.quoteReservation) return fail('MEMBER_HOOK_MISSING', '会员服务未就绪，请稍后重试')
      const quote = ctx.quoteReservation(mId, {
        scope, rideId: slot.ride_id ?? null, qty: q, benefitId: bId,
        entryPrice: entryPrice(), ridePrice: ride ? ride.price : 30
      })
      if (!quote?.ok) return fail(quote.code || RSV_ERR.RIDE_UNAVAILABLE, quote.msg || '会员核价失败')
      amount = quote.payable
      fastpass = quote.benefit?.kind === 'fastpass'
      bId = quote.benefit?.id ?? null
    } else {
      bId = null
    }
    return bookSlot(slot, { guest_name, guest_phone, qty: q, amount, scope, rideId: slot.ride_id, source, memberId: mId, benefitId: bId, fastpass })
  })
}

export function reservationStats() {
  const day = ctx.day()
  const one = sql => db.prepare(sql).get(day)
  const todaySlots = db.prepare(`SELECT
      COALESCE(SUM(capacity+oversell),0) AS cap,
      COALESCE(SUM(booked_count),0) AS booked,
      COALESCE(SUM(checked_count),0) AS checked,
      COALESCE(SUM(noshow_count),0) AS noshow,
      COALESCE(SUM(refund_count),0) AS refund
    FROM reservation_slots WHERE day=? AND scope='entry'`).get(day)
  const pending = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(qty),0) q FROM reservations WHERE status='booked' AND slot_day>=?").get(day)
  const noshowToday = one("SELECT COUNT(*) n FROM reservations WHERE status='noshow' AND closed_day=?").n
  const refundToday = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) a FROM reservations WHERE status IN ('refunded','refunded_half') AND closed_day=?")
  const checkedToday = one("SELECT COALESCE(SUM(qty),0) q FROM reservations WHERE status='checked' AND scope='entry' AND slot_day=?").q
  const refundedToday = one("SELECT COALESCE(SUM(qty),0) q FROM reservations WHERE status='refunded' AND slot_day=?").q
  const soldAhead = db.prepare("SELECT COALESCE(SUM(qty),0) q, COALESCE(SUM(amount),0) a FROM reservations WHERE status='booked' AND slot_day>?").get(day)
  // 超售待处理：落在超售名额内（预约量超过时段真实容量）的在途预约单数
  const oversoldPending = db.prepare(`SELECT COUNT(*) n FROM reservations r
    JOIN reservation_slots s ON s.id=r.slot_id
    WHERE r.status='booked' AND r.slot_day>=? AND s.booked_count > s.capacity`).get(day).n
  // 未来各日预约概况（容量日历）
  const calendar = db.prepare(`SELECT day, scope,
      COALESCE(SUM(capacity+oversell),0) AS cap,
      COALESCE(SUM(booked_count),0) AS booked,
      COALESCE(SUM(checked_count),0) AS checked
    FROM reservation_slots WHERE day>=? GROUP BY day, scope ORDER BY day`).all(day)
  return {
    todayCap: todaySlots.cap,
    todayBooked: todaySlots.booked,
    todayChecked: checkedToday,
    todayRefunded: refundedToday,
    todayFill: todaySlots.cap ? Math.round(todaySlots.booked / todaySlots.cap * 100) : 0,
    pendingOrders: pending.n,
    pendingQty: pending.q,
    noshowToday,
    refundOrdersToday: refundToday.n,
    refundAmountToday: refundToday.a,
    soldAheadQty: soldAhead.q,
    soldAheadAmount: soldAhead.a,
    oversoldPending,
    calendar
  }
}

export const RESERVATION_CONST = { OPEN_HOUR, ENTRY_HOURS, RIDE_HOURS, GENERATE_DAYS, DEFAULT_ENTRY_CAP, DEFAULT_RIDE_CAP }

// 领队组团模块复用：时段行查询（含余量）
export function getSlotById(id) { return getSlot(num(id)) }
export function findEntrySlot(day, hour) {
  return db.prepare(`${SLOT_SELECT} WHERE s.scope='entry' AND s.day=? AND s.hour=?`).get(day, hour)
}
export function findRideSlot(rideId, day, hour) {
  return db.prepare(`${SLOT_SELECT} WHERE s.scope='ride' AND s.ride_id=? AND s.day=? AND s.hour=?`).get(rideId, day, hour)
}
// 团行程重排候选：相对「原时段」之后的同类开放时段，真实容量可容纳 remain 人。
// 入园：不跨设施，可改同日更晚或之后日期；设施：优先同日更晚的其他开放设施（不擅自改日）。
// excludeRideId 传 null 时允许选回同一设施（领队手动改点）；停运自动重排则排除停运设施本身。
export function findGroupAltSlots({ kind, rideId = null, excludeRideId = null, day, hour, qty }) {
  if (kind === 'entry') {
    return db.prepare(`${SLOT_SELECT} WHERE s.scope='entry' AND s.status='open'
        AND (s.day>? OR (s.day=? AND s.hour>?))
        AND s.capacity+s.oversell-s.booked_count>=?
        ORDER BY s.day, s.hour LIMIT 8`).all(day, day, hour, qty)
  }
  const ex = excludeRideId === null ? null : num(excludeRideId)
  if (ex === null) {
    return db.prepare(`${SLOT_SELECT} WHERE s.scope='ride' AND s.status='open'
        AND s.day=? AND s.hour>?
        AND s.capacity+s.oversell-s.booked_count>=?
        ORDER BY s.hour LIMIT 12`).all(day, hour, qty)
  }
  return db.prepare(`${SLOT_SELECT} WHERE s.scope='ride' AND s.status='open'
      AND s.ride_id<>?
      AND s.day=? AND s.hour>?
      AND s.capacity+s.oversell-s.booked_count>=?
      ORDER BY s.hour LIMIT 8`).all(ex, day, hour, qty)
}
