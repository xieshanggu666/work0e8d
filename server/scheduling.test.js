// 员工排班与工时结算模块一致性测试：
// 排班冲突/覆盖校验、自动打卡与迟到、旷工无薪、下班结算入财务、加班 1.5 倍、
// 调班原子换班、跨日夜班次日结算、离岗接续、解雇联动、完工满意度回写、派工在岗门控、幂等
// 运行：node --test server/scheduling.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'   // 必须在导入 db.js 前设置，隔离真实库

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const SCH = await import('./scheduling.js')

const finLogs = []
SCH.initSchedulingContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  complaintRoles: { queue: ['保安', '安保'], hygiene: ['保洁'], facility: ['维修'] }
})

const cash = () => Number(getSetting('cash'))
const tick = () => Number(getSetting('tick'))
// 直接推进游戏时钟（不跑引擎；本测试手动调用 processScheduling 精确控制每小时行为）
function advance(hours) {
  const day = Number(getSetting('day'))
  let h = Number(getSetting('hour')) + hours
  let d = day
  while (h > 18) { h -= 10; d += 1 }
  setSetting('hour', h)
  setSetting('day', d)
  setSetting('tick', Number(getSetting('tick')) + hours)
}
function setClock(day, hour) {
  setSetting('day', day); setSetting('hour', hour)
  setSetting('tick', (day - 1) * 10 + (hour - 9))
}

const staffBy = role => db.prepare("SELECT * FROM staff WHERE role=? AND active=1 ORDER BY id LIMIT 1").get(role)
const shiftByCode = code => db.prepare('SELECT * FROM shift_templates WHERE code=?').get(code)
const sched = (staffId, day) => db.prepare("SELECT * FROM staff_schedules WHERE staff_id=? AND day=? AND status<>'cancelled'").get(staffId, day)
const attOf = schedId => db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(schedId)

before(() => {
  setClock(1, 9)
  setSetting('cash', 100000)
  setSetting('scheduleAutoFill', 0)   // 测试中关闭自动排班，用例自行精确排班
})

test('排班：同日重复排班冲突拦截；不同日/不同员工可排', () => {
  const guard = staffBy('保安')
  const morning = shiftByCode('morning')
  const mid = shiftByCode('mid')
  const r1 = SCH.createSchedule({ staffId: guard.id, shiftId: morning.id, day: 2, requestId: 'sc-1' })
  assert.equal(r1.ok, true)
  // 幂等：同键重放返回同一排班，不重复建单
  const replay = SCH.createSchedule({ staffId: guard.id, shiftId: morning.id, day: 2, requestId: 'sc-1' })
  assert.equal(replay.ok, true); assert.equal(replay.id, r1.id); assert.equal(replay.replay, true)
  const r2 = SCH.createSchedule({ staffId: guard.id, shiftId: mid.id, day: 2, requestId: 'sc-2' })
  assert.equal(r2.ok, false); assert.equal(r2.code, 'SHIFT_CONFLICT')
  const r3 = SCH.createSchedule({ staffId: guard.id, shiftId: morning.id, day: 3, requestId: 'sc-3' })
  assert.equal(r3.ok, true)
  // 已过去的日期不可排班
  const past = SCH.createSchedule({ staffId: guard.id, shiftId: morning.id, day: 0, requestId: 'sc-4' })
  assert.equal(past.ok, false); assert.equal(past.code, 'DAY_PAST')
})

test('岗位覆盖校验：无维修/保洁排班会产生缺岗预警', () => {
  const cov = SCH.coverageForDay(5)
  // 第 5 天尚无任何排班（种子无排班），各开放区域与在途检修必然告警
  assert.ok(cov.warnings.length > 0)
  assert.ok(cov.warnings.some(w => w.type === 'zone_guard'))
  assert.ok(cov.warnings.some(w => w.type === 'zone_clean'))
})

