import db, { getSetting, setSetting, tx } from './db.js'

// 员工排班与工时结算模块：
// 班次模板 → 排班（校验冲突/岗位覆盖）→ 考勤打卡（迟到/在岗/离岗）→ 调班/加班协作（主管审批）
// → 下班自动结算工时与满意度，基准工时工资 + 1.5 倍加班工资逐条进入工资财务流水；跨日夜班次日结算。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const OPEN_HOUR = 9
const CLOSE_HOUR = 18
const HOURS_PER_DAY = 10

// 由 index.js 注入：财务流水、岗位覆盖所需的投诉岗位映射
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  complaintRoles: null   // { category: [岗位...] }
}
export function initSchedulingContext(deps) {
  Object.assign(ctx, deps)
}

const EFFECTIVE = "status IN ('scheduled','swap')"

// 线性游戏时刻：游戏只在 9:00~18:00 推进，tick = (day-1)*10 + (hour-9)，全局唯一可比
function linear(day, hour) {
  return (day - 1) * HOURS_PER_DAY + (hour - OPEN_HOUR)
}

// ---------------- 基础查询 ----------------
export function listShiftTemplates({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM shift_templates WHERE active=1 ORDER BY sort,id'
    : 'SELECT * FROM shift_templates ORDER BY sort,id'
  return db.prepare(sql).all().map(sh => ({
    ...sh,
    begin_linear: linear(1, sh.start_hour),
    time_text: sh.cross_day
      ? `${sh.start_hour}:00 ~ 次日 ${String(sh.end_hour).padStart(2, '0')}:00`
      : `${sh.start_hour}:00 ~ ${sh.end_hour}:00`
  }))
}

function getShift(id) {
  return db.prepare('SELECT * FROM shift_templates WHERE id=? AND active=1').get(id)
}
function getStaff(id) {
  return db.prepare('SELECT * FROM staff WHERE id=?').get(id)
}
function effectiveScheduleOf(staffId, day) {
  return db.prepare(`SELECT * FROM staff_schedules WHERE staff_id=? AND day=? AND ${EFFECTIVE}`).get(staffId, day)
}
function attendanceBySchedule(scheduleId) {
  return db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(scheduleId)
}
function shiftBounds(sch, sh) {
  const begin = linear(sch.day, sh.start_hour)
  const end = sh.cross_day ? linear(sch.day + 1, sh.end_hour) : linear(sch.day, sh.end_hour)
  return { begin, end }
}
// 时薪按 5 小时基准班折算（早/中班干满≈日薪，晚班 4h 按比例，夜班含夜勤基准 6h）
function hourlyWage(wage) {
  return Math.max(20, Math.round(num(wage, 300) / 5))
}

function logShift({ scheduleId = null, attendanceId = null, requestId = null, action, note = '', staffId = null, approverId = null }) {
  db.prepare('INSERT INTO shift_logs(schedule_id,attendance_id,request_id,tick,day,hour,action,note,staff_id,approver_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(scheduleId, attendanceId, requestId, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId, approverId)
}

// ---------------- 幂等（复用 idempotency_keys，与预约模块同一套重放语义） ----------------
function idempotent(scope, requestId, fn) {
  const key = String(requestId || '').trim().slice(0, 80)
  if (!key) return fn()
  const hit = db.prepare('SELECT response FROM idempotency_keys WHERE scope=? AND key=?').get(scope, key)
  if (hit) return { ...JSON.parse(hit.response), replay: true }
  const result = fn()
  if (result?.code !== 'TX_FAILED') {
    db.prepare('INSERT OR IGNORE INTO idempotency_keys(scope,key,response,created_tick,created_day) VALUES(?,?,?,?,?)')
      .run(scope, key, JSON.stringify(result), ctx.tick(), ctx.day())
  }
  return result
}

const fail = (code, msg, extra = {}) => ({ ok: false, code, msg, ...extra })

// ---------------- 排班 ----------------
// 运营主管排班：校验员工在岗、班次有效、时间未过、同日冲突（DB 部分唯一索引兜底）
// source: manual 主管手排 / auto 基础自动补位 / dispatch 动态调度按缺口补位
// allowStarted：动态调度内部使用，允许补入刚开始的班段（引擎会在下一小时自动打卡；已结束仍拒绝）
export function createSchedule({ staffId, shiftId, day, note = '', source = 'manual', requestId = '', allowStarted = false }) {
  return idempotent('schedule_create', requestId, () => {
    try {
      return tx(() => {
        const st = getStaff(staffId)
        if (!st || !st.active) return fail('STAFF_OFF', '员工不存在或已离岗，无法排班')
        const sh = getShift(shiftId)
        if (!sh) return fail('SHIFT_NOT_FOUND', '班次不存在或已停用')
        day = Math.round(num(day))
        if (!Number.isInteger(day) || day < ctx.day()) return fail('DAY_PAST', '不能为已过去的游戏日排班')
        const t = ctx.tick()
        const begin = linear(day, sh.start_hour)
        const endB = sh.cross_day ? linear(day + 1, sh.end_hour) : linear(day, sh.end_hour)
        if (day === ctx.day() && begin <= t) {
          if (!allowStarted) return fail('SHIFT_STARTED', '该班次今日已开始，请选择尚未开始的班次')
          if (t >= endB) return fail('SHIFT_ENDED', '该班次已结束，无法补位')
        }
        const exist = effectiveScheduleOf(st.id, day)
        if (exist) return fail('SHIFT_CONFLICT', `${st.name} 当日已有排班，存在排班冲突`, { conflict_id: exist.id })

        const src = ['manual', 'auto', 'dispatch'].includes(source) ? source : 'manual'
        const ins = db.prepare(`INSERT INTO staff_schedules(staff_id,shift_id,day,status,source,create_tick,create_day,note)
                               VALUES(?,?,?, 'scheduled',?,?,?,?)`)
          .run(st.id, sh.id, day, src, ctx.tick(), ctx.day(),
            note || (src === 'auto' ? '系统基础自动排班' : src === 'dispatch' ? '动态调度按岗位缺口补位' : '运营主管排班'))
        const id = Number(ins.lastInsertRowid)
        const code = 'PB' + String(id).padStart(4, '0')
        db.prepare('UPDATE staff_schedules SET code=? WHERE id=?').run(code, id)
        logShift({
          scheduleId: id,
          action: src === 'dispatch' ? 'dispatch_fill' : src === 'auto' ? 'autofill' : 'schedule',
          note: `${st.name} 排入 ${sh.name}（${sh.cross_day ? `第${day}天 ` : ''}${sh.start_hour}:00${sh.cross_day ? ` ~ 次日 ${sh.end_hour}:00` : ` ~ ${sh.end_hour}:00`}）`,
          staffId: st.id
        })
        const warnings = coverageForDay(day).warnings
        return { ok: true, id, code, staff_id: st.id, day, shift_id: sh.id, source: src, warnings }
      })
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return fail('SHIFT_CONFLICT', '该员工当日已有排班，存在排班冲突')
      }
      console.error('[scheduling] 排班失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，本次排班未生效，请稍后重试')
    }
  })
}

// 取消排班：仅允许取消尚未打卡的排班（在岗离岗走离岗/解雇流程）
export function cancelSchedule(id, { requestId = '' } = {}) {
  return idempotent('schedule_cancel', requestId, () => {
    try {
      return tx(() => {
        const sch = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(id)
        if (!sch) return fail('NOT_FOUND', '排班不存在')
        if (sch.status === 'cancelled') return fail('SCHED_CANCELLED', '该排班已取消')
        const att = attendanceBySchedule(id)
        if (att && att.status === 'checked_in') return fail('ON_DUTY', '员工已打卡在岗，请先办理离岗')
        const sh = getShift(sch.shift_id)
        const { begin } = shiftBounds(sch, sh || { start_hour: OPEN_HOUR, end_hour: OPEN_HOUR, cross_day: 0 })
        if (begin <= ctx.tick() && !att) {
          // 班次已开始但未打卡（旷工窗口）：允许取消并按旷工留痕
          db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE id=?").run(id)
          logShift({ scheduleId: id, action: 'cancel', note: '班次已开始未到岗，主管取消排班（按旷工处理）' })
          return { ok: true, absent: true }
        }
        db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE id=?").run(id)
        // 关联待审批调班单一并作废
        db.prepare("UPDATE shift_requests SET status='cancelled', handle_tick=?, handle_note='排班被取消' WHERE schedule_id=? AND status='pending'")
          .run(ctx.tick(), id)
        logShift({ scheduleId: id, action: 'cancel', note: '运营主管取消排班' })
        return { ok: true }
      })
    } catch (e) {
      console.error('[scheduling] 取消排班失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，本次操作未生效，请稍后重试')
    }
  })
}

// ---------------- 考勤打卡 ----------------
// 引擎自动打卡；员工/前台也可在班次窗口内手动补打卡（晚于班次开始记迟到）
export function checkin(scheduleId, { requestId = '' } = {}) {
  return idempotent('schedule_checkin', requestId, () => {
    try {
      return tx(() => {
        const sch = db.prepare(`SELECT * FROM staff_schedules WHERE id=? AND ${EFFECTIVE}`).get(scheduleId)
        if (!sch) return fail('NOT_FOUND', '排班不存在或已取消')
        const st = getStaff(sch.staff_id)
        if (!st || !st.active) return fail('STAFF_OFF', '员工已离岗，无法打卡')
        if (attendanceBySchedule(sch.id)) return fail('ALREADY_CHECKIN', '该班次已打卡，请勿重复打卡')
        const sh = getShift(sch.shift_id)
        const { begin, end } = shiftBounds(sch, sh)
        const t = ctx.tick()
        if (t < begin) return fail('NOT_STARTED', '未到上班时间，暂不能打卡')
        if (t >= end) return fail('SHIFT_ENDED', '该班次已结束，无法补打卡')

        const late = t > begin ? 1 : 0
        const insAtt = db.prepare(`INSERT INTO staff_attendance(schedule_id,staff_id,day,shift_id,cross_day,checkin_tick,status,late)
                                   VALUES(?,?,?,?,?,?,'checked_in',?)`)
          .run(sch.id, st.id, sch.day, sh.id, sh.cross_day ? 1 : 0, t, late)
        const id = Number(insAtt.lastInsertRowid)
        const code = 'KQ' + String(id).padStart(4, '0')
        db.prepare('UPDATE staff_attendance SET code=? WHERE id=?').run(code, id)
        logShift({
          scheduleId: sch.id, attendanceId: id, action: 'checkin',
          note: `${st.name} ${late ? '迟到打卡上班' : '准时打卡上班'} · ${sh.name}`, staffId: st.id
        })
        if (late) logShift({ scheduleId: sch.id, attendanceId: id, action: 'late', note: `晚于班次开始 ${t - begin} 小时打卡`, staffId: st.id })
        return { ok: true, id, code, late: !!late }
      })
    } catch (e) {
      console.error('[scheduling] 打卡失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，本次打卡未生效，请稍后重试')
    }
  })
}

// ---------------- 工时结算 ----------------
// 下班/离岗结算：基准工时工资 + 已批加班 1.5 倍时薪；离岗按实际出勤比例折算，旷工无薪。
// 结算同时把本班累计满意度（完工回写 + 迟到 + 旷工 + 加班补贴）落到员工士气，工资逐条入财务流水。
// 跨日夜班在次日 9:00 下班时刻自动结算（settle_day=次日）。
function settleAttendance(att, status) {
  return tx(() => {
    const st = getStaff(att.staff_id)
    const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(att.shift_id)
    const sch = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(att.schedule_id)
    const t = ctx.tick()
    const bounds = sch && sh ? shiftBounds(sch, sh) : { begin: att.checkin_tick, end: att.checkin_tick + 5 }
    const workTicks = Math.max(att.work_ticks, status === 'checked_out' ? Math.max(0, t - att.checkin_tick) : att.work_ticks)
    const plannedTicks = Math.max(1, bounds.end - bounds.begin)
    const hourly = hourlyWage(st?.wage ?? 300)
    const otMul = num(getSetting('otRateMul'), 1.5)

    let pay = 0
    let noteKind = '下班打卡结算'
    if (status === 'checked_out') {
      const otPay = att.ot_approved ? Math.round(hourly * otMul * att.overtime_ticks) : 0
      pay = Math.round(hourly * (sh?.standard_hours ?? 5)) + otPay
      noteKind = '下班自动结算'
    } else if (status === 'leave') {
      const ratio = Math.max(0, Math.min(1, workTicks / plannedTicks))
      pay = Math.round(hourly * (sh?.standard_hours ?? 5) * ratio)
      noteKind = '中途离岗结算'
    } else if (status === 'absent') {
      pay = 0
      noteKind = '旷工无薪'
    }

    let moraleDelta = att.satisfaction_delta
    if (att.late) moraleDelta -= 1
    if (att.ot_approved && att.overtime_ticks > 0) moraleDelta += 1
    if (status === 'absent') moraleDelta -= 6
    if (status === 'leave') moraleDelta -= 2

    db.prepare(`UPDATE staff_attendance
       SET status=?, checkout_tick=?, work_ticks=?, pay=?, settle_day=?, satisfaction_delta=?
       WHERE id=?`)
      .run(status, t, workTicks, pay, ctx.day(), moraleDelta, att.id)
    if (st) {
      db.prepare('UPDATE staff SET morale=? WHERE id=?')
        .run(Math.max(20, Math.min(100, st.morale + moraleDelta)), st.id)
    }
    if (pay > 0 && ctx.logFinance) {
      setSetting('cash', Math.round(ctx.cash() - pay))
      const otText = att.ot_approved && att.overtime_ticks ? `（含加班 ${att.overtime_ticks}h ×${otMul}）` : ''
      ctx.logFinance(ctx.day(), '工资', -pay,
        `${noteKind} ${att.code} · ${st?.name || `员工#${att.staff_id}`} · ${sh?.name || ''} ${otText}`)
    }
    logShift({
      scheduleId: att.schedule_id, attendanceId: att.id, action: status === 'checked_out' ? 'checkout' : status,
      note: `${noteKind}：出勤 ${workTicks}h${att.late ? '（迟到）' : ''}，满意度 ${moraleDelta >= 0 ? '+' : ''}${moraleDelta}，工资 ¥${pay}`,
      staffId: att.staff_id
    })
    return { ok: true, pay, workTicks, moraleDelta }
  })
}

// 旷工留痕（未打卡且班次结束）
function markAbsent(sch, sh) {
  const st = getStaff(sch.staff_id)
  const insAbs = db.prepare(`INSERT INTO staff_attendance(schedule_id,staff_id,day,shift_id,cross_day,checkin_tick,checkout_tick,work_ticks,status)
                             VALUES(?,?,?,?,?,0,?,0,'absent')`)
    .run(sch.id, sch.staff_id, sch.day, sch.shift_id, sh.cross_day ? 1 : 0, ctx.tick())
  const id = Number(insAbs.lastInsertRowid)
  const code = 'KQ' + String(id).padStart(4, '0')
  db.prepare('UPDATE staff_attendance SET code=?, settle_day=? WHERE id=?').run(code, ctx.day(), id)
  logShift({
    scheduleId: sch.id, attendanceId: id, action: 'absent',
    note: `${st?.name || '员工'} 未打卡上班，班次结束按旷工处理（无薪，满意度 -6）`, staffId: sch.staff_id
  })
  settleAttendance(db.prepare('SELECT * FROM staff_attendance WHERE id=?').get(id), 'absent')
}

// 员工中途离岗（非解雇）：当前考勤立即按实际工时折算结算
export function leavePost(attendanceId, { reason = '', requestId = '' } = {}) {
  return idempotent('schedule_leave', requestId, () => {
    try {
      const att = db.prepare("SELECT * FROM staff_attendance WHERE id=? AND status='checked_in'").get(attendanceId)
      if (!att) return fail('NOT_ON_DUTY', '考勤单不存在或已不在岗')
      const r = tx(() => {
        const out = settleAttendance(att, 'leave')
        db.prepare('UPDATE staff_attendance SET note=? WHERE id=?').run(`中途离岗：${String(reason).slice(0, 80) || '个人原因'}`, att.id)
        return out
      })
      return r
    } catch (e) {
      console.error('[scheduling] 离岗结算失败:', e)
      return fail('TX_FAILED', '系统繁忙，离岗未生效，请稍后重试')
    }
  })
}

// 解雇/离岗接续：未来排班全部取消、待审批调班单作废；在岗考勤立即离岗结算
export function releaseStaffSchedules(staffId) {
  return tx(() => {
    const t = ctx.tick()
    // 在岗考勤 → 立即离岗结算
    const onDuty = db.prepare("SELECT * FROM staff_attendance WHERE staff_id=? AND status='checked_in'").all(staffId)
    for (const att of onDuty) settleAttendance(att, 'leave')
    // 有效排班（含调班中）一律取消
    const scheds = db.prepare(`SELECT * FROM staff_schedules WHERE staff_id=? AND ${EFFECTIVE}`).all(staffId)
    for (const sch of scheds) {
      const att = attendanceBySchedule(sch.id)
      if (att && (att.status === 'checked_out' || att.status === 'absent')) continue
      db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE id=?").run(sch.id)
      logShift({ scheduleId: sch.id, action: 'cancel', note: '员工离岗，未执行排班自动取消', staffId })
    }
    // 本人发起的待审批申请 → 取消；本人作为调班目标的申请 → 取消并还原原排班
    const reqs = db.prepare("SELECT * FROM shift_requests WHERE status='pending' AND (staff_id=? OR target_staff_id=?)").all(staffId, staffId)
    for (const rq of reqs) {
      db.prepare("UPDATE shift_requests SET status='cancelled', handle_tick=?, handle_note='相关员工离岗，申请自动作废' WHERE id=?").run(t, rq.id)
      if (rq.kind === 'swap' && rq.target_staff_id === staffId && rq.schedule_id) {
        db.prepare("UPDATE staff_schedules SET status='scheduled' WHERE id=? AND status='swap'").run(rq.schedule_id)
      }
      logShift({ requestId: rq.id, action: rq.kind === 'swap' ? 'swap_reject' : 'ot_reject', note: '相关员工离岗，申请自动作废' })
    }
    return { schedules: scheds.length, onDuty: onDuty.length }
  })
}

// ---------------- 调班 / 加班协作 ----------------
// 员工发起调班：仅未开始的排班可调；目标同事同日不得已有排班（硬冲突拦截，覆盖缺口仅预警）
export function requestSwap({ staffId, scheduleId, targetStaffId, targetShiftId, targetDay, reason = '', requestId = '' }) {
  return idempotent('swap_request', requestId, () => {
    try {
      return tx(() => {
        const sch = db.prepare(`SELECT * FROM staff_schedules WHERE id=? AND ${EFFECTIVE}`).get(scheduleId)
        if (!sch) return fail('NOT_FOUND', '排班不存在或已取消')
        if (sch.staff_id !== staffId) return fail('NOT_OWN', '只能申请调整本人的排班')
        const st = getStaff(staffId)
        const target = getStaff(targetStaffId)
        if (!target || !target.active) return fail('STAFF_OFF', '代班同事不存在或已离岗')
        if (target.id === staffId) return fail('BAD_TARGET', '不能与本人调班')
        const sh = getShift(targetShiftId)
        if (!sh) return fail('SHIFT_NOT_FOUND', '目标班次不存在或已停用')
        targetDay = Math.round(num(targetDay, sch.day))
        if (targetDay < ctx.day()) return fail('DAY_PAST', '目标日期已过')
        const t = ctx.tick()
        const { begin: srcBegin } = shiftBounds(sch, getShift(sch.shift_id))
        if (srcBegin <= t) return fail('SHIFT_STARTED', '本班次已开始，不能调班')
        const targetBegin = linear(targetDay, sh.start_hour)
        if (targetDay === ctx.day() && targetBegin <= t) return fail('SHIFT_STARTED', '目标班次今日已开始')
        if (effectiveScheduleOf(target.id, targetDay)) return fail('SHIFT_CONFLICT', `${target.name} 目标日已有排班，存在冲突`)
        const dup = db.prepare("SELECT id FROM shift_requests WHERE kind='swap' AND status='pending' AND schedule_id=?").get(scheduleId)
        if (dup) return fail('REQUEST_PENDING', '该排班已有待审批的调班申请')

        const insReq = db.prepare(`INSERT INTO shift_requests(kind,staff_id,schedule_id,day,target_staff_id,target_shift_id,target_day,reason,status,create_tick,create_day)
                                  VALUES('swap',?,?,?,?,?,?,?,'pending',?,?)`)
          .run(staffId, sch.id, sch.day, target.id, sh.id, targetDay, String(reason).slice(0, 120), t, ctx.day())
        const id = Number(insReq.lastInsertRowid)
        const code = 'TB' + String(id).padStart(4, '0')
        db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(code, id)
        db.prepare("UPDATE staff_schedules SET status='swap' WHERE id=?").run(sch.id)
        logShift({
          scheduleId: sch.id, requestId: id, action: 'swap_request',
          note: `${st?.name} 申请与 ${target.name} 调班至第 ${targetDay} 天 ${sh.name}${reason ? `：${reason}` : ''}`, staffId
        })
        return { ok: true, id, code, warnings: coverageForDay(sch.day).warnings }
      })
    } catch (e) {
      console.error('[scheduling] 调班申请失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，申请未提交，请稍后重试')
    }
  })
}

// 运营主管审批调班：原子完成「原排班取消 + 代班人新排班」，任一步失败整体回滚；
// 提交后触发动态调度补齐调班留下的覆盖缺口
export function approveSwap(requestId, approverId) {
  let result
  try {
    result = tx(() => {
      const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='swap' AND status='pending'").get(requestId)
      if (!rq) return fail('REQUEST_GONE', '调班申请不存在或已处理')
      const src = db.prepare('SELECT * FROM staff_schedules WHERE id=?').get(rq.schedule_id)
      const from = getStaff(rq.staff_id)
      const target = getStaff(rq.target_staff_id)
      const sh = getShift(rq.target_shift_id)
      if (!src || src.status !== 'swap') return fail('SCHED_GONE', '原排班状态已变化，无法调班')
      if (!from?.active || !target?.active || !sh) return fail('STAFF_OFF', '相关员工已离岗或班次已停用')
      if (effectiveScheduleOf(target.id, rq.target_day)) return fail('SHIFT_CONFLICT', `${target.name} 目标日已有排班，调班冲突`)
      const t = ctx.tick()
      const targetBegin = linear(rq.target_day, sh.start_hour)
      if (targetBegin <= t) return fail('SHIFT_STARTED', '目标班次已开始，不能再调班')

      // 原排班取消（不会产生考勤，尚无打卡）
      db.prepare("UPDATE staff_schedules SET status='cancelled', note=? WHERE id=?")
        .run(`调班转出 → ${target.name}（${rq.code}）`, src.id)
      const insNs = db.prepare(`INSERT INTO staff_schedules(staff_id,shift_id,day,status,source,create_tick,create_day,note)
                               VALUES(?,?,?,'scheduled','swap',?,?,?)`)
        .run(target.id, sh.id, rq.target_day, t, ctx.day(), `调班接替 ${from.name}（${rq.code}）`)
      const ns = Number(insNs.lastInsertRowid)
      const nsCode = 'PB' + String(ns).padStart(4, '0')
      db.prepare('UPDATE staff_schedules SET code=? WHERE id=?').run(nsCode, ns)
      db.prepare("UPDATE shift_requests SET status='approved', approver_id=?, handle_tick=?, handle_note='主管批准调班' WHERE id=?")
        .run(approverId, t, rq.id)
      logShift({ scheduleId: src.id, requestId: rq.id, action: 'swap_approve', note: `调班批准：${from.name} → ${target.name}（第 ${rq.target_day} 天 ${sh.name}）`, approverId })
      logShift({ scheduleId: ns, requestId: rq.id, action: 'schedule', note: `${target.name} 调班接替排班`, staffId: target.id })
      return { ok: true, new_schedule_id: ns, affectedDays: [src.day, rq.target_day] }
    })
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return fail('SHIFT_CONFLICT', '代班人目标日已有排班，调班冲突')
    console.error('[scheduling] 调班审批失败，已整体回滚:', e)
    return fail('TX_FAILED', '系统繁忙，审批未生效，请稍后重试')
  }
  // 审批提交后再联动动态补位（补位失败不影响审批结果）
  if (result?.ok) {
    const days = result.affectedDays || []
    const dispatch = num(getSetting('scheduleAutoFill'), 1) && getSetting('scheduleMode', 'dynamic') === 'dynamic'
      ? runDynamicDispatch({ horizon: 3, urgentOvertime: true, reason: '调班审批后覆盖缺口补齐' })
      : null
    result.warnings = coverageForDay(days[days.length - 1] || ctx.day()).warnings
    result.dispatch = dispatch
  }
  return result
}

// 驳回调班：原排班恢复
export function rejectSwap(requestId, approverId, note = '主管驳回调班') {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='swap' AND status='pending'").get(requestId)
    if (!rq) return fail('REQUEST_GONE', '调班申请不存在或已处理')
    db.prepare("UPDATE shift_requests SET status='rejected', approver_id=?, handle_tick=?, handle_note=? WHERE id=?")
      .run(approverId, ctx.tick(), String(note).slice(0, 80), rq.id)
    db.prepare("UPDATE staff_schedules SET status='scheduled' WHERE id=? AND status='swap'").run(rq.schedule_id)
    logShift({ scheduleId: rq.schedule_id, requestId: rq.id, action: 'swap_reject', note, approverId })
    return { ok: true }
  })
}

