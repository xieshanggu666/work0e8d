// 会员与权益中心一致性测试：
// 等级流转 / 积分获取与回退 / 权益核销与退款返还 / 快速通行券 / 储值消费券 /
// 冻结防护 / 购卡幂等 / 预约联动原子性（内存库隔离）
// 运行：node --test server/members.test.js（需 Node ≥ 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const M = await import('./members.js')
const RSV = await import('./reservations.js')

// ---- 共享上下文：财务流水记录；会员 ↔ 预约双向接线 ----
const finLogs = []
M.initMemberContext({ logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }) })
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: () => ({ id: 1, code: 'TS0001' }),
  quoteReservation: (...a) => M.quoteReservation(...a),
  onReservationBooked: (...a) => M.onReservationBooked(...a),
  onReservationRefunded: (...a) => M.onReservationRefund(...a)
})
M.bindReservationAutoBook((slot, p) => RSV.autoBookMember(slot, p))

const cash = () => Number(getSetting('cash'))
const member = id => db.prepare('SELECT * FROM members WHERE id=?').get(id)
const benefit = id => db.prepare('SELECT * FROM member_benefits WHERE id=?').get(id)
const pointLogs = id => db.prepare('SELECT * FROM member_point_logs WHERE member_id=? ORDER BY id').all(id)

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 100000)
  setSetting('ticket', 100)
  setSetting('pointRate', 1)
  RSV.ensureSlots()
})

test('注册建档：普通会员起步，手机号唯一约束', () => {
  const r = M.registerMember({ name: '积分测试', phone: '13900000001' })
  assert.equal(r.ok, true)
  assert.match(r.code, /^HY\d{4}$/)
  const m = member(r.id)
  assert.equal(m.card_tier, 'none')
  assert.equal(m.points, 0)
  const dup = M.registerMember({ name: '重复', phone: '13900000001' })
  assert.equal(dup.ok, false)
  assert.equal(dup.code, M.MEMBER_ERR.PHONE_DUP)
})

test('购卡：收款入账、等级流转、开卡赠积分与权益，幂等重放不重复收费', () => {
  const r = M.registerMember({ name: '购卡测试', phone: '13900000002' })
  const id = r.id
  const cash0 = cash()
  const c1 = M.applyCard(id, 'gold', { requestId: 'gold-1' })
  assert.equal(c1.ok, true)
  assert.equal(c1.type, 'new')
  assert.equal(c1.price, 699)
  assert.equal(c1.expire_day, 60)   // 第 1 天购卡，60 游戏日有效 → 第 60 天到期
  assert.equal(cash(), cash0 + 699, '购卡款即时入账')
  assert.equal(member(id).card_tier, 'gold')
  assert.equal(member(id).points, 150, '开卡赠 150 积分')
  // 金卡：1 免票券 + 2 消费券 + 1 快速通行券
  const unused = db.prepare("SELECT kind,COUNT(*) n FROM member_benefits WHERE member_id=? AND status='unused' GROUP BY kind").all(id)
  const map = Object.fromEntries(unused.map(x => [x.kind, x.n]))
  assert.deepEqual(map, { fastpass: 1, ticket: 1, voucher: 2 })
  assert.ok(finLogs.some(f => f.label === '会员卡' && f.amount === 699))

  // 同请求号重放：不重复建单收款
  const c2 = M.applyCard(id, 'gold', { requestId: 'gold-1' })
  assert.equal(c2.ok, true)
  assert.equal(c2.replay, true)
  assert.equal(cash(), cash0 + 699)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM member_orders WHERE member_id=?').get(id).n, 1)
})

test('等级流转：续费叠加有效期；有效期内不可降级；跨级升级与到期降级扫描', () => {
  const r = M.registerMember({ name: '等级测试', phone: '13900000003' })
  const id = r.id
  M.applyCard(id, 'silver', { requestId: 'silver-1' })
  assert.equal(member(id).card_expire_day, 30)
  // 续费银卡：从到期日起再叠 30 天
  M.applyCard(id, 'silver', { requestId: 'silver-renew' })
  assert.equal(member(id).card_expire_day, 60)
  // 升级金卡：从当前到期日起算
  const up = M.applyCard(id, 'gold', { requestId: 'gold-up' })
  assert.equal(up.ok, true)
  assert.equal(up.type, 'upgrade')
  assert.equal(member(id).card_expire_day, 120)
  // 金卡期买银卡：拒绝降级
  const down = M.applyCard(id, 'silver', { requestId: 'silver-down' })
  assert.equal(down.ok, false)
  assert.equal(down.code, M.MEMBER_ERR.DOWNGRADE)
  // 到期扫描：到期日次日降级为普通会员，积分/储值保留；到期日当天仍有效
  M.topup(id, 50, { requestId: 'bal-1' })
  M.sweepExpiredCards(120)
  assert.equal(member(id).card_tier, 'gold', '到期日当天（第120天）仍有效')
  M.sweepExpiredCards(121)
  const after = member(id)
  assert.equal(after.card_tier, 'none', '次日降级为普通会员')
  assert.equal(after.card_expire_day, 0)
  assert.equal(after.balance, 50, '储值保留')
  assert.ok(after.points > 0, '积分保留')
})