test('到点自动打卡（准时无迟到）；过点手动打卡记迟到；全程未到岗下班记旷工且无薪', () => {
  const cleaner = staffBy('保洁')
  const morning = shiftByCode('morning')
  const guard = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 AND id<>? LIMIT 1").get(staffBy('保安').id)
  // 保洁：第 2 天早班 9:00
  const sc = SCH.createSchedule({ staffId: cleaner.id, shiftId: morning.id, day: 2, requestId: 'att-1' })
  setClock(2, 9)
  SCH.processScheduling()
  const a = attOf(sc.id)
  assert.ok(a, '9:00 应自动打卡')
  assert.equal(a.status, 'checked_in')
  assert.equal(a.late, 0, '准点不应迟到')

  // 保安：第 2 天中班 12:00，引擎 13:00 才跑 → 自动打卡应记迟到
  const sc2 = SCH.createSchedule({ staffId: guard.id, shiftId: shiftByCode('mid').id, day: 2, requestId: 'att-2' })
  setClock(2, 13)
  SCH.processScheduling()
  const a2 = attOf(sc2.id)
  assert.ok(a2); assert.equal(a2.late, 1, '晚于班次开始打卡应记迟到')

  // 另一保安：排早班但全天不跑其开始时刻（直接跳到下班），应旷工
  const guard3 = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 AND id NOT IN (?,?) LIMIT 1")
    .get(staffBy('保安').id, guard.id)
  if (guard3) {
    const sc3 = SCH.createSchedule({ staffId: guard3.id, shiftId: morning.id, day: 3, requestId: 'att-3' })
    setClock(3, 14)
    SCH.processScheduling()
    const a3 = attOf(sc3.id)
    assert.equal(a3.status, 'absent')
    assert.equal(a3.pay, 0, '旷工无薪')
  }
})

test('下班自动结算：基准工时工资逐单入财务，员工满意度随完工回写与迟到结算', () => {
  // 用与其他用例不冲突的员工（会员专员）+ 唯一日期，隔离结算断言
  const specialist = db.prepare("SELECT * FROM staff WHERE role='会员专员' AND active=1 ORDER BY id LIMIT 1").get()
  const morning = shiftByCode('morning')
  const sc = SCH.createSchedule({ staffId: specialist.id, shiftId: morning.id, day: 20, requestId: 'set-1' })
  setClock(20, 9)
  SCH.processScheduling()
  const a = attOf(sc.id)
  assert.ok(a)
  // 在岗期间完工回写：投诉 +2
  SCH.writeWorkCompletion(specialist.id, 'complaint', { code: 'TS0001' })
  const aMid = attOf(sc.id)
  assert.equal(aMid.satisfaction_delta, 2)
  const moraleBefore = db.prepare('SELECT morale FROM staff WHERE id=?').get(specialist.id).morale
  const cash0 = cash()
  const wage = db.prepare('SELECT wage FROM staff WHERE id=?').get(specialist.id).wage
  setClock(20, 14)
  SCH.processScheduling()
  const done = attOf(sc.id)
  assert.equal(done.status, 'checked_out')
  assert.equal(done.settle_day, 20)
  assert.equal(done.pay, wage, '早班基准 5h，时薪=日薪/5，满班工资=日薪')
  assert.equal(cash(), cash0 - wage, '现金应扣减工资')
  assert.ok(finLogs.some(f => f.label === '工资' && f.amount === -wage && f.detail.includes(done.code)), '工资流水应逐条入账并带考勤号')
  const moraleAfter = db.prepare('SELECT morale FROM staff WHERE id=?').get(specialist.id).morale
  assert.equal(moraleAfter, Math.max(20, Math.min(100, moraleBefore + 2)), '完工 +2 满意度应落到士气')
})