// 员工加班申请：仅当值考勤可申请；日班下班+加班不晚于 18:00，跨日夜班不晚于次日 12:00
export function requestOvertime({ staffId, scheduleId, ticks, reason = '', requestId = '' }) {
  return idempotent('ot_request', requestId, () => {
    try {
      return tx(() => {
        ticks = Math.round(num(ticks))
        if (!Number.isInteger(ticks) || ticks < 1 || ticks > 4) return fail('BAD_OT', '加班时长需为 1~4 小时')
        const sch = db.prepare(`SELECT * FROM staff_schedules WHERE id=? AND ${EFFECTIVE}`).get(scheduleId)
        if (!sch || sch.staff_id !== staffId) return fail('NOT_FOUND', '排班不存在或不属于本人')
        const att = attendanceBySchedule(sch.id)
        if (!att || att.status !== 'checked_in') return fail('NOT_ON_DUTY', '仅当值员工可申请加班，请先打卡上班')
        const sh = getShift(sch.shift_id)
        const maxEnd = sh.cross_day ? 12 : CLOSE_HOUR
        const curEnd = sh.end_hour + att.overtime_ticks
        if (curEnd + ticks > maxEnd) return fail('OT_TOO_LONG', `加班后下班不得晚于${sh.cross_day ? '次日 ' : ''}${maxEnd}:00`)
        const dup = db.prepare("SELECT id FROM shift_requests WHERE kind='overtime' AND status='pending' AND schedule_id=?").get(sch.id)
        if (dup) return fail('REQUEST_PENDING', '该班次已有待审批的加班申请')

        const insOt = db.prepare(`INSERT INTO shift_requests(kind,staff_id,schedule_id,day,ot_ticks,reason,status,create_tick,create_day)
                                 VALUES('overtime',?,?,?,?,?,'pending',?,?)`)
          .run(staffId, sch.id, sch.day, ticks, String(reason).slice(0, 120), ctx.tick(), ctx.day())
        const id = Number(insOt.lastInsertRowid)
        const code = 'TB' + String(id).padStart(4, '0')
        db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(code, id)
        logShift({
          scheduleId: sch.id, attendanceId: att.id, requestId: id, action: 'ot_request',
          note: `申请加班 ${ticks}h${reason ? `：${reason}` : ''}（${sh.name}延后下班）`, staffId
        })
        return { ok: true, id, code }
      })
    } catch (e) {
      console.error('[scheduling] 加班申请失败，已整体回滚:', e)
      return fail('TX_FAILED', '系统繁忙，申请未提交，请稍后重试')
    }
  })
}