test('预约联动：会员折扣价 + 积分获取；全额退款回退积分并返还券；0 元免票券单不发分', () => {
  const r = M.registerMember({ name: '预约测试', phone: '13900000004' })
  const id = r.id
  M.applyCard(id, 'gold', { requestId: 'rp-gold' })

  // 金卡 9 折：门票 100 → 90；积分 = 90/10 * 1 * 1.5 = 13.5 → 13
  const q = M.quoteReservation(id, { scope: 'entry', qty: 2, entryPrice: 100 })
  assert.equal(q.payable, 180)
  assert.equal(q.points, 27)  // 180/10*1.5=27

  const s2 = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=2 AND hour=10").get()
  const book = RSV.createReservation({ scope: 'entry', slotId: s2.id, qty: 2, memberId: id, requestId: 'rp-book' })
  assert.equal(book.ok, true)
  assert.equal(member(id).points, 150 + 27)
  // 财务按折后实收
  assert.ok(finLogs.some(f => f.label === '门票' && f.amount === 180 && f.detail.includes('会员')))

  // 全额退（未来时段）：积分回退 27
  const cancel = RSV.cancelReservation(book.id, 'rp-cancel')
  assert.equal(cancel.ok, true)
  assert.equal(cancel.back, 180)
  assert.equal(member(id).points, 150)
  const refundLog = pointLogs(id).find(l => l.source === 'refund')
  assert.equal(refundLog.change, -27)

  // 免票券：0 元单，券核销、不发积分；退款返还券
  const tb = db.prepare("SELECT * FROM member_benefits WHERE member_id=? AND kind='ticket' AND status='unused' ORDER BY id LIMIT 1").get(id)
  const s3 = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=3 AND hour=10").get()
  const q0 = M.quoteReservation(id, { scope: 'entry', qty: 1, benefitId: tb.id, entryPrice: 100 })
  assert.equal(q0.payable, 0)
  assert.equal(q0.benefit.kind, 'ticket')
  const b0 = RSV.createReservation({ scope: 'entry', slotId: s3.id, qty: 1, memberId: id, benefitId: tb.id, requestId: 'rp-free' })
  assert.equal(b0.ok, true)
  assert.equal(benefit(tb.id).status, 'used')
  assert.equal(member(id).points, 150, '0 元单不发积分')
  RSV.cancelReservation(b0.id, 'rp-free-cancel')
  assert.equal(benefit(tb.id).status, 'unused', '全额退款返还免票券')
})

test('当日取消退 50%：积分按退款比例回退一半、券不返还', () => {
  const r = M.registerMember({ name: '半日退测试', phone: '13900000005' })
  const id = r.id
  M.applyCard(id, 'silver', { requestId: 'half-silver' })   // 银卡 95 折，1.2 倍
  setSetting('hour', 9)
  const s = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=1 AND hour=15").get()
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, memberId: id, requestId: 'half-book' })
  assert.equal(book.ok, true)
  // 95 元；积分 = 95/10*1.2 = 11.4 → 11
  const earned = member(id).points - 50
  assert.equal(earned, 11)
  setSetting('hour', 10)   // 当日取消：退 50%
  const c = RSV.cancelReservation(book.id, 'half-cancel')
  assert.equal(c.ok, true)
  assert.equal(c.back, 48)  // 95 半价取整
  // 回退 11*0.5 = 5.5 → 6（四舍五入）
  const claw = pointLogs(id).find(l => l.source === 'refund')?.change
  assert.ok(claw <= -5 && claw >= -6, `积分回退应约一半，实际 ${claw}`)
  setSetting('hour', 9)
})

test('快速通行券：时段真实容量售罄仍可下单，核销直接放行不走超售改签', () => {
  const r = M.registerMember({ name: 'FP测试', phone: '13900000006' })
  const id = r.id
  M.applyCard(id, 'gold', { requestId: 'fp-gold' })
  const fp = db.prepare("SELECT * FROM member_benefits WHERE member_id=? AND kind='fastpass' AND status='unused' ORDER BY id LIMIT 1").get(id)
  const s = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=2 AND hour=12").get()
  // 真实容量与超售全部占满
  db.prepare('UPDATE reservation_slots SET capacity=1, oversell=0, booked_count=1 WHERE id=?').run(s.id)
  const normal = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, requestId: 'fp-normal' })
  assert.equal(normal.ok, false)
  assert.equal(normal.code, 'SLOT_FULL', '普通单在售罄时段被拒')
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, memberId: id, benefitId: fp.id, requestId: 'fp-book' })
  assert.equal(book.ok, true, '快速通行券走 1.5 倍硬上限名额')
  assert.equal(benefit(fp.id).status, 'used')
  // 核销：本场已核销满员（capacity=1），fp 单仍直接放行
  db.prepare('UPDATE reservation_slots SET checked_count=1 WHERE id=?').run(s.id)
  setSetting('day', 2); setSetting('hour', 12)
  const ck = RSV.checkinReservation(book.id, 'fp-check')
  assert.equal(ck.ok, true, '快速通行券核销不受本场容量限制')
  setSetting('day', 1); setSetting('hour', 9)
})