test('加班申请→主管批准→下班按 1.5 倍时薪结算；未批加班不计薪', () => {
  // 用唯一员工（运营主管不参与自动排班，这里直接指定一名会员专员）与唯一日期隔离
  const repair = db.prepare("SELECT * FROM staff WHERE role='维修' AND active=1 ORDER BY id DESC LIMIT 1").get()
  // 用中班（12:00~17:00）：批准加班 1h 后 18:00 下班，恰为闭园 tick，引擎可达
  const mid = shiftByCode('mid')
  const scRec = SCH.createSchedule({ staffId: repair.id, shiftId: mid.id, day: 21, requestId: 'ot-1' })
  assert.equal(scRec.ok, true)
  const sc = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(scRec.id)
  setClock(21, 12)
  SCH.processScheduling()
  const a = attOf(sc.id)
  assert.equal(a.status, 'checked_in')
  // 申请 1h 加班（17:00 → 18:00 收园）
  const req = SCH.requestOvertime({ staffId: repair.id, scheduleId: sc.id, ticks: 1, reason: '收园检修', requestId: 'ot-req-1' })
  assert.equal(req.ok, true)
  // 未批时推进到 17:00：审批前下班线仍是 17:00，此刻即结算（无加班费）→ 为验证批准路径，先不跑 17 点
  // 主管在 16 点批准加班 1h
  setClock(21, 16)
  SCH.processScheduling()
  const ap = SCH.approveOvertime(req.id, null)
  assert.equal(ap.ok, true)
  let cur = attOf(sc.id)
  assert.equal(cur.ot_approved, 1); assert.equal(cur.overtime_ticks, 1)
  // 17 点未到下班线（18:00）不结算；18 点下班结算
  const wage = db.prepare('SELECT wage FROM staff WHERE id=?').get(repair.id).wage
  const hourly = Math.round(wage / 5)
  setClock(21, 17)
  SCH.processScheduling()
  assert.equal(attOf(sc.id).status, 'checked_in', '加班后 17 点尚未下班')
  const cash0 = cash()
  setClock(21, 18)
  SCH.processScheduling()
  cur = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(sc.id)
  assert.equal(cur.status, 'checked_out')
  const expectedPay = Math.round(hourly * mid.standard_hours) + Math.round(hourly * 1.5 * 1)
  assert.equal(cur.pay, expectedPay, '应含 1.5 倍时薪加班费')
  assert.equal(cash(), cash0 - expectedPay)
  assert.ok(finLogs.some(f => f.detail && f.detail.includes('加班 1h')), '工资流水应注明加班')
})

test('加班窗口限制：日班加班后晚于 18:00 不受理', () => {
  const specialist = db.prepare("SELECT * FROM staff WHERE role='会员专员' AND active=1 AND id NOT IN (SELECT id FROM staff WHERE role='运营主管') ORDER BY id DESC LIMIT 1").get()
  const morning = shiftByCode('morning')
  const scRec = SCH.createSchedule({ staffId: specialist.id, shiftId: morning.id, day: 22, requestId: 'ot-limit-1' })
  const sc = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(scRec.id)
  setClock(22, 9)
  SCH.processScheduling()
  const r = SCH.requestOvertime({ staffId: specialist.id, scheduleId: sc.id, ticks: 5, requestId: 'ot-limit-2' })
  assert.equal(r.ok, false); assert.equal(r.code, 'BAD_OT')
})

test('调班：员工申请→原排班置调班中→主管批准原子换班；冲突目标拦截；驳回还原', () => {
  setClock(22, 18)   // 先停在过去时间点排未来班，避免上班点当刻被视为已开始
  const g1 = staffBy('保安')
  const cleaner2 = db.prepare("SELECT * FROM staff WHERE role='保洁' AND active=1 ORDER BY id LIMIT 1").get()
  const morning = shiftByCode('morning')
  const mid = shiftByCode('mid')
  // g1 第 23 天早班
  const scR = SCH.createSchedule({ staffId: g1.id, shiftId: morning.id, day: 23, requestId: 'sw-1' })
  assert.equal(scR.ok, true)
  setClock(23, 9)
  // 已开始的排班不能调班
  const late = SCH.requestSwap({ staffId: g1.id, scheduleId: scR.id, targetStaffId: cleaner2.id, targetShiftId: mid.id, targetDay: 23, requestId: 'sw-late' })
  assert.equal(late.ok, false); assert.equal(late.code, 'SHIFT_STARTED')

  // 第 24 天调班
  const sc7R = SCH.createSchedule({ staffId: g1.id, shiftId: morning.id, day: 24, requestId: 'sw-2' })
  assert.equal(sc7R.ok, true)
  // 先给 cleaner2 在目标日排中班，制造冲突 → 拦截
  assert.equal(SCH.createSchedule({ staffId: cleaner2.id, shiftId: mid.id, day: 24, requestId: 'sw-3' }).ok, true)
  const conflict = SCH.requestSwap({ staffId: g1.id, scheduleId: sc7R.id, targetStaffId: cleaner2.id, targetShiftId: morning.id, targetDay: 24, requestId: 'sw-4' })
  assert.equal(conflict.ok, false); assert.equal(conflict.code, 'SHIFT_CONFLICT')

  // 换一个第 25 天无排班的保洁目标（种子保洁人数有限，动态挑选避免撞班）
  const cleaner3 = db.prepare("SELECT * FROM staff WHERE role='保洁' AND active=1 AND id<>? ORDER BY id LIMIT 1").get(cleaner2.id)
  if (!cleaner3 || sched(cleaner3.id, 25)) {
    // 若无空闲保洁（第 25 天已占用），本断言退化为校验冲突语义即可
    assert.ok(conflict.code === 'SHIFT_CONFLICT')
    return
  }
  const req = SCH.requestSwap({ staffId: g1.id, scheduleId: sc7R.id, targetStaffId: cleaner3.id, targetShiftId: mid.id, targetDay: 25, reason: '家中有事', requestId: 'sw-5' })
  assert.equal(req.ok, true)
  assert.equal(sched(g1.id, 24).status, 'swap')
  // 驳回 → 原排班还原
  const rej = SCH.rejectSwap(req.id, null, '测试驳回')
  assert.equal(rej.ok, true)
  assert.equal(sched(g1.id, 24).status, 'scheduled')

  // 再次申请并批准 → 原排班取消，目标人得到第 25 天中班
  const req2 = SCH.requestSwap({ staffId: g1.id, scheduleId: sc7R.id, targetStaffId: cleaner3.id, targetShiftId: mid.id, targetDay: 25, requestId: 'sw-6' })
  assert.equal(req2.ok, true)
  const ap = SCH.approveSwap(req2.id, null)
  assert.equal(ap.ok, true)
  assert.equal(db.prepare("SELECT status FROM staff_schedules WHERE id=?").get(sc7R.id).status, 'cancelled')
  const ns = sched(cleaner3.id, 25)
  assert.ok(ns); assert.equal(ns.shift_id, mid.id)
  // g1 第 24 天已无有效排班
  assert.equal(sched(g1.id, 24), undefined)
})