// 主管批准加班：写入考勤，下班点顺延，按 1.5 倍时薪结算
export function approveOvertime(requestId, approverId) {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='overtime' AND status='pending'").get(requestId)
    if (!rq) return fail('REQUEST_GONE', '加班申请不存在或已处理')
    const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(rq.schedule_id)
    if (!att || att.status !== 'checked_in') return fail('NOT_ON_DUTY', '员工已不在岗，加班申请自动失效')
    const sh = getShift(att.shift_id)
    const maxEnd = sh.cross_day ? 12 : CLOSE_HOUR
    if (sh.end_hour + att.overtime_ticks + rq.ot_ticks > maxEnd) return fail('OT_TOO_LONG', '加班后下班超出营业时段限制')
    db.prepare('UPDATE staff_attendance SET ot_approved=1, overtime_ticks=overtime_ticks+? WHERE id=?').run(rq.ot_ticks, att.id)
    db.prepare("UPDATE shift_requests SET status='approved', approver_id=?, handle_tick=?, handle_note='主管批准加班' WHERE id=?")
      .run(approverId, ctx.tick(), rq.id)
    logShift({
      scheduleId: rq.schedule_id, attendanceId: att.id, requestId: rq.id, action: 'ot_approve',
      note: `批准加班 ${rq.ot_ticks}h（1.5 倍时薪），下班顺延至 ${sh.cross_day ? '次日 ' : ''}${sh.end_hour + att.overtime_ticks + rq.ot_ticks}:00`, approverId
    })
    return { ok: true, overtime_ticks: att.overtime_ticks + rq.ot_ticks }
  })
}

