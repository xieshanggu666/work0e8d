import db, { getSetting, setSetting, tx } from './db.js'

// 游客会员与权益中心：
// 注册建档 → 购卡/续费/升级（等级流转）→ 消费赚积分（票务/预约/商铺）→ 积分兑换权益
// （储值/消费券/免票券/快速通行券）→ 权益在预约与商铺核销 → 退款补偿积分回退/权益返还
// 冻结/解冻、到期降级、运营人员归属、运营配置，全部留痕（订单/积分流水/生命周期日志）。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// ---------------- 业务错误码（与预约模块一致：code + reqId 可追踪） ----------------
export const MEMBER_ERR = {
  NOT_FOUND: 'MEMBER_NOT_FOUND',
  FROZEN: 'MEMBER_FROZEN',
  DISABLED: 'MEMBER_CENTER_DISABLED',
  PHONE_DUP: 'MEMBER_PHONE_DUPLICATE',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  CARD_INACTIVE: 'CARD_INACTIVE',
  DOWNGRADE: 'MEMBER_DOWNGRADE_NOT_ALLOWED',
  INSUF_BALANCE: 'INSUFFICIENT_BALANCE',
  INSUF_POINTS: 'INSUFFICIENT_POINTS',
  BENEFIT_NOT_FOUND: 'BENEFIT_NOT_FOUND',
  BENEFIT_UNUSABLE: 'BENEFIT_UNUSABLE',
  BENEFIT_MISMATCH: 'BENEFIT_SCOPE_MISMATCH',
  VENDOR_NOT_FOUND: 'VENDOR_NOT_FOUND',
  BAD_ARG: 'MEMBER_BAD_ARGUMENT',
  TX_FAILED: 'TX_FAILED'
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })
class TxError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra }
}
function runAtomic(fn) {
  try {
    return tx(fn)
  } catch (e) {
    if (e instanceof TxError) return fail(e.code, e.message, e.extra)
    console.error('[members] 事务执行失败，已整体回滚:', e)
    return fail(MEMBER_ERR.TX_FAILED, '会员系统繁忙，本次操作未生效，请稍后重试')
  }
}
// 幂等执行：购卡/兑换/充值等写操作按 scope+requestId 缓存首次结果，双击/重放不重复扣款
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== MEMBER_ERR.TX_FAILED) {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

// 由 index.js 注入：时钟 / 现金 / 财务流水（预约模块的反向回调也在 index.js 接线）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null
}
export function initMemberContext(deps) { Object.assign(ctx, deps) }

// ---------------- 等级与配置 ----------------
const NONE_TIER = { tier: 'none', name: '普通会员', point_mul: 1, discount_entry: 1, discount_ride: 1, discount_vendor: 1 }
const TIER_NAMES = { none: '普通会员', silver: '银卡会员', gold: '金卡会员', diamond: '钻石卡会员' }
const TIER_RANK = { none: 0, silver: 1, gold: 2, diamond: 3 }

function getCardProduct(tier) {
  return db.prepare('SELECT * FROM card_products WHERE tier=?').get(tier)
}
// 会员当前有效卡：已到期按普通会员权益处理（等级降级在日结扫描落库，读取侧同样兜底）
function effectiveTier(member) {
  if (member.status === 'frozen') return { ...NONE_TIER, frozen: true }
  if (!member.card_tier || member.card_tier === 'none' || member.card_expire_day < ctx.day()) return NONE_TIER
  return getCardProduct(member.card_tier) || NONE_TIER
}
function cfgPointRate() { return Math.max(0, num(getSetting('pointRate'), 1)) }
function cfgPointsComp() { return Math.max(0, Math.round(num(getSetting('pointsComp'), 300))) }
function cfgBenefitDays() { return Math.max(1, Math.round(num(getSetting('benefitValidDays'), 30))) }
function cfgEnabled() { return String(getSetting('memberEnabled', '1')) === '1' }

// 积分：每 ¥10 实付 = pointRate 积分，再乘会员卡倍率（票务/预约/商铺统一口径）
function calcPoints(amount, mul = 1) {
  return Math.max(0, Math.floor((num(amount) / 10) * cfgPointRate() * mul))
}

// ---------------- 基础读取 / 流水 ----------------
function getMember(id) { return db.prepare('SELECT * FROM members WHERE id=?').get(id) }
function getBenefit(id) { return db.prepare('SELECT * FROM member_benefits WHERE id=?').get(id) }

function assertActiveMember(id) {
  const m = getMember(id)
  if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
  if (m.status === 'frozen') throw new TxError(MEMBER_ERR.FROZEN, '该会员账户已冻结，暂不可用，请到运营配置中解冻')
  return m
}
function touchMember(id) {
  db.prepare('UPDATE members SET last_active_tick=? WHERE id=?').run(ctx.tick(), id)
}