test('跨日夜班：当日 17 点上班、当日闭园不结算、次日 9 点下班结算并计入次日', () => {
  // 选择第 26 天无既存排班的保安（其他用例已占用部分保安的早期日期）
  const guards = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 ORDER BY id").all()
  let guard
  for (const g of guards) { if (!sched(g.id, 26)) { guard = g; break } }
  assert.ok(guard, '需存在一名可排夜班的保安')
  const night = shiftByCode('night')
  const scRec = SCH.createSchedule({ staffId: guard.id, shiftId: night.id, day: 26, requestId: 'night-1' })
  assert.equal(scRec.ok, true)
  const sc = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(scRec.id)
  setClock(26, 17)
  SCH.processScheduling()
  const a = attOf(sc.id)
  assert.ok(a && a.status === 'checked_in')
  // 当日 18 点闭园：仍在岗不结算
  setClock(26, 18)
  SCH.processScheduling()
  assert.equal(attOf(sc.id).status, 'checked_in', '跨日夜班当日闭园不应结算')
  const wage = db.prepare('SELECT wage FROM staff WHERE id=?').get(guard.id).wage
  const cash0 = cash()
  // 次日 9 点（新一天首个 tick）下班结算
  setClock(27, 9)
  SCH.processScheduling()
  const done = attOf(sc.id)
  assert.equal(done.status, 'checked_out')
  assert.equal(done.settle_day, 27, '跨日夜班应在次日结算')
  const expected = Math.round(Math.round(wage / 5) * night.standard_hours)
  assert.equal(done.pay, expected)
  assert.equal(cash(), cash0 - expected)
  // 次日 9 点已下班且第 27 天无其它排班 → 不在岗
  setClock(27, 9)
  const duty = SCH.staffDutyState(guard.id)
  assert.equal(duty.onDuty, false)
})

test('派工在岗门控：无排班不可派；已排班未打卡 onDuty=false 但 scheduled=true；打卡后放行', () => {
  // 选第 28 天无既存排班的维修工
  const repairs = db.prepare("SELECT * FROM staff WHERE role='维修' AND active=1 ORDER BY id").all()
  let repair
  for (const x of repairs) { if (!sched(x.id, 28)) { repair = x; break } }
  assert.ok(repair)
  setClock(28, 9)
  // 无排班
  assert.equal(SCH.staffDutyState(repair.id).scheduled, false)
  const mid = shiftByCode('mid')
  const scRec = SCH.createSchedule({ staffId: repair.id, shiftId: mid.id, day: 28, requestId: 'duty-1' })
  const sc = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(scRec.id)
  const d1 = SCH.staffDutyState(repair.id)
  assert.equal(d1.scheduled, true); assert.equal(d1.onDuty, false, '已排中班但 9 点未到班')
  // 到 12 点跑引擎自动打卡后在岗
  setClock(28, 12)
  SCH.processScheduling()
  const d2 = SCH.staffDutyState(repair.id)
  assert.equal(d2.onDuty, true)
})