export function rejectOvertime(requestId, approverId, note = '主管驳回加班') {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND kind='overtime' AND status='pending'").get(requestId)
    if (!rq) return fail('REQUEST_GONE', '加班申请不存在或已处理')
    db.prepare("UPDATE shift_requests SET status='rejected', approver_id=?, handle_tick=?, handle_note=? WHERE id=?")
      .run(approverId, ctx.tick(), String(note).slice(0, 80), rq.id)
    logShift({ scheduleId: rq.schedule_id, requestId: rq.id, action: 'ot_reject', note, approverId })
    return { ok: true }
  })
}

// 员工撤回本人待审批申请
export function cancelRequest(requestId, staffId) {
  return tx(() => {
    const rq = db.prepare("SELECT * FROM shift_requests WHERE id=? AND status='pending' AND staff_id=?").get(requestId, staffId)
    if (!rq) return fail('REQUEST_GONE', '申请不存在、已处理或非本人申请')
    db.prepare("UPDATE shift_requests SET status='cancelled', handle_tick=?, handle_note='员工撤回' WHERE id=?").run(ctx.tick(), rq.id)
    if (rq.kind === 'swap') db.prepare("UPDATE staff_schedules SET status='scheduled' WHERE id=? AND status='swap'").run(rq.schedule_id)
    logShift({ requestId: rq.id, scheduleId: rq.schedule_id, action: rq.kind === 'swap' ? 'swap_reject' : 'ot_reject', note: '员工撤回申请', staffId })
    return { ok: true }
  })
}

// ---------------- 需求画像（预约客流 / 检修工单 / 投诉岗位 → 班段×岗位需求） ----------------
// 班段 → 班次：早班/中班/晚班/跨日夜班；HOURS 为该班段在营业时段内覆盖的小时
const BANDS = [
  { key: 'morning', shift_code: 'morning', label: '早班', hours: [9, 10, 11] },
  { key: 'mid', shift_code: 'mid', label: '中班', hours: [12, 13] },
  { key: 'evening', shift_code: 'evening', label: '晚班', hours: [14, 15, 16, 17] },
  { key: 'night', shift_code: 'night', label: '夜班', hours: [17] }
]
const GUARD_ROLE_SET = ['保安', '安保']
const ROLE_GROUP = { guard: GUARD_ROLE_SET, clean: ['保洁'], repair: ['维修'] }
// 缺口对象中的角色名 → 角色数组
const ROLES_BY_NAME = { '保安/安保': GUARD_ROLE_SET, '保洁': ['保洁'], '维修工': ['维修'] }

// 历史散客均值（近 3 天每时段实际入园 - 预约核销入园），用于未来日客流预测；无历史时回落到基准值
function avgWalkinByHour() {
  const rows = db.prepare(`
    SELECT hour,
           AVG(count) avg_total,
           AVG((SELECT COALESCE(SUM(r.qty),0) FROM reservations r
                WHERE r.status='checked' AND r.scope='entry' AND r.slot_day=v.day AND r.slot_hour=v.hour)) avg_rsv
    FROM visitors v
    WHERE day BETWEEN ? AND ?
    GROUP BY hour`).all(Math.max(1, ctx.day() - 3), ctx.day() - 1)
  const map = new Map()
  for (const r of rows) map.set(r.hour, Math.max(0, num(r.avg_total) - num(r.avg_rsv)))
  return map
}

// 某日每营业小时的预约客流预测（入园预约 + 热门设施预约折算 + 未来日散客外推）
function hourlyFlow(day, walkMap) {
  const out = []
  for (let hour = OPEN_HOUR; hour <= CLOSE_HOUR; hour++) {
    const entry = db.prepare("SELECT COALESCE(SUM(booked_count),0) n FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?")
      .get(day, hour).n
    const ride = db.prepare("SELECT COALESCE(SUM(booked_count),0) n FROM reservation_slots WHERE scope='ride' AND day=? AND hour=?")
      .get(day, hour).n
    let flow = entry + Math.round(ride * 0.35)   // 设施排队同样产生秩序/保洁压力
    if (day > ctx.day()) {
      // 未来日：按近 3 天散客均值外推（新园无历史时，用基准客流的时段系数兜底）
      const hist = walkMap.get(hour)
      flow += hist ? Math.round(hist * 0.6) : Math.round(num(getSetting('guestBase'), 600) * (hour <= 10 ? 0.5 : hour >= 16 ? 0.6 : 1) * 0.6)
    }
    out.push({ hour, entry, ride: Math.round(ride * 0.35), flow })
  }
  return out
}