function logMember(memberId, action, note = '', staffId = null) {
  db.prepare('INSERT INTO member_logs(member_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(memberId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}

// 积分变动（必须在事务内调用）：delta 正=获取，负=消费/回退；余额永不为负
function addPoints(memberId, delta, source, refType = '', refId = null, note = '') {
  const m = getMember(memberId)
  if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
  const before = m.points
  const after = Math.max(0, before + delta)
  const real = after - before   // 受余额下限约束后的实际变动（回退最多扣到 0）
  db.prepare('UPDATE members SET points=?, total_points=total_points+? WHERE id=?')
    .run(after, real > 0 ? real : 0, memberId)
  db.prepare(`INSERT INTO member_point_logs(member_id,change,balance_after,source,ref_type,ref_id,day,tick,note)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(memberId, real, after, source, refType, refId ?? null, ctx.day(), ctx.tick(), note)
  return { change: real, after }
}

// 发放权益（必须在事务内）：券类按全局有效期，开卡赠送可指定随卡有效期（expireDay）
function grantBenefit(memberId, kind, { amount = 0, source, refId = null, expireDay = null, qty = 1 } = {}) {
  const ids = []
  const exp = expireDay ?? ctx.day() + cfgBenefitDays()
  for (let i = 0; i < qty; i++) {
    const r = db.prepare(`INSERT INTO member_benefits(member_id,kind,source,ref_id,amount,status,expire_day,created_tick,created_day)
                          VALUES(?,?,?,?,?,'unused',?,?,?)`)
      .run(memberId, kind, source, refId, amount, exp, ctx.tick(), ctx.day())
    ids.push(Number(r.lastInsertRowid))
  }
  return ids
}

// ---------------- 注册 / 购卡 / 充值 ----------------
export function registerMember({ name = '', phone = '', staffId = null } = {}) {
  if (!cfgEnabled()) return fail(MEMBER_ERR.DISABLED, '会员体系已停用，暂不接受新会员注册')
  const p = String(phone || '').trim()
  const nm = String(name || '').trim().slice(0, 12) || '游客会员'
  return runAtomic(() => {
    if (p) {
      const dup = db.prepare('SELECT id FROM members WHERE phone=?').get(p)
      if (dup) throw new TxError(MEMBER_ERR.PHONE_DUP, '该手机号已注册会员，可直接检索到店会员')
    }
    const r = db.prepare(`INSERT INTO members(code,name,phone,card_tier,status,join_day,owner_staff_id,created_tick,last_active_tick)
                          VALUES(?,?,?,'none','active',?,?,?,?)`)
      .run('', nm, p, ctx.day(), staffId ?? null, ctx.tick(), ctx.tick())
    const id = Number(r.lastInsertRowid)
    const code = 'HY' + String(id).padStart(4, '0')
    db.prepare('UPDATE members SET code=? WHERE id=?').run(code, id)
    logMember(id, 'register', `前台注册会员${p ? `（${p}）` : ''}`, staffId)
    return { ok: true, id, code }
  })
}

// 购卡 / 续费 / 升级（幂等）：全额支付卡价；新卡/续费按到期日续期，升级同样从较晚到期日起算
export function applyCard(memberId, tier, { requestId = '', staffId = null } = {}) {
  if (!cfgEnabled()) return fail(MEMBER_ERR.DISABLED, '会员体系已停用，暂不可购卡')
  return idempotent('member_card', requestId, () => runAtomic(() => {
    const member = assertActiveMember(memberId)
    const card = getCardProduct(tier)
    if (!card) throw new TxError(MEMBER_ERR.CARD_NOT_FOUND, '卡种不存在')
    if (!card.active) throw new TxError(MEMBER_ERR.CARD_INACTIVE, '该卡种已停售')

    const curTier = member.card_tier === 'none' || member.card_expire_day < ctx.day() ? 'none' : member.card_tier
    let type
    if (curTier === 'none') type = 'new'
    else if (curTier === tier) type = 'renew'
    else if (TIER_RANK[tier] > TIER_RANK[curTier]) type = 'upgrade'
    else throw new TxError(MEMBER_ERR.DOWNGRADE, '高等级卡有效期内不可降级，可续费现卡或待到期后再办理')

    const price = card.price
    if (ctx.cash !== undefined && ctx.cash() < price) {
      throw new TxError('CASH_NOT_ENOUGH', `资金不足，办理${card.name}需 ¥${price.toLocaleString()}`)
    }
    // 有效期含购卡当日：今天购买 N 天卡 → 第 day+N-1 天为到期日；续费/升级从较晚到期日续期
    const newExpire = Math.max(member.card_expire_day, ctx.day() - 1) + card.valid_days

    // 订单 + 收款 + 财务入账
    const or = db.prepare('INSERT INTO member_orders(code,member_id,type,tier,price,staff_id,day,tick,note) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('', memberId, type, tier, price, staffId ?? null, ctx.day(), ctx.tick(),
        type === 'new' ? `购买${card.name}` : type === 'renew' ? `续费${card.name}` : `升级为${card.name}`)
    const oid = Number(or.lastInsertRowid)
    const ocode = 'HK' + String(oid).padStart(4, '0')
    db.prepare('UPDATE member_orders SET code=? WHERE id=?').run(ocode, oid)
    setSetting('cash', Math.round(ctx.cash() + price))
    ctx.logFinance?.(ctx.day(), '会员卡', price,
      `${ocode} ${member.code} ${type === 'new' ? '购买' : type === 'renew' ? '续费' : '升级'}${card.name}（${card.valid_days} 日有效）`)

    // 卡等级 / 到期日落库，归属运营人员
    db.prepare('UPDATE members SET card_tier=?, card_expire_day=?, owner_staff_id=COALESCE(owner_staff_id,?), last_active_tick=? WHERE id=?')
      .run(tier, newExpire, staffId ?? null, ctx.tick(), memberId)

    // 开卡权益：免票券 / 消费券 / 快速通行券（随卡有效期），开卡赠积分
    if (card.give_ticket) grantBenefit(memberId, 'ticket', { source: 'card', refId: oid, expireDay: newExpire, qty: card.give_ticket, amount: 0 })
    if (card.give_voucher) grantBenefit(memberId, 'voucher', { source: 'card', refId: oid, amount: num(getSetting('voucherFace'), 30), expireDay: newExpire, qty: card.give_voucher })
    if (card.give_fastpass) grantBenefit(memberId, 'fastpass', { source: 'card', refId: oid, expireDay: newExpire, qty: card.give_fastpass, amount: 0 })
    if (card.bonus_points) addPoints(memberId, card.bonus_points, 'card', 'order', oid, `办理${card.name}赠送积分`)

    const perks = []
    if (card.give_ticket) perks.push(`免票券×${card.give_ticket}`)
    if (card.give_voucher) perks.push(`消费券×${card.give_voucher}`)
    if (card.give_fastpass) perks.push(`快速通行券×${card.give_fastpass}`)
    if (card.bonus_points) perks.push(`${card.bonus_points} 积分`)
    logMember(memberId, type,
      `${type === 'new' ? '购买' : type === 'renew' ? '续费' : '升级'}${card.name}，支出 ¥${price}，有效期至第 ${newExpire} 天${perks.length ? '，赠 ' + perks.join('、') : ''}`,
      staffId)
    return { ok: true, id: oid, code: ocode, type, tier, price, expire_day: newExpire }
  }))
}

// 储值充值：现金即时入账（负债，会员消费时才确认商业收入）
export function topup(memberId, amount, { requestId = '', staffId = null } = {}) {
  const amt = Math.round(num(amount))
  if (!amt || amt < 10 || amt > 50000) return fail(MEMBER_ERR.BAD_ARG, '充值金额需在 ¥10 ~ ¥50,000 之间')
  if (!cfgEnabled()) return fail(MEMBER_ERR.DISABLED, '会员体系已停用')
  return idempotent('member_topup', requestId, () => runAtomic(() => {
    const m = assertActiveMember(memberId)
    setSetting('cash', Math.round(ctx.cash() + amt))
    db.prepare('UPDATE members SET balance=balance+?, last_active_tick=? WHERE id=?').run(amt, ctx.tick(), memberId)
    ctx.logFinance?.(ctx.day(), '会员储值', amt, `${m.code} 会员卡储值充值`)
    logMember(memberId, 'topup', `储值充值 ¥${amt}，余额 ¥${m.balance + amt}`, staffId)
    return { ok: true, balance: m.balance + amt }
  }))
}

// ---------------- 积分兑换权益 ----------------
export function redeemPoints(memberId, productCode, { requestId = '' } = {}) {
  if (!cfgEnabled()) return fail(MEMBER_ERR.DISABLED, '会员体系已停用')
  return idempotent('member_redeem', requestId, () => runAtomic(() => {
    const m = assertActiveMember(memberId)
    const p = db.prepare('SELECT * FROM benefit_products WHERE code=? AND active=1').get(productCode)
    if (!p) throw new TxError(MEMBER_ERR.BENEFIT_NOT_FOUND, '兑换商品不存在或已下架')
    if (m.points < p.points_cost) throw new TxError(MEMBER_ERR.INSUF_POINTS, `积分不足，兑换「${p.name}」需 ${p.points_cost} 积分（当前 ${m.points}）`)

    const rr = db.prepare('INSERT INTO member_orders(code,member_id,type,tier,price,day,tick,note) VALUES(?,?,?,?,0,?,?,?)')
      .run('', memberId, 'redeem', p.kind, ctx.day(), ctx.tick(), `积分兑换 ${p.name}`)
    const rid = Number(rr.lastInsertRowid)
    const rcode = 'HF' + String(rid).padStart(4, '0')
    db.prepare('UPDATE member_orders SET code=? WHERE id=?').run(rcode, rid)

    addPoints(memberId, -p.points_cost, 'redeem', 'benefit', rid, `兑换「${p.name}」`)
    let note = `兑换「${p.name}」消耗 ${p.points_cost} 积分`
    if (p.kind === 'balance') {
      // 储值兑换：积分转为储值负债（不动现金，不产生财务收入）
      db.prepare('UPDATE members SET balance=balance+? WHERE id=?').run(p.amount, memberId)
      grantBenefit(memberId, 'balance', { amount: p.amount, source: 'redeem', refId: rid, qty: 1 })
      db.prepare("UPDATE member_benefits SET status='used', used_tick=?, used_ref_type='redeem' WHERE source='redeem' AND ref_id=? AND kind='balance' AND member_id=?")
        .run(ctx.tick(), rid, memberId)
      note += `，转入储值 ¥${p.amount}`
    } else {
      grantBenefit(memberId, p.kind, { amount: p.amount, source: 'redeem', refId: rid, qty: p.qty })
      note += `，发放 ${p.name} ×${p.qty}`
    }
    logMember(memberId, 'redeem', note)
    return { ok: true, code: rcode, kind: p.kind }
  }))
}

// ---------------- 联动票务：会员现场购优惠票（直接入园，不走预约） ----------------
export function buyEntryTicket(memberId, qty = 1, { requestId = '' } = {}) {
  const q = Math.max(1, Math.min(20, Math.round(num(qty, 1))))
  if (!cfgEnabled()) return fail(MEMBER_ERR.DISABLED, '会员体系已停用')
  return idempotent('member_ticket', requestId, () => runAtomic(() => {
    const m = assertActiveMember(memberId)
    const tier = effectiveTier(m)
    const ticket = num(getSetting('ticket'), 120)
    const unit = Math.round(ticket * tier.discount_entry)
    const amount = unit * q
    setSetting('cash', Math.round(ctx.cash() + amount))
    const pts = calcPoints(amount, tier.point_mul)
    if (pts) addPoints(memberId, pts, 'entry', 'ticket', null, `现场购票 ${q} 张（${TIER_NAMES[m.card_tier] || '普通会员'}折扣）`)
    ctx.logFinance?.(ctx.day(), '门票', amount, `${m.code} 会员现场购票 ${q} 张 · 单价 ¥${unit}`)
    logMember(memberId, 'ticket', `现场购票 ${q} 张，享 ${Math.round(tier.discount_entry * 100)} 折，实付 ¥${amount}，获 ${pts} 积分`)
    touchMember(memberId)
    return { ok: true, unit, amount, points: pts }
  }))
}

// ---------------- 联动商铺：会员消费（现金/储值/消费券，享卡折扣，赚积分） ----------------
export function vendorSpend(memberId, vendorId, { payMethod = 'cash', benefitId = null, qty = 1 } = {}) {
  const q = Math.max(1, Math.min(20, Math.round(num(qty, 1))))
  if (!cfgEnabled()) return fail(MEMBER_ERR.DISABLED, '会员体系已停用')
  return runAtomic(() => {
    const m = assertActiveMember(memberId)
    const vendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId)
    if (!vendor) throw new TxError(MEMBER_ERR.VENDOR_NOT_FOUND, '商铺不存在')
    const tier = effectiveTier(m)
    const gross = vendor.price * q
    const bill = Math.round(gross * tier.discount_vendor)

    let cashPart = 0, balancePart = 0, voucherPart = 0, usedBenefit = null
    if (payMethod === 'balance') {
      if (m.balance < bill) throw new TxError(MEMBER_ERR.INSUF_BALANCE, `储值余额不足，本单需 ¥${bill}，余额 ¥${m.balance}`)
      balancePart = bill
      db.prepare('UPDATE members SET balance=balance-? WHERE id=?').run(bill, memberId)
    } else if (payMethod === 'voucher') {
      const bn = getBenefit(num(benefitId))
      if (!bn || bn.member_id !== memberId || bn.kind !== 'voucher') throw new TxError(MEMBER_ERR.BENEFIT_NOT_FOUND, '消费券不存在')
      if (bn.status !== 'unused' || bn.expire_day < ctx.day()) throw new TxError(MEMBER_ERR.BENEFIT_UNUSABLE, '该消费券已使用或已过期')
      usedBenefit = bn
      voucherPart = Math.min(bn.amount, bill)
      cashPart = bill - voucherPart
      if (cashPart > 0) setSetting('cash', Math.round(ctx.cash() + cashPart))
      db.prepare("UPDATE member_benefits SET status='used', used_tick=?, used_ref_type='vendor', used_ref_id=? WHERE id=?")
        .run(ctx.tick(), vendorId, bn.id)
    } else {
      cashPart = bill
      setSetting('cash', Math.round(ctx.cash() + cashPart))
    }

    // 商铺确认收入：现金部分；储值部分为负债转收入（不产生新现金）
    const recognized = cashPart + balancePart
    db.prepare('UPDATE vendors SET sold=sold+?, rev=rev+? WHERE id=?').run(q, recognized, vendorId)
    if (cashPart > 0) ctx.logFinance?.(ctx.day(), '商业', cashPart, `${m.code} 会员在「${vendor.name}」现金消费`)
    if (balancePart > 0) ctx.logFinance?.(ctx.day(), '商业', balancePart, `${m.code} 会员在「${vendor.name}」储值消费（负债转收入）`)
    if (voucherPart > 0) ctx.logFinance?.(ctx.day(), '会员权益', -voucherPart, `${m.code} 核销消费券（营销成本）·「${vendor.name}」`)

    const pts = calcPoints(recognized, tier.point_mul)
    if (pts) addPoints(memberId, pts, 'vendor', 'vendor', vendorId, `「${vendor.name}」消费 ¥${recognized}（${voucherPart ? '券抵 ¥' + voucherPart : ''}）`)
    logMember(memberId, 'vendor',
      `「${vendor.name}」消费 ${q} 份：${cashPart ? `现金 ¥${cashPart} ` : ''}${balancePart ? `储值 ¥${balancePart} ` : ''}${voucherPart ? `消费券抵 ¥${voucherPart}` : ''}，获 ${pts} 积分`)
    touchMember(memberId)
    return { ok: true, bill, cashPart, balancePart, voucherPart, points: pts }
  })
}

// ---------------- 联动分时预约：报价 / 下单后 / 退款 ----------------
// 预约报价（在预约建单事务外调用做校验与计价）：会员折扣 + 免票券/快速通行券
// 返回 { gross, payable, discountMul, points, benefit:{id,kind}|null }
export function quoteReservation(memberId, { scope = 'entry', rideId = null, qty = 1, benefitId = null, entryPrice = 120, ridePrice = 30 } = {}) {
  const m = getMember(num(memberId))
  if (!m) return fail(MEMBER_ERR.NOT_FOUND, '会员不存在')
  if (m.status === 'frozen') return fail(MEMBER_ERR.FROZEN, '该会员账户已冻结，不可预约')
  const tier = effectiveTier(m)
  const mul = scope === 'entry' ? tier.discount_entry : tier.discount_ride
  const unit = scope === 'entry' ? num(entryPrice) : num(ridePrice)
  const q = Math.max(1, Math.round(num(qty, 1)))
  const gross = unit * q
  let benefit = null
  let payable = Math.round(gross * mul)
  if (benefitId) {
    const bn = getBenefit(num(benefitId))
    if (!bn || bn.member_id !== m.id) return fail(MEMBER_ERR.BENEFIT_NOT_FOUND, '权益不存在或不属于该会员')
    if (bn.status !== 'unused' || bn.expire_day < ctx.day()) return fail(MEMBER_ERR.BENEFIT_UNUSABLE, '该权益已使用或已过期')
    if (bn.kind === 'ticket') {
      if (scope !== 'entry') return fail(MEMBER_ERR.BENEFIT_MISMATCH, '免票券仅可用于分时入园预约')
      if (q !== 1) return fail(MEMBER_ERR.BENEFIT_MISMATCH, '免票券限 1 人入园使用，请将人数改为 1')
      benefit = { id: bn.id, kind: 'ticket' }
      payable = 0
    } else if (bn.kind === 'fastpass') {
      benefit = { id: bn.id, kind: 'fastpass' }   // 快速通行券：走超售名额，价格仍按会员折扣
    } else {
      return fail(MEMBER_ERR.BENEFIT_MISMATCH, '该权益不能用于预约（消费券请在商铺核销，储值请在商铺使用）')
    }
  }
  return {
    ok: true, gross, payable, discountMul: mul,
    points: calcPoints(payable, tier.point_mul), benefit
  }
}

// 预约建单成功后（在预约事务内）：核销权益 + 按实付发放积分。抛 TxError → 预约整体回滚
export function onReservationBooked({ reservationId, memberId, benefitId, amount, scope }) {
  const m = getMember(num(memberId))
  if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
  if (m.status === 'frozen') throw new TxError(MEMBER_ERR.FROZEN, '会员账户已冻结')
  if (benefitId) {
    const bn = getBenefit(num(benefitId))
    if (!bn || bn.member_id !== m.id || bn.status !== 'unused' || bn.expire_day < ctx.day()) {
      throw new TxError(MEMBER_ERR.BENEFIT_UNUSABLE, '权益不可用（可能已被使用/过期），预约未提交')
    }
    const u = db.prepare("UPDATE member_benefits SET status='used', used_tick=?, used_ref_type='reservation', used_ref_id=? WHERE id=? AND status='unused'")
      .run(ctx.tick(), reservationId, bn.id)
    if (u.changes === 0) throw new TxError(MEMBER_ERR.BENEFIT_UNUSABLE, '权益已被其他操作使用，请刷新后重试')
  }
  const tier = effectiveTier(m)
  const pts = calcPoints(amount, tier.point_mul)
  if (pts) addPoints(m.id, pts, scope === 'entry' ? 'entry' : 'ride', 'reservation', reservationId,
    `${scope === 'entry' ? '入园' : '设施'}预约实付 ¥${amount}`)
  touchMember(m.id)
  return { points: pts }
}

// 预约退款后（在退款事务内）：
// 全额退（游客提前/园方/超售）→ 返还券类权益并按比例回退积分；当日退 50% → 积分回退一半、券不返还；爽约不回退
export function onReservationRefund({ reservationId, memberId, benefitId, amount, refundAmount, fee, reason }) {
  const m = getMember(num(memberId))
  if (!m) return { ok: true }
  const full = reason !== 'late'
  if (benefitId && full) {
    db.prepare("UPDATE member_benefits SET status='unused', used_tick=0, used_ref_type='', used_ref_id=NULL WHERE id=? AND member_id=?")
      .run(benefitId, m.id)
  }
  // 找到该预约发放的积分流水，按退款比例回退（最多扣到余额 0）
  const log = db.prepare("SELECT * FROM member_point_logs WHERE member_id=? AND ref_type='reservation' AND ref_id=? AND change>0 ORDER BY id LIMIT 1")
    .get(m.id, reservationId)
  if (log && log.change > 0) {
    const ratio = amount > 0 ? (num(refundAmount) / amount) : 0   // 免票券单 amount=0，无积分可退
    const claw = Math.round(log.change * ratio)
    if (claw > 0) {
      addPoints(m.id, -claw, 'refund', 'reservation', reservationId,
        `预约 #${reservationId} 退款（${reason === 'late' ? '当日取消退 50%' : '全额退款'}），回退 ${claw} 积分${benefitId && full ? '，券类权益已返还' : ''}`)
    }
  }
  return { ok: true }
}

// ---------------- 联动投诉补偿：积分补偿结案 ----------------
export function compAwardPoints(memberId, points, complaintId, { staffId = null } = {}) {
  return runAtomic(() => {
    const m = assertActiveMember(memberId)
    const pts = Math.max(1, Math.round(num(points) || cfgPointsComp()))
    const r = addPoints(m.id, pts, 'comp', 'complaint', complaintId, `投诉 #${complaintId} 结案积分补偿`)
    logMember(m.id, 'adjust', `服务投诉结案补偿 ${pts} 积分`, staffId)
    return { ok: true, points: pts, balance: r.after }
  })
}

// ---------------- 冻结 / 解冻 / 手动调分 / 归属运营人员 ----------------
export function setFrozen(memberId, frozen, { reason = '', staffId = null } = {}) {
  return runAtomic(() => {
    const m = getMember(memberId)
    if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
    if (frozen && m.status === 'frozen') throw new TxError(MEMBER_ERR.BAD_ARG, '该会员已是冻结状态')
    if (!frozen && m.status !== 'frozen') throw new TxError(MEMBER_ERR.BAD_ARG, '该会员未处于冻结状态')
    db.prepare('UPDATE members SET status=? WHERE id=?').run(frozen ? 'frozen' : 'active', memberId)
    logMember(memberId, frozen ? 'freeze' : 'unfreeze', frozen ? `冻结账户：${reason || '运营风险管控'}` : '解冻账户恢复正常', staffId)
    return { ok: true, status: frozen ? 'frozen' : 'active' }
  })
}

export function adjustPoints(memberId, change, { note = '', staffId = null } = {}) {
  const delta = Math.round(num(change))
  if (!delta) return fail(MEMBER_ERR.BAD_ARG, '调整积分不可为 0')
  if (Math.abs(delta) > 100000) return fail(MEMBER_ERR.BAD_ARG, '单次调整不可超过 ±100,000')
  return runAtomic(() => {
    const m = getMember(memberId)
    if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
    if (m.points + delta < 0) throw new TxError(MEMBER_ERR.INSUF_POINTS, `扣减后积分将为负（当前 ${m.points}）`)
    const r = addPoints(memberId, delta, 'adjust', 'manual', null, note || (delta > 0 ? '运营手动赠送' : '运营手动扣减'))
    logMember(memberId, 'adjust', `${delta > 0 ? '+' : ''}${delta} 积分：${note || '运营调整'}`, staffId)
    return { ok: true, points: r.after }
  })
}

export function setOwner(memberId, staffId) {
  return runAtomic(() => {
    const m = getMember(memberId)
    if (!m) throw new TxError(MEMBER_ERR.NOT_FOUND, '会员不存在')
    const sid = staffId ? num(staffId) : null
    if (sid) {
      const st = db.prepare("SELECT * FROM staff WHERE id=? AND active=1").get(sid)
      if (!st) throw new TxError(MEMBER_ERR.BAD_ARG, '员工不存在或已离岗')
      if (st.role !== '会员专员') throw new TxError(MEMBER_ERR.BAD_ARG, '仅会员专员可被设为归属运营人员')
    }
    db.prepare('UPDATE members SET owner_staff_id=? WHERE id=?').run(sid, memberId)
    logMember(memberId, 'adjust', sid ? `归属运营人员变更为 #${sid}` : '取消归属运营人员')
    return { ok: true }
  })
}

// ---------------- 日结：会员卡到期降级（等级状态流转） ----------------
// 到期后 card_tier 落为 none、卡有效期清零，积分与储值保留（普通会员仍可攒分兑换），券类权益不过期仍可用
export function sweepExpiredCards(day) {
  // 到期日当天仍有效：次日（card_expire_day < day）才降级
  const rows = db.prepare("SELECT * FROM members WHERE card_tier<>'none' AND card_expire_day>0 AND card_expire_day<?").all(day)
  let n = 0
  for (const m of rows) {
    tx(() => {
      db.prepare("UPDATE members SET card_tier='none', card_expire_day=0 WHERE id=?").run(m.id)
      logMember(m.id, 'expire', `会员卡到期（原 ${TIER_NAMES[m.card_tier]}），等级降级为普通会员；积分与储值余额保留`)
    })
    n++
  }
  return n
}

// ---------------- 模拟侧：会员经济（每小时引擎调用） ----------------
// 会员按卡等级折扣自助预约入园/设施（复用预约模块事务，保证库存/幂等一致），
// 并在商铺产生消费；偶发散客在会员中心办卡（卡收入持续增长）。
let _autoBook = null
export function bindReservationAutoBook(fn) { _autoBook = fn }
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙']
function randName() { return SURNAMES[Math.floor(Math.random() * SURNAMES.length)] + '会员' }

// 由 index.js 每营业小时调用；rides/vendors 传当前快照，bookingOk 控制预约节流
export function autoMemberEconomy({ rides = [], vendors = [] } = {}) {
  if (!cfgEnabled()) return { booked: 0, spent: 0, cards: 0 }
  const hour = ctx.hour()
  if (hour < 9 || hour > 18) return { booked: 0, spent: 0, cards: 0 }
  let booked = 0, spent = 0, cards = 0

  const actives = db.prepare("SELECT * FROM members WHERE status='active'").all()
  if (!actives.length) return { booked, spent, cards }

  // 1) 会员预约：约 25% 活跃会员本时段产生一单（入园为主，金卡以上约热门设施）
  const entrySlots = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND status='open' AND day=? AND hour>=? ORDER BY day,hour LIMIT 30")
    .all(ctx.day() + 1, hour)
  const shuffled = [...actives].sort(() => Math.random() - 0.5)
  const want = Math.min(shuffled.length, Math.ceil(actives.length * 0.25))
  for (let i = 0; i < want; i++) {
    const m = shuffled[i]
    try {
      let slot, rideId = null
      const tier = effectiveTier(m)
      // 免票券（仅入园、1 人）约 40% 概率优先使用；快速通行券约 30% 概率优先走快速通道
      const ticketBn = db.prepare("SELECT * FROM member_benefits WHERE member_id=? AND kind='ticket' AND status='unused' AND expire_day>=? ORDER BY id LIMIT 1").get(m.id, ctx.day())
      const fpBn = db.prepare("SELECT * FROM member_benefits WHERE member_id=? AND kind='fastpass' AND status='unused' AND expire_day>=? ORDER BY id LIMIT 1").get(m.id, ctx.day())
      let benefitId = null
      if (ticketBn && Math.random() < 0.4) {
        benefitId = ticketBn.id
        slot = entrySlots[Math.floor(Math.random() * entrySlots.length)]
      } else if (fpBn && Math.random() < 0.3) {
        benefitId = fpBn.id
        if (TIER_RANK[m.card_tier] >= 2 && rides.length && Math.random() < 0.4) {
          const ride = rides[Math.floor(Math.random() * rides.length)]
          slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND status='open' AND (day>? OR (day=? AND hour>=?)) ORDER BY day,hour LIMIT 1")
            .get(ride.id, ctx.day(), ctx.day(), hour)
          rideId = ride.id
        } else {
          slot = entrySlots[Math.floor(Math.random() * entrySlots.length)]
        }
      } else if (TIER_RANK[m.card_tier] >= 2 && rides.length && Math.random() < 0.4) {
        const ride = rides[Math.floor(Math.random() * rides.length)]
        slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='ride' AND ride_id=? AND status='open' AND (day>? OR (day=? AND hour>=?)) ORDER BY day,hour LIMIT 1")
          .get(ride.id, ctx.day(), ctx.day(), hour)
        rideId = ride.id
      } else {
        slot = entrySlots[Math.floor(Math.random() * entrySlots.length)]
      }
      if (!slot) continue
      const ticket = num(getSetting('ticket'), 120)
      const q = quoteReservation(m.id, {
        scope: rideId ? 'ride' : 'entry', rideId, qty: 1, benefitId,
        entryPrice: ticket, ridePrice: rideId ? (rides.find(r => r.id === rideId)?.price ?? 30) : 30
      })
      if (!q.ok) continue
      const r = _autoBook?.(slot, {
        memberId: m.id, guestName: m.name === '游客会员' ? randName() : m.name,
        amount: q.payable, benefitId: q.benefit?.id ?? null
      })
      if (r?.ok) booked++
    } catch { /* 单会员失败不影响整批 */ }
  }

  // 2) 会员商铺消费：约 30% 活跃会员，支付方式按权益/余额自动选择
  const openVendors = vendors.filter(v => v)
  if (openVendors.length) {
    const buyers = Math.min(actives.length, Math.ceil(actives.length * 0.3))
    for (let i = 0; i < buyers; i++) {
      const m = actives[Math.floor(Math.random() * actives.length)]
      const v = openVendors[Math.floor(Math.random() * openVendors.length)]
      try {
        const tier = effectiveTier(m)
        const bill = Math.round(v.price * tier.discount_vendor)
        const voucher = db.prepare("SELECT * FROM member_benefits WHERE member_id=? AND kind='voucher' AND status='unused' AND expire_day>=? ORDER BY id LIMIT 1").get(m.id, ctx.day())
        let method = 'cash', benefitId = null
        if (voucher && voucher.amount >= bill && Math.random() < 0.5) { method = 'voucher'; benefitId = voucher.id }
        else if (m.balance >= bill && Math.random() < 0.6) method = 'balance'
        const r = vendorSpend(m.id, v.id, { payMethod: method, benefitId, qty: 1 })
        if (r.ok) spent += r.bill
      } catch { /* ignore */ }
    }
  }

  // 3) 办卡：约 4% 概率本时段有散客被转化（银/金/钻加权），无会员时也会拉新建档购卡
  if (Math.random() < 0.04) {
    try {
      const roll = Math.random()
      const tier = roll < 0.6 ? 'silver' : roll < 0.9 ? 'gold' : 'diamond'
      const specialists = db.prepare("SELECT id FROM staff WHERE role='会员专员' AND active=1").all()
      const staffId = specialists.length ? specialists[Math.floor(Math.random() * specialists.length)].id : null
      let memberId
      const noneMembers = db.prepare("SELECT id FROM members WHERE status='active' AND (card_tier='none' OR card_expire_day<?) ORDER BY RANDOM() LIMIT 1").get(ctx.day())
      if (noneMembers && Math.random() < 0.5) {
        memberId = noneMembers.id
      } else {
        const reg = registerMember({ name: randName(), staffId })
        if (!reg.ok) memberId = null
        else memberId = reg.id
      }
      if (memberId) {
        const r = applyCard(memberId, tier, { staffId })
        if (r.ok) cards++
      }
    } catch { /* ignore */ }
  }
  return { booked, spent, cards }
}

// ---------------- 查询 / 统计 / 配置 ----------------
function benefitCountMap(memberId) {
  const rows = db.prepare(`SELECT kind, COUNT(*) n FROM member_benefits WHERE member_id=? AND status='unused' AND expire_day>=? GROUP BY kind`)
    .all(memberId, ctx.day())
  const map = { balance: 0, voucher: 0, ticket: 0, fastpass: 0 }
  rows.forEach(r => { map[r.kind] = r.n })
  return map
}

function enrichMember(m) {
  const day = ctx.day()
  const tier = m.card_tier === 'none' ? 'none' : (m.card_expire_day < day ? 'none' : m.card_tier)
  const cardValid = m.card_tier !== 'none' && m.card_expire_day >= day
  const benefits = benefitCountMap(m.id)
  const owner = m.owner_staff_id ? db.prepare('SELECT id,name FROM staff WHERE id=?').get(m.owner_staff_id) : null
  return {
    ...m,
    tier_now: tier,
    tier_name: TIER_NAMES[tier] || '普通会员',
    card_valid: cardValid ? 1 : 0,
    card_expiring: cardValid && m.card_expire_day - day <= 3 ? 1 : 0,
    remain_days: cardValid ? m.card_expire_day - day + 1 : 0,
    benefits,
    owner_name: owner?.name || ''
  }
}

export function listMembers({ tier = null, status = null, q = '', limit = 200 } = {}) {
  const conds = []
  const vals = []
  if (tier && tier !== 'all') { conds.push('card_tier=?'); vals.push(tier) }
  if (status && status !== 'all') { conds.push('status=?'); vals.push(status) }
  if (q) { conds.push('(name LIKE ? OR phone LIKE ? OR code LIKE ?)'); vals.push(`%${q}%`, `%${q}%`, `%${q}%`) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM members ${where} ORDER BY id DESC LIMIT ?`).all(...vals, num(limit, 200))
  return rows.map(enrichMember)
}

export function memberDetail(id) {
  const m = getMember(id)
  if (!m) return null
  const orders = db.prepare('SELECT * FROM member_orders WHERE member_id=? ORDER BY id DESC LIMIT 20').all(id)
  const pointLogs = db.prepare('SELECT * FROM member_point_logs WHERE member_id=? ORDER BY id DESC LIMIT 30').all(id)
  const benefits = db.prepare('SELECT * FROM member_benefits WHERE member_id=? ORDER BY id DESC LIMIT 50').all(id)
  const logs = db.prepare('SELECT * FROM member_logs WHERE member_id=? ORDER BY id DESC LIMIT 40').all(id)
  return { member: enrichMember(m), orders, pointLogs, benefits, logs }
}

export function listCardProducts() {
  return db.prepare('SELECT * FROM card_products ORDER BY sort,id').all().map(c => ({
    ...c,
    tier_name: TIER_NAMES[c.tier] || c.name
  }))
}
export function listBenefitProducts() {
  return db.prepare('SELECT * FROM benefit_products ORDER BY sort,id').all()
}

export function getConfig() {
  return {
    enabled: cfgEnabled(),
    pointRate: cfgPointRate(),
    pointsComp: cfgPointsComp(),
    voucherFace: num(getSetting('voucherFace'), 30),
    benefitValidDays: cfgBenefitDays()
  }
}
export function saveConfig(patch = {}) {
  return runAtomic(() => {
    if (patch.enabled !== undefined) setSetting('memberEnabled', patch.enabled ? 1 : 0)
    if (patch.pointRate !== undefined) {
      const v = num(patch.pointRate, 1); if (v < 0 || v > 10) throw new TxError(MEMBER_ERR.BAD_ARG, '基准积分倍率需在 0 ~ 10 之间')
      setSetting('pointRate', v)
    }
    if (patch.pointsComp !== undefined) {
      const v = Math.round(num(patch.pointsComp, 300)); if (v < 0 || v > 10000) throw new TxError(MEMBER_ERR.BAD_ARG, '积分补偿需在 0 ~ 10000 之间')
      setSetting('pointsComp', v)
    }
    if (patch.benefitValidDays !== undefined) {
      const v = Math.round(num(patch.benefitValidDays, 30)); if (v < 1 || v > 365) throw new TxError(MEMBER_ERR.BAD_ARG, '权益有效期需在 1 ~ 365 游戏日之间')
      setSetting('benefitValidDays', v)
    }
    return { ok: true, config: getConfig() }
  })
}

// 运营配置卡种（价格/有效期/折扣/倍率/赠送；tier 主键不可改）
export function updateCardProduct(tier, patch = {}) {
  return runAtomic(() => {
    const c = getCardProduct(tier)
    if (!c) throw new TxError(MEMBER_ERR.CARD_NOT_FOUND, '卡种不存在')
    const sets = [], vals = []
    const numField = (k, key, min, max) => {
      if (patch[key] === undefined) return
      const v = num(patch[key], c[k]); if (v < min || v > max) throw new TxError(MEMBER_ERR.BAD_ARG, `字段 ${key} 超出允许范围`)
      sets.push(`${k}=?`); vals.push(v)
    }
    const intField = (k, key, min, max) => {
      if (patch[key] === undefined) return
      const v = Math.round(num(patch[key], c[k])); if (v < min || v > max) throw new TxError(MEMBER_ERR.BAD_ARG, `字段 ${key} 超出允许范围`)
      sets.push(`${k}=?`); vals.push(v)
    }
    intField('price', 'price', 0, 100000)
    intField('valid_days', 'valid_days', 1, 365)
    numField('point_mul', 'point_mul', 1, 10)
    numField('discount_entry', 'discount_entry', 0.1, 1)
    numField('discount_ride', 'discount_ride', 0.1, 1)
    numField('discount_vendor', 'discount_vendor', 0.1, 1)
    intField('give_ticket', 'give_ticket', 0, 20)
    intField('give_voucher', 'give_voucher', 0, 20)
    intField('give_fastpass', 'give_fastpass', 0, 20)
    intField('bonus_points', 'bonus_points', 0, 100000)
    if (patch.active !== undefined) { sets.push('active=?'); vals.push(patch.active ? 1 : 0) }
    if (!sets.length) return { ok: true }
    vals.push(c.id)
    db.prepare(`UPDATE card_products SET ${sets.join(',')} WHERE id=?`).run(...vals)
    return { ok: true }
  })
}

export function memberStats() {
  const day = ctx.day()
  const total = db.prepare('SELECT COUNT(*) n FROM members').get().n
  const byTier = t => db.prepare('SELECT COUNT(*) n FROM members WHERE card_tier=? AND card_expire_day>=?').get(t, day).n
  const frozen = db.prepare("SELECT COUNT(*) n FROM members WHERE status='frozen'").get().n
  const activeCards = db.prepare("SELECT COUNT(*) n FROM members WHERE card_tier<>'none' AND card_expire_day>=?").get(day).n
  const expiring = db.prepare("SELECT COUNT(*) n FROM members WHERE card_tier<>'none' AND card_expire_day>=? AND card_expire_day<=?").get(day, day + 3).n
  const pointsOutstanding = db.prepare('SELECT COALESCE(SUM(points),0) s FROM members').get().s
  const balanceLiability = db.prepare('SELECT COALESCE(SUM(balance),0) s FROM members').get().s
  const cardRevToday = db.prepare("SELECT COALESCE(SUM(price),0) s FROM member_orders WHERE type IN ('new','renew','upgrade') AND day=?").get(day).s
  const topupToday = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM finance WHERE label='会员储值' AND day=?").get(day).s
  const vendorToday = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM finance WHERE label='商业' AND detail LIKE '%会员%' AND day=?").get(day).s
  const redeemToday = db.prepare("SELECT COUNT(*) n FROM member_orders WHERE type='redeem' AND day=?").get(day).n
  const memberOrdersToday = db.prepare("SELECT COUNT(*) n FROM member_orders WHERE type IN ('new','renew','upgrade') AND day=?").get(day).n
  return {
    total, silver: byTier('silver'), gold: byTier('gold'), diamond: byTier('diamond'),
    activeCards, frozen, expiring, pointsOutstanding, balanceLiability,
    cardRevToday, topupToday, vendorToday, redeemToday, memberOrdersToday
  }
}

export const MEMBER_CONST = { TIER_NAMES, TIER_RANK }