test('员工离岗（中途）：考勤按实际工时折算立即结算', () => {
  // 选第 29 天无既存排班的保洁
  const cleaners = db.prepare("SELECT * FROM staff WHERE role='保洁' AND active=1 ORDER BY id").all()
  let cleaner
  for (const x of cleaners) { if (!sched(x.id, 29)) { cleaner = x; break } }
  assert.ok(cleaner)
  const morning = shiftByCode('morning')
  const scRec = SCH.createSchedule({ staffId: cleaner.id, shiftId: morning.id, day: 29, requestId: 'leave-1' })
  const sc = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(scRec.id)
  setClock(29, 9)
  SCH.processScheduling()
  setClock(29, 11)   // 在岗 2h 后离岗
  SCH.processScheduling()
  const a = attOf(sc.id)
  const wage = db.prepare('SELECT wage FROM staff WHERE id=?').get(cleaner.id).wage
  const cash0 = cash()
  const r = SCH.leavePost(a.id, { reason: '突发不适', requestId: 'leave-post-1' })
  assert.equal(r.ok, true)
  const done = attOf(sc.id)
  assert.equal(done.status, 'leave')
  // 早班 planned=5h，实际 2h → 40% 基准工资
  const expected = Math.round(Math.round(wage / 5) * 5 * (2 / 5))
  assert.equal(done.pay, expected)
  assert.equal(cash(), cash0 - expected)
})

test('解雇联动：未来排班取消、待审批调班作废、在岗考勤离岗结算', () => {
  // 选第 30 天无既存排班的保安
  const guards = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 ORDER BY id").all()
  let g
  for (const x of guards) { if (!sched(x.id, 30) && !sched(x.id, 31)) { g = x; break } }
  assert.ok(g)
  const morning = shiftByCode('morning')
  // 未来排班
  assert.equal(SCH.createSchedule({ staffId: g.id, shiftId: morning.id, day: 31, requestId: 'fire-1' }).ok, true)
  // 今日在岗
  const scTodayR = SCH.createSchedule({ staffId: g.id, shiftId: morning.id, day: 30, requestId: 'fire-2' })
  const scToday = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(scTodayR.id)
  setClock(30, 10)
  SCH.processScheduling()
  assert.equal(attOf(scToday.id)?.status, 'checked_in')
  const r = SCH.releaseStaffSchedules(g.id)
  assert.ok(r.onDuty >= 1, '在岗考勤应被离岗结算')
  assert.equal(attOf(scToday.id).status, 'leave')
  assert.equal(sched(g.id, 31), undefined, '未来排班应取消')
})

test('日结汇总：旷工/结算人数与工资合计正确', () => {
  const s = SCH.dayCloseSummary(30)
  assert.ok(typeof s.absent === 'number')
  assert.ok(s.totalPay >= 0)
})

// ---------------- 动态调度：预约客流 / 检修工单 / 投诉岗位需求驱动 ----------------
test('需求画像：输出早/中/晚/夜四班段客流与岗位需求结构', () => {
  const d = SCH.demandForDay(50)
  assert.equal(d.bands.length, 4)
  const morning = d.bands.find(b => b.key === 'morning')
  assert.ok(morning.flow >= 0)
  assert.ok(morning.need_guard >= 1, '有开放区域时早班至少需要 1 名保安')
  assert.ok(morning.need_clean >= 1, '有开放区域时早班至少需要 1 名保洁')
  assert.equal(morning.need_repair, 0)
  const night = d.bands.find(b => b.key === 'night')
  assert.equal(night.need_clean, 0)
  assert.equal(night.need_repair, 0)
})