// 某日需求画像：班段 × 岗位（保安/保洁/维修）需求人数与依据
export function demandForDay(day) {
  day = Math.round(num(day))
  const walkMap = avgWalkinByHour()
  const hours = hourlyFlow(day, walkMap)
  const openZones = db.prepare('SELECT id,name FROM zones WHERE open=1 AND unlocked=1 ORDER BY id').all()
  const zoneN = openZones.length
  const guardFlowPer = Math.max(100, num(getSetting('dispatchGuardFlow'), 500))
  const cleanFlowPer = Math.max(100, num(getSetting('dispatchCleanFlow'), 700))

  const bands = BANDS.map(b => {
    const hs = hours.filter(h => b.hours.includes(h.hour))
    const flow = hs.reduce((s, h) => s + h.flow, 0)
    const peak = hs.reduce((m, h) => Math.max(m, h.flow), 0)
    return {
      key: b.key, label: b.label, shift_code: b.shift_code, hours: b.hours,
      flow, peak,
      // 客流驱动：每满一个承载阈值增配 1 人；至少保障每个班段有人（区域基线另行全日校验）
      need_guard: Math.max(zoneN ? 1 : 0, Math.ceil(peak / guardFlowPer)),
      need_clean: Math.max(zoneN ? 1 : 0, Math.ceil(flow / cleanFlowPer)),
      need_repair: 0,
      complaints: []
    }
  })
  const bandOf = k => bands.find(x => x.key === k)

  // 检修工单需求：每个在途工单需 1 名维修工；检修中优先排到早/中班推进，排队工单排早班接单
  const orders = db.prepare(`SELECT mo.id, mo.code, mo.status, mo.progress, r.name ride_name, r.zone_id
                             FROM maintenance_orders mo JOIN rides r ON r.id=mo.ride_id
                             WHERE mo.status IN ('queued','processing') ORDER BY mo.status, mo.id`).all()
  for (const o of orders) {
    const target = o.status === 'processing' ? (bandOf('mid').need_repair <= bandOf('morning').need_repair ? 'mid' : 'morning') : 'morning'
    bandOf(target).need_repair += 1
    const b = bandOf(target)
    ;(b.orders ||= []).push({ id: o.id, code: o.code, status: o.status, ride_name: o.ride_name, progress: o.progress, zone_id: o.zone_id })
  }

  // 投诉岗位需求：按岗位分组（保安类/保洁/维修）；紧急投诉优先早班，其余按严重度摊到早/中/晚
  const compBands = ['morning', 'mid', 'evening']
  const complaints = db.prepare("SELECT id,code,category,severity,status FROM complaints WHERE status IN ('open','processing','ready') ORDER BY severity DESC,id LIMIT 40").all()
  let compCursor = 0
  for (const c of complaints) {
    const roles = (ctx.complaintRoles?.[c.category] || []).filter(Boolean)
    if (!roles.length) continue   // 服务态度/价格争议无专属岗位，不进入排班需求
    let group = roles.some(r => GUARD_ROLE_SET.includes(r)) ? 'guard'
      : roles.includes('保洁') ? 'clean'
      : roles.includes('维修') ? 'repair' : null
    if (!group) continue
    const key = c.severity === 3 ? 'morning' : compBands[compCursor++ % compBands.length]
    const b = bandOf(key)
    b.complaints.push({ id: c.id, code: c.code, category: c.category, severity: c.severity, roles })
  }
  for (const b of bands) {
    const byRole = { guard: 0, clean: 0, repair: 0 }
    for (const c of b.complaints) {
      const g = c.roles.some(r => GUARD_ROLE_SET.includes(r)) ? 'guard' : c.roles.includes('保洁') ? 'clean' : 'repair'
      byRole[g] += 1
    }
    b.need_guard = Math.max(b.need_guard, byRole.guard > 0 ? 1 : 0)
    b.need_clean = Math.max(b.need_clean, byRole.clean > 0 ? 1 : 0)
    b.need_repair = b.need_repair + (byRole.repair > 0 ? 1 : 0)
  }

  // 跨日夜班需求：每 N 个开放区域至少 1 名夜勤保安（默认 N=0 不强制，运营可调）
  const nightPerZone = Math.max(0, num(getSetting('dispatchNightGuardsPerZone'), 0))
  bandOf('night').need_guard = nightPerZone > 0 ? Math.max(1, Math.ceil(zoneN / nightPerZone)) : 0
  bandOf('night').need_clean = 0
  bandOf('night').need_repair = 0

  return {
    day,
    isToday: day === ctx.day(),
    zones: openZones,
    hours,
    bands,
    flowTotal: hours.reduce((s, h) => s + h.flow, 0),
    openOrders: orders.length,
    openComplaints: complaints.length
  }
}

// ---------------- 岗位覆盖校验（需求驱动：班段 × 岗位 需/在岗对比 + 跨日夜班） ----------------
const GUARD_ROLES = GUARD_ROLE_SET
// 某日有效排班对应的在岗员工集合（含前一日跨日夜班在当日早晨仍在岗的人员）
function roster(day) {
  const list = db.prepare(`
    SELECT s.*, sc.id schedule_id, sc.day sched_day, sc.status sched_status, sc.source sched_source,
           sh.id shift_id, sh.code shift_code, sh.name shift_name,
           sh.start_hour, sh.end_hour, sh.cross_day, sh.color, sh.standard_hours,
           a.id att_id, a.status att_status, a.overtime_ticks, a.late
    FROM staff_schedules sc
    JOIN staff s ON s.id=sc.staff_id
    JOIN shift_templates sh ON sh.id=sc.shift_id
    LEFT JOIN staff_attendance a ON a.schedule_id=sc.id
    WHERE sc.${EFFECTIVE} AND s.active=1
      AND (sc.day=? OR (sh.cross_day=1 AND sc.day=?))`).all(day, day - 1)
  const t = ctx.tick()
  return list.map(s => {
    const begin = linear(s.sched_day, s.start_hour)
    const end = (s.cross_day ? linear(s.sched_day + 1, s.end_hour) : linear(s.sched_day, s.end_hour)) + (s.overtime_ticks || 0)
    return { ...s, begin_linear: begin, end_linear: end, on_duty_now: s.att_status === 'checked_in' && t >= begin && t < end }
  })
}

// 班段内某岗位在岗/已排人数；当天按真实考勤时段统计，未来/过去日按排班统计
function countByBand(list, day, bandKey, roleCheck) {
  const band = BANDS.find(b => b.key === bandKey)
  const t = ctx.tick()
  return list.filter(s => {
    if (!roleCheck(s.role)) return false
    if (s.cross_day) {
      // 跨日夜班只计入其上班日的晚班 17 点与夜班；前一日夜班在当日 9 点结束，不计入当日早班
      return day === s.sched_day && (bandKey === 'night' || (bandKey === 'evening' && band.hours.includes(17)))
    }
    if (s.sched_day !== day) return false
    if (day === ctx.day()) {
      // 当天：已下班/旷工/离岗不计当前在岗，未开始班次按"将到岗"统计（供未来小时预警区分）
      if (band.hours.some(h => linear(day, h) <= t)) {
        return !!s.on_duty_now && band.hours.some(h => { const l = linear(day, h); return l >= s.begin_linear && l < s.end_linear })
      }
      return band.shift_code === s.shift_code
    }
    return band.shift_code === s.shift_code
  }).length
}

// 排班/调班后校验当日岗位覆盖：客流/检修/投诉需求与班段在岗对比，给出量化缺口预警
// - warn：未来班段/未来日缺口，可由动态调度自动补位或主管调班补齐；
// - block：当天班段已经开始且在岗不足（检修中工单/紧急投诉无匹配岗位时升级为 block）
export function coverageForDay(day) {
  day = Math.round(num(day))
  const warnings = []
  const list = roster(day)
  const push = (type, level, msg, extra = {}) => warnings.push({ type, level, msg, ...extra })
  const isToday = day === ctx.day()
  const t = ctx.tick()
  const bandStarted = b => isToday && b.hours.some(h => linear(day, h) <= t)

  // 1) 区域全日基线：每个开放区域需有保安/安保与保洁（按员工归属区域）
  const zones = db.prepare('SELECT * FROM zones WHERE open=1 AND unlocked=1 ORDER BY id').all()
  for (const z of zones) {
    const here = list.filter(s => s.zone_id === z.id && !s.cross_day && s.sched_day === day)
    if (!here.some(s => GUARD_ROLES.includes(s.role))) push('zone_guard', 'warn', `「${z.name}」全日无保安/安保排班，秩序岗位缺岗`, { zone: z.name })
    if (!here.some(s => s.role === '保洁')) push('zone_clean', 'warn', `「${z.name}」全日无保洁排班，卫生岗位缺岗`, { zone: z.name })
  }

  // 2) 需求画像 → 班段 × 岗位缺口
  const demand = demandForDay(day)
  const checks = [
    { key: 'need_guard', type: 'flow_guard', roles: GUARD_ROLES, roleName: '保安/安保' },
    { key: 'need_clean', type: 'flow_clean', roles: ['保洁'], roleName: '保洁' },
    { key: 'need_repair', type: 'maintenance_band', roles: ['维修'], roleName: '维修工' }
  ]
  for (const b of demand.bands) {
    for (const c of checks) {
      const need = b[c.key]
      if (!need) continue
      const have = countByBand(list, day, b.key, r => c.roles.includes(r))
      if (have >= need) continue
      const started = bandStarted(b)
      let level = started ? 'warn' : 'warn'
      let reason = ''
      if (c.key === 'need_repair') {
        const proc = (b.orders || []).some(o => o.status === 'processing')
        level = started && proc ? 'block' : 'warn'
        reason = `检修工单 ${(b.orders || []).map(o => o.code).join('、')} 需要 ${c.roleName}`
      } else {
        reason = `${b.label}预测客流峰值 ${b.peak} 人`
      }
      push(c.type, level, `${b.label}（${b.hours[0]}:00~${b.key === 'evening' ? 18 : b.hours[b.hours.length - 1] + 1}:00）${c.roleName}需求 ${need} 人、在岗 ${have} 人，缺口 ${need - have} 人：${reason}`,
        { band: b.key, role: c.roleName, need, have, gap: need - have })
    }
    // 投诉岗位缺口（按班段挂载的投诉逐条提示，紧急投诉且班段已开始 → block）
    for (const c of b.complaints) {
      const roles = c.roles
      const roleCheck = r => roles.some(x => GUARD_ROLES.includes(x) ? GUARD_ROLES.includes(r) : r === x)
      const have = countByBand(list, day, b.key, roleCheck)
      if (have > 0) continue
      const level = bandStarted(b) && c.severity === 3 ? 'block' : 'warn'
      push('complaint', level,
        `${b.label}投诉 ${c.code}（${c.severity === 3 ? '紧急' : c.severity === 2 ? '严重' : '一般'}）需「${roles.join('/')}」岗位，当前缺口 1 人`,
        { band: b.key, complaint_id: c.id, complaint_code: c.code, severity: c.severity, need: 1, have: 0, gap: 1 })
    }
  }

  // 3) 在途检修工单兜底（无任何维修工排班 → 沿用旧版强提示）
  const allOrders = db.prepare("SELECT mo.*, r.name ride_name FROM maintenance_orders mo JOIN rides r ON r.id=mo.ride_id WHERE mo.status IN ('queued','processing')").all()
  for (const o of allOrders) {
    const covered = list.some(s => s.role === '维修' && !s.cross_day && s.sched_day === day)
    if (!covered) {
      push('maintenance', o.status === 'processing' ? 'block' : 'warn',
        `检修工单 ${o.code}（${o.ride_name}）${o.status === 'processing' ? '检修中' : '排队中'}，当日无维修工当班`,
        { order_id: o.id, order_code: o.code, ride_name: o.ride_name })
    }
  }

  return { day, warnings, rosterCount: list.length, demand }
}