test('商铺消费：会员折扣、储值支付（负债转收入）、消费券核销与积分；现金与券混用', () => {
  const r = M.registerMember({ name: '消费测试', phone: '13900000007' })
  const id = r.id
  M.applyCard(id, 'gold', { requestId: 'v-gold' })   // 金卡商铺 95 折
  const v = db.prepare('SELECT * FROM vendors ORDER BY id LIMIT 1').get()
  // 商铺单价（种子数据 28）：折后 27（28*0.95=26.6→27）
  const cash0 = cash()
  const sp1 = M.vendorSpend(id, v.id, { payMethod: 'cash' })
  assert.equal(sp1.ok, true)
  assert.equal(sp1.bill, 27)
  assert.equal(cash(), cash0 + 27)
  assert.ok(sp1.points >= 4) // 27/10*1.5=4.05 → 4

  // 充值 + 储值消费：现金不计二次收入，仅负债转收入
  M.topup(id, 100, { requestId: 'v-top' })
  const bal0 = member(id).balance
  const cashAfterTop = cash()
  const sp2 = M.vendorSpend(id, v.id, { payMethod: 'balance' })
  assert.equal(sp2.balancePart, 27)
  assert.equal(member(id).balance, bal0 - 27)
  assert.equal(cash(), cashAfterTop, '储值消费不产生新现金')
  assert.ok(finLogs.some(f => f.label === '商业' && f.amount === 27 && f.detail.includes('储值')))

  // 储值不足被拒
  db.prepare('UPDATE members SET balance=5 WHERE id=?').run(id)
  const bad = M.vendorSpend(id, v.id, { payMethod: 'balance' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, M.MEMBER_ERR.INSUF_BALANCE)
  db.prepare('UPDATE members SET balance=? WHERE id=?').run(bal0 - 27, id)

  // 消费券（金卡赠送面额 30，覆盖折后 27）：券全额核销，0 现金、0 积分基数
  const vc = db.prepare("SELECT * FROM member_benefits WHERE member_id=? AND kind='voucher' AND status='unused' ORDER BY id LIMIT 1").get(id)
  const sp3 = M.vendorSpend(id, v.id, { payMethod: 'voucher', benefitId: vc.id })
  assert.equal(sp3.ok, true)
  assert.equal(sp3.voucherPart, 27)
  assert.equal(sp3.cashPart, 0)
  assert.equal(sp3.points, 0)
  assert.equal(benefit(vc.id).status, 'used')
  assert.ok(finLogs.some(f => f.label === '会员权益' && f.amount === -27))
})

test('积分兑换：积分扣减、储值入账负债（不动现金）、冻结会员不可兑', () => {
  const r = M.registerMember({ name: '兑换测试', phone: '13900000008' })
  const id = r.id
  M.adjustPoints(id, 1000, { note: '测试充点' })
  const cash0 = cash()
  const rd = M.redeemPoints(id, 'balance', { requestId: 'rd-bal' })
  assert.equal(rd.ok, true)
  assert.equal(member(id).points, 500)
  assert.equal(member(id).balance, 30)
  assert.equal(cash(), cash0, '积分兑储值不产生现金')
  // 积分不足
  const bad = M.redeemPoints(id, 'ticket', { requestId: 'rd-ticket' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, M.MEMBER_ERR.INSUF_POINTS)
  // 冻结后不可兑换
  M.setFrozen(id, true)
  const fz = M.redeemPoints(id, 'fastpass', { requestId: 'rd-fp' })
  assert.equal(fz.ok, false)
  assert.equal(fz.code, M.MEMBER_ERR.FROZEN)
  M.setFrozen(id, false)
})

test('冻结防护与运营配置：冻结期间预约/购卡/充值全部拒绝', () => {
  const r = M.registerMember({ name: '冻结测试', phone: '13900000009' })
  const id = r.id
  M.setFrozen(id, true, { reason: '风险' })
  assert.equal(member(id).status, 'frozen')
  assert.equal(M.applyCard(id, 'silver', { requestId: 'fz-card' }).code, M.MEMBER_ERR.FROZEN)
  assert.equal(M.topup(id, 10, { requestId: 'fz-top' }).code, M.MEMBER_ERR.FROZEN)
  const s = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=2 AND hour=9").get()
  assert.equal(RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, memberId: id, requestId: 'fz-rsv' }).code, M.MEMBER_ERR.FROZEN)
  M.setFrozen(id, false)
  assert.equal(M.saveConfig({ pointRate: 2 }).ok, true)
  assert.equal(M.getConfig().pointRate, 2)
  const bad = M.saveConfig({ pointRate: 99 })
  assert.equal(bad.ok, false)
})