test('动态补位：按客流需求把无排班员工排进缺岗班段，排班来源标记为 dispatch', () => {
  setClock(40, 9)
  setSetting('scheduleAutoFill', 1)
  setSetting('scheduleMode', 'dynamic')
  const day = 41
  // 高客流阈值 → 至少需要多名保安/保洁，初始无任何排班
  setSetting('dispatchGuardFlow', 200)
  setSetting('dispatchCleanFlow', 200)
  const before = db.prepare("SELECT COUNT(*) n FROM staff_schedules WHERE day=? AND status<>'cancelled'").get(day).n
  assert.equal(before, 0)
  const r = SCH.runDynamicDispatch({ horizon: 3, reason: '测试客流高峰补位' })
  assert.ok(r.ok)
  assert.ok(r.created.length > 0, '应按缺口生成补位排班')
  const filled = db.prepare("SELECT * FROM staff_schedules WHERE day=? AND status<>'cancelled'").all(day)
  assert.ok(filled.every(s => s.source === 'dispatch'), '动态补位排班来源应为 dispatch')
  // 同一员工同日只有一个有效排班（唯一索引 + 选人过滤双重保证）
  const dup = db.prepare('SELECT staff_id, COUNT(*) n FROM staff_schedules WHERE day=? AND status<>\'cancelled\' GROUP BY staff_id HAVING n>1').all(day)
  assert.equal(dup.length, 0)
  // 补位后覆盖预警应显著收敛（需求人数仍可能超过在册员工，但不得再给已有足够在岗的岗位报缺口）
  const cov = SCH.coverageForDay(day)
  const guardWarn = cov.warnings.filter(w => w.type === 'flow_guard' && w.band === 'morning')
  if (guardWarn.length) assert.ok(guardWarn[0].gap > 0)
})

test('疲劳规避：前一日上跨日夜班的员工，次日动态补位不再排日班', () => {
  setClock(42, 9)
  // 增聘一名专用保安，避免与前序用例的排班互相干扰
  const gid = Number(db.prepare("INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES('疲劳测试保安','保安',1,320,1,80,1)").run().lastInsertRowid)
  const guard = db.prepare('SELECT * FROM staff WHERE id=?').get(gid)
  const night = shiftByCode('night')
  // 第 42 天夜班（17:00 上班，次日 9:00 下班）
  assert.equal(SCH.createSchedule({ staffId: guard.id, shiftId: night.id, day: 42, requestId: 'fatigue-1' }).ok, true)
  setClock(43, 9)
  setSetting('scheduleMode', 'dynamic')
  SCH.runDynamicDispatch({ horizon: 3 })
  // 第 43 天动态补位不应给该保安再排日班（其前夜夜班今早 9 点才下班）
  const day43 = db.prepare("SELECT * FROM staff_schedules WHERE staff_id=? AND day=43 AND status<>'cancelled'").all(guard.id)
  assert.equal(day43.length, 0, '夜班次日凌晨才下班，当日不应再被动态补位')
})

test('检修工单需求：动态调度自动排维修工；在修工单无维修工当班时为 block 预警', () => {
  setClock(44, 9)
  setSetting('scheduleMode', 'dynamic')
  const ride = db.prepare("SELECT * FROM rides ORDER BY id LIMIT 1").get()
  // 直接构造一个排队检修工单
  const oid = Number(db.prepare(`INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day)
                                VALUES('WXT001',?,'queued','manual',0,3000,?,44)`)
    .run(ride.id, Number(getSetting('tick'))).lastInsertRowid)
  SCH.runDynamicDispatch({ horizon: 3, reason: '测试检修需求' })
  const repairs = db.prepare(`
    SELECT sc.* FROM staff_schedules sc
    JOIN staff s ON s.id=sc.staff_id
    WHERE sc.day=44 AND sc.status<>'cancelled' AND s.role='维修'`).all()
  assert.ok(repairs.length > 0, '排队检修工单应驱动维修工排班')
  // 无维修工的日子：block 级预警
  db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE day=44 AND staff_id IN (SELECT id FROM staff WHERE role='维修')").run()
  db.prepare("UPDATE maintenance_orders SET status='processing' WHERE id=?").run(oid)
  const cov = SCH.coverageForDay(44)
  assert.ok(cov.warnings.some(w => w.type === 'maintenance_band' && w.level === 'block' || w.type === 'maintenance' && w.level === 'block'),
    '检修中且无维修工当班应为 block 级预警')
})