// ---------------- 动态调度：按需求缺口自动补位 + 紧急加班调令 ----------------
// 疲劳规避：前一日上跨日夜班（次日 9 点才下班）的员工，当日日班不再排
function workedNightBefore(staffId, day) {
  return !!db.prepare(`
    SELECT 1 FROM staff_schedules sc
    JOIN shift_templates sh ON sh.id=sc.shift_id
    WHERE sc.staff_id=? AND sc.day=? AND sh.cross_day=1 AND sc.${EFFECTIVE}`).get(staffId, day - 1)
}

// 候选员工：在岗、非运营主管、当日无有效排班、非前夜夜班；按区域匹配与既有排班负载排序
function dispatchCandidates(day, roles, zoneId = null) {
  return db.prepare("SELECT * FROM staff WHERE active=1 AND role<>'运营主管' ORDER BY id").all()
    .filter(st => roles.includes(st.role))
    .filter(st => !effectiveScheduleOf(st.id, day))
    .filter(st => !workedNightBefore(st.id, day))
    .sort((a, b) => {
      const za = zoneId ? (a.zone_id === zoneId ? 0 : 1) : 0
      const zb = zoneId ? (b.zone_id === zoneId ? 0 : 1) : 0
      if (za !== zb) return za - zb
      const loadA = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE staff_id=? AND day BETWEEN ? AND ? AND ${EFFECTIVE}`).get(a.id, day, day + 2).n
      const loadB = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE staff_id=? AND day BETWEEN ? AND ? AND ${EFFECTIVE}`).get(b.id, day, day + 2).n
      return loadA - loadB || b.skill - a.skill
    })
}

// 计算某日班段 × 岗位缺口（直接以需求画像为事实源，避免从预警文案反推）
// 动态调度视角：当天班段进行中时，已排进本班段但尚未打卡的人也计入（引擎到点自动打卡/稍后补打卡）
export function gapsForDay(day, { forDispatch = true } = {}) {
  const demand = demandForDay(day)
  const list = roster(day)
  const t = ctx.tick()
  const countRole = (bandKey, roles) => list.filter(s => {
    if (!roles.includes(s.role)) return false
    const band = BANDS.find(b => b.key === bandKey)
    if (s.cross_day) {
      return day === s.sched_day && (bandKey === 'night' || (bandKey === 'evening' && band.hours.includes(17)))
    }
    if (s.sched_day !== day) return false
    if (band.shift_code !== s.shift_code) return false
    if (forDispatch && day === ctx.day()) {
      const curHour = OPEN_HOUR + (t - linear(day, OPEN_HOUR))
      const inBand = band.hours.some(h => h <= curHour)
      // 进行中班段：真实在岗 或 已排本班（引擎到点自动打卡）都算动态调度覆盖
      if (inBand) return !!s.on_duty_now || s.shift_code === band.shift_code
    }
    return true
  }).length
  const gaps = []
  const roleChecks = [
    { role: '保安/安保', needKey: 'need_guard' },
    { role: '保洁', needKey: 'need_clean' },
    { role: '维修工', needKey: 'need_repair' }
  ]
  for (const b of demand.bands) {
    for (const c of roleChecks) {
      const rolesArr = ROLES_BY_NAME[c.role]
      // 维修工需求含投诉驱动（need_repair 已合并检修工单 + 设施类投诉）；保安/保洁需求已含投诉兜底
      const need = b[c.needKey]
      if (!need) continue
      const have = forDispatch ? countRole(b.key, rolesArr) : countByBand(list, day, b.key, r => rolesArr.includes(r))
      if (have >= need) continue
      // 硬需求只认本岗位相关的工单/投诉（维修缺口挂维修工单，保安/保洁缺口不会因为有检修单就变硬）
      const relatedComplaints = b.complaints.filter(x => rolesArr.some(r => (x.roles || []).includes(r)))
      const relatedOrders = c.role === '维修工' ? (b.orders || []) : []
      const hard = relatedOrders.length > 0 || relatedComplaints.length > 0
      gaps.push({ band: b.key, role: c.role, roles: rolesArr, need, have, gap: need - have, hard,
        orders: relatedOrders, complaints: relatedComplaints })
    }
  }
  return { demand, gaps }
}

// 按需求画像为未来 horizon 天（含当天）补齐缺口；返回补位明细。
// 当天未开始班段：正常补排；已开始班段：硬需求（检修/投诉）允许跨班段临班补排（未开始且时段重叠的邻班，
// 如中班缺维修工 → 排未开始的晚班，14 点到岗后即可接单）；仍补不上的缺口转为紧急加班调令（主管审批）。
export function runDynamicDispatch({ horizon = 3, reason = '', urgentOvertime = false } = {}) {
  const created = []
  const otRequests = []
  const today = ctx.day()
  const t = ctx.tick()
  const shifts = listShiftTemplates({ activeOnly: true })

  for (let d = today; d <= today + horizon - 1; d++) {
    // 逐班段 × 岗位缺口补位；每补一个人都会影响候选池与缺口数，故每轮实时重算
    for (const band of BANDS) {
      for (let pass = 0; pass < 24; pass++) {
        // 该班段仍未消解的全部岗位缺口，按硬需求（检修/投诉）优先补
        const gapsNow = gapsForDay(d).gaps
          .filter(x => x.band === band.key && x.gap > 0)
          .sort((a, b2) => Number(b2.hard) - Number(a.hard) || b2.gap - a.gap)
        if (!gapsNow.length) break
        const g = gapsNow[0]
        const sh = shifts.find(x => x.code === band.shift_code)
        if (!sh) break
        const curHour = OPEN_HOUR + (t - linear(d, OPEN_HOUR))
        const bandEndHour = band.hours[band.hours.length - 1] + 1
        const bandStarted = d === today && curHour >= sh.start_hour
        const bandLive = d !== today || curHour < bandEndHour

        // 目标班次：班段未开始/进行中 → 本班（进行中用 allowStarted 放进班，引擎随后自动打卡）；
        // 班段已过的硬需求 → 当日未开始且与缺口时段重叠的最近邻班接续；其余缺口不再补排（转加班调令）
        let target = null
        let allowStarted = false
        let noteSuffix = ''
        if (!bandStarted || bandLive) {
          target = sh
          allowStarted = bandStarted
        } else if (g.hard) {
          target = shifts
            .filter(x => !x.cross_day && x.start_hour > curHour && x.start_hour <= band.hours[band.hours.length - 1])
            .sort((a, b2) => a.start_hour - b2.start_hour)[0] || null
          if (target) noteSuffix = `（原${band.label}已过，${target.name}接续补位）`
        }
        if (!target) break
        const cand = dispatchCandidates(d, g.roles)[0]
        if (!cand) break
        const rr = createSchedule({
          staffId: cand.id, shiftId: target.id, day: d, source: 'dispatch',
          note: reason ? `动态调度：${reason}${noteSuffix}` : `动态调度补${band.label}${g.role}缺口${noteSuffix}`,
          requestId: `disp-${d}-${target.id}-${cand.id}-${band.key}-${pass}`,
          allowStarted
        })
        if (!rr.ok) break
        created.push({ id: rr.id, code: rr.code, staff_id: cand.id, staff_name: cand.name, day: d, band: band.key, shift: target.code })
      }
    }

    // 班段补排全部尝试后，仍存在的当天已开始班段缺口 → 紧急加班调令（相邻班段在岗员工，主管审批）
    if (urgentOvertime) {
      for (const g of gapsForDay(d).gaps) {
        const sh = shifts.find(x => x.code === BANDS.find(b => b.key === g.band).shift_code)
        if (!sh) continue
        if (d !== today || linear(d, sh.start_hour) > t) continue
        otRequests.push(...createUrgentOvertime(d, g, reason))
      }
    }
  }
  return { ok: true, created, otRequests, days: horizon }
}

// 紧急加班调令：班段已开始且补不上人时，给相邻班段在岗、岗位匹配的员工生成系统加班申请（主管审批）
function createUrgentOvertime(day, gap, reason) {
  const out = []
  const t = ctx.tick()
  // 找当前在岗、岗位匹配、加班不超时段限制、且没有待审批加班申请的员工
  const onDuty = roster(day).filter(s => s.on_duty_now && !s.cross_day)
  const roles = ROLES_BY_NAME[gap.role] || ROLES_BY_NAME['维修工']
  let need = gap.gap
  for (const s of onDuty) {
    if (need <= 0) break
    if (!roles.includes(s.role)) continue
    const sh = getShift(s.shift_id)
    if (!sh) continue
    const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(s.schedule_id)
    if (!att || att.status !== 'checked_in') continue
    // 加班补到当前班段结束（中班缺口补到 17:00、晚班缺口补到闭园 18:00），日班加班上限 4h
    const curHour = OPEN_HOUR + (t - linear(day, OPEN_HOUR))
    const bandEnd = gap.band === 'morning' ? 14 : gap.band === 'mid' ? 17 : CLOSE_HOUR
    const ticks = Math.min(4, Math.max(1, bandEnd - curHour - att.overtime_ticks))
    if (sh.end_hour + att.overtime_ticks + ticks > CLOSE_HOUR) continue
    const dup = db.prepare("SELECT id FROM shift_requests WHERE kind='overtime' AND status='pending' AND schedule_id=?").get(s.schedule_id)
    if (dup) continue
    const id = Number(db.prepare(`INSERT INTO shift_requests(kind,staff_id,schedule_id,day,ot_ticks,reason,status,source,create_tick,create_day)
                                 VALUES('overtime',?,?,?,?,?, 'pending','dispatch',?,?)`)
      .run(s.id, s.schedule_id, day, ticks,
        `系统紧急调令：${gap.band === 'morning' ? '早' : gap.band === 'mid' ? '中' : '晚'}班${gap.role}缺岗 ${gap.gap} 人${reason ? `（${reason}）` : ''}，请加班补位`,
        t, day).lastInsertRowid)
    const code = 'TB' + String(id).padStart(4, '0')
    db.prepare('UPDATE shift_requests SET code=? WHERE id=?').run(code, id)
    logShift({
      scheduleId: s.schedule_id, attendanceId: att.id, requestId: id, action: 'ot_request',
      note: `动态调度生成紧急加班调令：${s.name}${gap.role}加班 ${ticks}h 补 ${gap.band}班缺口，待主管审批`, staffId: s.id
    })
    out.push({ id, code, staff_id: s.id, ticks })
    need--
  }
  return out
}

// 操作联动钩子：调班批准/取消/解雇/报修/投诉建单后触发（受自动补位总开关与动态模式约束）
export function maybeDispatchAfter(reason = '岗位需求变化') {
  if (!num(getSetting('scheduleAutoFill'), 1)) return { ok: true, skipped: true }
  if (getSetting('scheduleMode', 'dynamic') !== 'dynamic') return { ok: true, skipped: true }
  try {
    return runDynamicDispatch({ reason })
  } catch (e) {
    console.error('[scheduling] 联动动态调度失败（不影响主操作）:', e)
    return { ok: false, msg: '动态调度失败' }
  }
}

// ---------------- 引擎：自动补位 / 打卡 / 工时累计 / 下班结算 ----------------
// 基础模式：为未来 horizon-1 天无有效排班的在岗员工按轮换补排日班（兼容旧玩法）
function autoFillSchedules() {
  if (!num(getSetting('scheduleAutoFill'), 1)) return
  if (!db.prepare('SELECT COUNT(*) n FROM shift_templates WHERE active=1').get().n) return
  if (getSetting('scheduleMode', 'dynamic') === 'dynamic') {
    // 动态模式：按预约客流 / 检修工单 / 投诉岗位需求补缺口（含当天紧急加班调令）
    runDynamicDispatch({ horizon: 3, urgentOvertime: true, reason: '引擎每小时需求巡检' })
    return
  }
  const dayShifts = listShiftTemplates({ activeOnly: true }).filter(s => !s.cross_day)
  if (!dayShifts.length) return
  const today = ctx.day()
  for (let d = today; d <= today + 2; d++) {
    const staff = db.prepare("SELECT * FROM staff WHERE active=1 AND role<>'运营主管' ORDER BY id").all()
    for (const st of staff) {
      if (effectiveScheduleOf(st.id, d)) continue
      if (workedNightBefore(st.id, d)) continue
      const sh = dayShifts[Math.abs(st.id * 7 + d * 3) % dayShifts.length]
      // 当天只补排尚未开始的班次
      if (d === today && linear(d, sh.start_hour) <= ctx.tick()) continue
      createSchedule({ staffId: st.id, shiftId: sh.id, day: d, source: 'auto' })
    }
  }
}

// 每游戏小时推进：自动排班 → 到点打卡 → 出勤工时累计 → 下班结算 / 旷工标记（跨日夜班次日结算）
export function processScheduling() {
  autoFillSchedules()
  const t = ctx.tick()
  const scheds = db.prepare(`SELECT * FROM staff_schedules WHERE ${EFFECTIVE} ORDER BY id`).all()
  for (const sch of scheds) {
    try {
      const sh = getShift(sch.shift_id)
      if (!sh) continue
      const { begin, end } = shiftBounds(sch, sh)
      const att = attendanceBySchedule(sch.id)
      if (!att) {
        if (t >= begin && t < end) {
          // 到点未打卡（引擎每小时执行，正常与开始时刻同 tick）→ 自动打卡
          checkin(sch.id)
        } else if (t >= end) {
          tx(() => markAbsent(sch, sh))
        }
      } else if (att.status === 'checked_in') {
        const workTicks = Math.max(0, t - att.checkin_tick)
        if (t >= end + att.overtime_ticks) {
          settleAttendance({ ...att, work_ticks: workTicks }, 'checked_out')
        } else if (workTicks !== att.work_ticks) {
          db.prepare('UPDATE staff_attendance SET work_ticks=? WHERE id=?').run(workTicks, att.id)
        }
      }
    } catch (e) {
      // 逐人容错：一人考勤异常不拖垮整批与游戏主循环（结算事务已回滚）
      console.error(`[scheduling] 排班 #${sch.id} 推进失败（已跳过）:`, e)
    }
  }
}

// 日结汇总：闭园时统计当日旷工（跨日夜班次日才结算，不在此列）
export function dayCloseSummary(day) {
  const absent = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE day=? AND cross_day=0 AND status=?').get(day, 'absent').n
  // 当日下班/离岗结算（settle_day=day，含跨日夜班次日下班）的人数、工资与加班
  const settled = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pay),0) p, COALESCE(SUM(overtime_ticks),0) ot FROM staff_attendance WHERE settle_day=? AND status IN ('checked_out','leave')").get(day)
  const left = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE settle_day=? AND status=?').get(day, 'leave').n
  return { absent, settledCount: settled.n, totalPay: settled.p, overtimeHours: settled.ot, leaveCount: left }
}

// ---------------- 完工回写（检修/投诉处置完工 → 工时与满意度回流） ----------------
// 检修工单完工 / 投诉补偿结案时调用：给当值员工本班满意度加分（维修 +3 / 投诉 +2），结算时统一落到士气
export function writeWorkCompletion(staffId, kind, meta = {}) {
  if (!staffId) return { ok: false }
  const att = db.prepare("SELECT * FROM staff_attendance WHERE staff_id=? AND status='checked_in' ORDER BY id DESC LIMIT 1").get(staffId)
  if (!att) return { ok: false, msg: '员工当前不在岗，完工满意度不回写' }
  const delta = kind === 'maintenance' ? 3 : 2
  const label = kind === 'maintenance' ? '设施检修完工' : '投诉处置结案'
  db.prepare('UPDATE staff_attendance SET satisfaction_delta=satisfaction_delta+? WHERE id=?').run(delta, att.id)
  const note = `${label}满意度 +${delta}${meta.code ? `（${meta.code}）` : ''}`
  db.prepare('UPDATE staff_attendance SET note=? WHERE id=?').run(String((att.note ? att.note + '；' : '') + note).slice(0, 200), att.id)
  logShift({ scheduleId: att.schedule_id, attendanceId: att.id, action: 'workdone', note, staffId })
  return { ok: true, attendance_id: att.id, delta }
}

// 派工校验：检修接单 / 投诉受理时检查员工当日排班与当前在岗状态
// 返回 { scheduled, onDuty, attendanceId, msg }；onDuty=false 时进度推进暂停（不视为离岗退单）
export function staffDutyState(staffId) {
  const st = getStaff(staffId)
  if (!st || !st.active) return { scheduled: false, onDuty: false, msg: '员工不存在或已离岗' }
  const t = ctx.tick()
  const sch = effectiveScheduleOf(staffId, ctx.day())
  if (!sch) return { scheduled: false, onDuty: false, msg: `${st.name} 今日无排班，不能派工` }
  const sh = getShift(sch.shift_id)
  const { begin, end } = shiftBounds(sch, sh)
  const att = attendanceBySchedule(sch.id)
  if (att && att.status === 'checked_in') {
    if (t >= begin && t < end + att.overtime_ticks) return { scheduled: true, onDuty: true, attendanceId: att.id, scheduleId: sch.id }
    return { scheduled: true, onDuty: false, attendanceId: att.id, scheduleId: sch.id, msg: `${st.name} 当前不在班次时段内` }
  }
  // 跨日夜班：昨日的夜班考勤今早仍在岗
  const night = db.prepare(`
    SELECT a.* FROM staff_attendance a
    JOIN shift_templates sh ON sh.id=a.shift_id
    WHERE a.staff_id=? AND a.status='checked_in' AND sh.cross_day=1 AND a.day=?`).get(staffId, ctx.day() - 1)
  if (night) return { scheduled: true, onDuty: true, attendanceId: night.id, scheduleId: night.schedule_id }
  return { scheduled: true, onDuty: false, scheduleId: sch.id, msg: `${st.name} 今日有排班但尚未打卡上班` }
}