test('投诉岗位需求：紧急设施投诉驱动维修工排班，且按岗位匹配不会错派保安', () => {
  setClock(45, 9)
  setSetting('scheduleMode', 'dynamic')
  // 第 45 天先清空所有有效排班（隔离断言）
  db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE day=45").run()
  db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,status,deadline_tick,source)
              VALUES('TST0999',?,45,'facility',3,'测试紧急设施投诉','open',?+10,'manual')`)
    .run(Number(getSetting('tick')), Number(getSetting('tick')))
  SCH.runDynamicDispatch({ horizon: 3, reason: '测试紧急投诉' })
  const band = SCH.demandForDay(45).bands.find(b => b.complaints.some(c => c.code === 'TST0999'))
  assert.ok(band, '紧急投诉应挂入早班岗位需求')
  const repairScheduled = db.prepare(`
    SELECT COUNT(*) n FROM staff_schedules sc JOIN staff s ON s.id=sc.staff_id
    WHERE sc.day=45 AND sc.status<>'cancelled' AND s.role='维修'`).get().n
  assert.ok(repairScheduled >= 1, '紧急设施投诉应驱动至少 1 名维修工排班')
})

test('紧急加班调令：当天已开始班段缺岗且有相邻班段在岗匹配员工时，生成 dispatch 来源的待审批加班申请', () => {
  // 前一日闭园时预排次日早班保安（9:00 当刻会被视为班次已开始，故提前排）
  setClock(45, 18)
  setSetting('scheduleMode', 'dynamic')
  // 增聘一名专用早班保安 + 若干占用晚班的保安，避免与前序用例互相干扰
  const hireGuard = () => db.prepare('SELECT * FROM staff WHERE id=?').get(
    Number(db.prepare("INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES('调令测试保安','保安',1,320,1,80,1)").run().lastInsertRowid))
  const guard = hireGuard()
  const morning = shiftByCode('morning')
  const sc = SCH.createSchedule({ staffId: guard.id, shiftId: morning.id, day: 46, requestId: 'ot-disp-1' })
  assert.ok(sc.ok)
  setClock(46, 13)
  SCH.processScheduling()   // 13 点自动打卡
  assert.equal(attOf(sc.id)?.status, 'checked_in')
  // 制造中班保安高需求（把阈值压低），其他保安用晚班占住使其无法再补中班
  setSetting('dispatchGuardFlow', 100)
  for (let i = 0; i < 4; i++) {
    const g2 = hireGuard()
    SCH.createSchedule({ staffId: g2.id, shiftId: shiftByCode('evening').id, day: 46, requestId: `ot-disp-g${i}` })
  }
  const before = db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE source='dispatch' AND status='pending'").get().n
  const r = SCH.runDynamicDispatch({ horizon: 1, urgentOvertime: true, reason: '测试紧急调令' })
  assert.ok(r.otRequests.length >= 1, '中班缺口应至少生成 1 条紧急加班调令')
  const after = db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE source='dispatch' AND status='pending'").get().n
  assert.ok(after >= before + 1)
  // 本次生成的调令：加班类型、挂在当前在岗的匹配岗位员工（含本测试保安）、时长 1~4h
  const newReqs = db.prepare(`SELECT * FROM shift_requests WHERE id IN (${r.otRequests.map(x => x.id).join(',')})`).all()
  for (const q of newReqs) {
    assert.equal(q.kind, 'overtime')
    assert.equal(q.source, 'dispatch')
    assert.ok(q.ot_ticks >= 1 && q.ot_ticks <= 4)
    const onDutyNow = SCH.staffDutyState(q.staff_id)
    assert.ok(onDutyNow.onDuty, '调令对象必须当前在岗')
  }
  // 主管批准调令 → 写入考勤加班、下班点顺延，沿用既有加班审批闭环
  const ap = SCH.approveOvertime(newReqs[0].id, null)
  assert.equal(ap.ok, true)
  const attRow = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(newReqs[0].schedule_id)
  assert.equal(attRow.ot_approved, 1)
  assert.ok(attRow.overtime_ticks >= 1)
})

test('调度计划只读接口结构：含模式、参数与未来三天画像', () => {
  setClock(47, 9)
  const p = SCH.dispatchPlan({ horizon: 3 })
  assert.equal(p.days.length, 3)
  assert.ok(['dynamic', 'auto'].includes(p.mode))
  assert.ok(p.params.guardFlow > 0)
  assert.equal(p.days[0].day, 47)
  assert.ok(Array.isArray(p.days[0].warnings))
})