// ---------------- 查询 ----------------
function enrichSchedule(sch) {
  const st = getStaff(sch.staff_id)
  const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(sch.shift_id)
  const att = attendanceBySchedule(sch.id)
  const bounds = sh ? shiftBounds(sch, sh) : { begin: 0, end: 0 }
  const t = ctx.tick()
  const x = {
    ...sch,
    staff_name: st?.name || '',
    staff_role: st?.role || '',
    staff_active: st ? !!st.active : false,
    staff_zone_id: st?.zone_id ?? null,
    shift_name: sh?.name || '',
    shift_code: sh?.code || '',
    shift_color: sh?.color || '#66a6ff',
    start_hour: sh?.start_hour ?? 0,
    end_hour: sh?.end_hour ?? 0,
    cross_day: sh?.cross_day ?? 0,
    standard_hours: sh?.standard_hours ?? 5,
    time_text: sh ? (sh.cross_day ? `${sh.start_hour}:00~次日${String(sh.end_hour).padStart(2, '0')}:00` : `${sh.start_hour}:00~${sh.end_hour}:00`) : '',
    begin_linear: bounds.begin,
    end_linear: bounds.end,
    att_status: att?.status || '',
    att_code: att?.code || '',
    work_ticks: att?.work_ticks || 0,
    overtime_ticks: att?.overtime_ticks || 0,
    ot_approved: att?.ot_approved ? 1 : 0,
    late: att?.late ? 1 : 0,
    pay: att?.pay || 0,
    satisfaction_delta: att?.satisfaction_delta || 0,
    attendance_id: att?.id || null,
    on_duty: att?.status === 'checked_in' && t >= bounds.begin && t < bounds.end + (att.overtime_ticks || 0),
    night_phase: ''
  }
  // 跨日夜班在看板上的实时阶段：upcoming 未到岗 / night_on 当夜值守 / morning_after 次日凌晨值守 / done 已下班
  if (sh?.cross_day) {
    const nightStart = linear(sch.day, sh.start_hour)
    if (t < nightStart) x.night_phase = 'upcoming'
    else if (t < linear(sch.day, CLOSE_HOUR)) x.night_phase = 'night_on'
    else if (t < bounds.end || (att?.status === 'checked_in' && t < bounds.end + (att.overtime_ticks || 0))) x.night_phase = 'morning_after'
    else x.night_phase = 'done'
  }
  return x
}

export function listSchedules({ day = null, from = null, to = null, staffId = null, status = null, limit = 500 } = {}) {
  const where = []
  const args = []
  if (day !== null) { where.push('day=?'); args.push(day) }
  if (from !== null) { where.push('day>=?'); args.push(from) }
  if (to !== null) { where.push('day<=?'); args.push(to) }
  if (staffId) { where.push('staff_id=?'); args.push(staffId) }
  if (status) { where.push('status=?'); args.push(status) }
  const sql = `SELECT * FROM staff_schedules ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY day DESC,id DESC LIMIT ?`
  args.push(limit)
  return db.prepare(sql).all(...args).map(enrichSchedule)
}

export function listAttendance({ day = null, staffId = null, status = null, settleDay = null, limit = 200 } = {}) {
  const where = []
  const args = []
  if (day !== null) { where.push('day=?'); args.push(day) }
  if (settleDay !== null) { where.push('settle_day=?'); args.push(settleDay) }
  if (staffId) { where.push('staff_id=?'); args.push(staffId) }
  if (status) { where.push('status=?'); args.push(status) }
  const rows = db.prepare(`SELECT * FROM staff_attendance ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit)
  return rows.map(a => {
    const st = getStaff(a.staff_id)
    const sh = db.prepare('SELECT * FROM shift_templates WHERE id=?').get(a.shift_id)
    return {
      ...a,
      staff_name: st?.name || '',
      staff_role: st?.role || '',
      shift_name: sh?.name || '',
      shift_color: sh?.color || '#66a6ff',
      time_text: sh ? (sh.cross_day ? `${sh.start_hour}:00~次日${String(sh.end_hour).padStart(2, '0')}:00` : `${sh.start_hour}:00~${sh.end_hour}:00`) : '',
      hourly_wage: hourlyWage(st?.wage ?? 300)
    }
  })
}

export function listRequests({ status = null, kind = null, limit = 200 } = {}) {
  const where = []
  const args = []
  if (status) { where.push('r.status=?'); args.push(status) }
  if (kind) { where.push('r.kind=?'); args.push(kind) }
  const rows = db.prepare(`
    SELECT r.*, s.name staff_name, s.role staff_role, s.active staff_active,
           t.name target_name, t.role target_role,
           sh.name shift_name, tsh.name target_shift_name, tsh.cross_day target_cross_day
    FROM shift_requests r
    JOIN staff s ON s.id=r.staff_id
    LEFT JOIN staff t ON t.id=r.target_staff_id
    LEFT JOIN shift_templates sh ON sh.id=(SELECT shift_id FROM staff_schedules WHERE id=r.schedule_id)
    LEFT JOIN shift_templates tsh ON tsh.id=r.target_shift_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.id DESC LIMIT ?`).all(...args, limit)
  return rows
}

export function shiftLogs(ref) {
  const where = []
  const args = []
  if (ref.scheduleId) { where.push('schedule_id=?'); args.push(ref.scheduleId) }
  if (ref.attendanceId) { where.push('attendance_id=?'); args.push(ref.attendanceId) }
  if (ref.requestId) { where.push('request_id=?'); args.push(ref.requestId) }
  if (!where.length) return []
  return db.prepare(`SELECT l.*, s.name staff_name, ap.name approver_name
                     FROM shift_logs l
                     LEFT JOIN staff s ON s.id=l.staff_id
                     LEFT JOIN staff ap ON ap.id=l.approver_id
                     WHERE ${where.join(' OR ')} ORDER BY l.id`).all(...args)
}

export function schedulingStats() {
  const day = ctx.day()
  const todaySched = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE day=? AND ${EFFECTIVE}`).get(day).n
  const onDuty = db.prepare("SELECT COUNT(*) n FROM staff_attendance WHERE status='checked_in' AND checkin_tick<=? AND checkout_tick=0").get(ctx.tick()).n
  const absent = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE day=? AND status=?').get(day, 'absent').n
  const late = db.prepare('SELECT COUNT(*) n FROM staff_attendance WHERE day=? AND late=1').get(day).n
  const ot = db.prepare('SELECT COALESCE(SUM(overtime_ticks),0) n FROM staff_attendance WHERE day=? AND ot_approved=1').get(day).n
  const payRow = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pay),0) p FROM staff_attendance WHERE settle_day=? AND status IN ('checked_out','leave')").get(day)
  const pending = db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE status='pending'").get().n
  const dispatchOt = db.prepare("SELECT COUNT(*) n FROM shift_requests WHERE status='pending' AND source='dispatch'").get().n
  const dispatchToday = db.prepare(`SELECT COUNT(*) n FROM staff_schedules WHERE create_day=? AND source='dispatch'`).get(day).n
  // 跨日夜班：前一日 17 点上班、当前仍在岗（次日凌晨值守）的人数（次日 9:00 即自动结算）
  const nightOn = db.prepare(`SELECT COUNT(*) n FROM staff_attendance a
    JOIN shift_templates sh ON sh.id=a.shift_id
    WHERE a.status='checked_in' AND sh.cross_day=1 AND a.day=?`).get(day - 1).n
  const coverage = coverageForDay(day)
  return {
    day,
    todayScheduled: todaySched,
    onDuty,
    absentToday: absent,
    lateToday: late,
    overtimeHoursToday: ot,
    settledToday: payRow.n,
    payToday: payRow.p,
    pendingRequests: pending,
    dispatchOtRequests: dispatchOt,
    dispatchFilledToday: dispatchToday,
    nightOnDuty: nightOn,
    flowToday: coverage.demand.flowTotal,
    coverageWarnings: coverage.warnings.length,
    coverageBlocks: coverage.warnings.filter(w => w.level === 'block').length
  }
}

// 未来 horizon 天动态调度计划（只读）：需求画像 + 当前覆盖缺口，供前端「动态调度」页展示
export function dispatchPlan({ horizon = 3 } = {}) {
  const today = ctx.day()
  const days = []
  for (let d = today; d <= today + horizon - 1; d++) {
    const cov = coverageForDay(d)
    days.push({ day: d, demand: cov.demand, warnings: cov.warnings, rosterCount: cov.rosterCount })
  }
  return {
    today,
    mode: getSetting('scheduleMode', 'dynamic'),
    autoFill: num(getSetting('scheduleAutoFill'), 1) ? 1 : 0,
    params: {
      guardFlow: num(getSetting('dispatchGuardFlow'), 500),
      cleanFlow: num(getSetting('dispatchCleanFlow'), 700),
      nightGuardsPerZone: num(getSetting('dispatchNightGuardsPerZone'), 0)
    },
    days
  }
}
