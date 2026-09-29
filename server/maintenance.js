import db, { getSetting, setSetting, tx } from './db.js'

// 设施检修工单模块：报修排队 → 维修员工接单 → 按游戏小时推进 → 完工恢复运营
// 停运期间复用预约模块联动退改（关时段/全额退款/投诉），完工费用记入财务流水
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

// 由 index.js 注入共享上下文（时钟、现金、财务流水、停运时段联动、投诉推进、排班在岗校验、完工回写）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,
  syncRideSlots: null,
  linkComplaintsToRide: null,
  staffDutyState: null,    // 排班模块：派工/推进前校验员工当日排班与当前在岗状态
  onWorkComplete: null     // 排班模块：完工回写工时与满意度
}
export function initMaintenanceContext(deps) {
  Object.assign(ctx, deps)
}

const OPEN_ORDER = "status IN ('queued','processing')"

// 维修速度（每游戏小时推进的进度）：技能/士气越高越快，维修岗 1.5 倍岗位加成
function repairRate(st) {
  return (10 + st.skill * 6 + st.morale / 12) * 1.5
}

// 检修费用按当前健康度核定：越坏越贵，完工时结算入账
export function repairCostFor(health) {
  return Math.round(Math.max(1500, Math.min(12000, 10000 - health * 85)))
}

function logOrder(oid, action, note = '', staffId = null) {
  db.prepare('INSERT INTO maintenance_logs(order_id,tick,day,hour,action,note,staff_id) VALUES(?,?,?,?,?,?,?)')
    .run(oid, ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}

// ---------------- 报修 / 接单 / 转派 / 撤销 ----------------
// 报修：设施转入检修停运并联动关停预约时段（停运退改由预约模块处理）；同设施只允许一个在途工单。
// 建工单 + 设施停运 + 关时段/批量退款/投诉在同一事务提交：联动任一步失败整体回滚并返回失败，
// 不会出现"设施停运了、工单建了，但时段没关、游客款没退"的半完成状态
export function createMaintenanceOrder(rideId, source = 'manual', note = '') {
  try {
    return tx(() => {
      const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(rideId)
      if (!ride) return { ok: false, msg: '设施不存在' }
      const exist = db.prepare(`SELECT id FROM maintenance_orders WHERE ride_id=? AND ${OPEN_ORDER}`).get(rideId)
      if (exist) return { ok: false, msg: '该设施已有在途检修工单' }

      const cost = repairCostFor(ride.health)
      const r = db.prepare(`INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day,note)
                            VALUES(?,?,'queued',?,0,?,?,?,?)`)
        .run('', rideId, source, cost, ctx.tick(), ctx.day(), note || '')
      const id = Number(r.lastInsertRowid)
      const code = 'WX' + String(id).padStart(4, '0')
      db.prepare('UPDATE maintenance_orders SET code=? WHERE id=?').run(code, id)
      logOrder(id, 'create',
        source === 'auto' ? '健康度过低自动停运，已生成检修工单'
          : source === 'system' ? '兼容既有检修状态，补建检修工单'
          : '运营报修，设施转入检修停运')

      db.prepare("UPDATE rides SET status='maintenance' WHERE id=?").run(rideId)
      // 停运联动（关时段+批量退款+投诉）失败 → 抛错整体回滚，工单与停运状态一并撤销
      const sync = ctx.syncRideSlots?.({ ...ride, status: 'maintenance' })
      if (sync && !sync.ok) throw new Error(`停运联动失败：${sync.msg || sync.code || '未知错误'}`)
      return { ok: true, id, code, cost }
    })
  } catch (e) {
    console.error('[maintenance] 报修停运失败，已整体回滚:', e)
    return { ok: false, msg: '停运联动失败，本次报修未生效，请稍后重试' }
  }
}

// 接单 / 转派：仅在岗维修员工可接，每人同时只允许接手一个在修工单（排队等待中的可转给空闲维修工）
export function assignMaintenanceOrder(id, staffId) {
  const o = db.prepare('SELECT * FROM maintenance_orders WHERE id=?').get(id)
  if (!o || !['queued', 'processing'].includes(o.status)) return { ok: false, msg: '工单不存在或已完结' }
  const st = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(staffId)
  if (!st) return { ok: false, msg: '员工不存在或已离岗' }
  if (st.role !== '维修') return { ok: false, msg: '只有维修员工可以承接检修工单' }
  const busy = db.prepare(`SELECT mo.* FROM maintenance_orders mo WHERE mo.assignee_id=? AND mo.status='processing' AND mo.id<>?`).get(st.id, id)
  if (busy) {
    const ride = db.prepare('SELECT name FROM rides WHERE id=?').get(busy.ride_id)
    return { ok: false, msg: `${st.name} 正在检修「${ride?.name || '其他设施'}」，请先转派其手头工单` }
  }
  // 排班校验：接单维修工当日必须有排班（当前未到班可先接单排队，到班打卡后才推进）
  const duty = ctx.staffDutyState?.(st.id)
  if (duty && !duty.scheduled) return { ok: false, code: 'NOT_SCHEDULED', msg: duty.msg || `${st.name} 今日无排班，不能承接检修工单` }

  const prev = o.assignee_id ? db.prepare('SELECT name FROM staff WHERE id=?').get(o.assignee_id) : null
  db.prepare("UPDATE maintenance_orders SET status='processing', assignee_id=?, start_tick=? WHERE id=?")
    .run(st.id, ctx.tick(), id)
  if (prev) {
    logOrder(id, 'transfer', `工单由 ${prev.name} 转派给 ${st.name}（${st.role}），沿用既有进度 ${Math.round(o.progress)}%`, st.id)
  } else {
    logOrder(id, 'assign', `${st.name}（${st.role} · Lv.${st.skill}）接单开始检修`, st.id)
  }
  return { ok: true }
}

// 维修工离岗接续：手头在修工单退回排队，进度保留，可由其他维修工继续
export function releaseStaffOrders(staffId) {
  const rows = db.prepare("SELECT * FROM maintenance_orders WHERE assignee_id=? AND status='processing'").all(staffId)
  for (const o of rows) {
    db.prepare("UPDATE maintenance_orders SET status='queued', assignee_id=NULL WHERE id=?").run(o.id)
    logOrder(o.id, 'release', `受理维修工离岗，工单退回排队等待接续，进度保留 ${Math.round(o.progress)}%`, staffId)
  }
  return rows.length
}

// 撤销排队中的工单（尚未接单）：恢复运营并重新开放可售时段
// 撤销 + 恢复运营 + 重开时段同一事务提交，联动失败整体回滚
export function cancelMaintenanceOrder(id) {
  try {
    return tx(() => {
      const o = db.prepare('SELECT * FROM maintenance_orders WHERE id=?').get(id)
      if (!o) return { ok: false, msg: '工单不存在' }
      if (o.status !== 'queued') return { ok: false, msg: '已接单的工单不可撤销，可转派给其他维修工' }
      const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(o.ride_id)
      db.prepare("UPDATE maintenance_orders SET status='cancelled', completed_tick=?, completed_day=? WHERE id=?")
        .run(ctx.tick(), ctx.day(), id)
      logOrder(id, 'cancel', '运营撤销检修工单，设施恢复运营')
      if (ride) {
        db.prepare("UPDATE rides SET status='operating' WHERE id=?").run(ride.id)
        const sync = ctx.syncRideSlots?.({ ...ride, status: 'operating' })
        if (sync && !sync.ok) throw new Error(`恢复运营联动失败：${sync.msg || sync.code || '未知错误'}`)
      }
      return { ok: true }
    })
  } catch (e) {
    console.error('[maintenance] 撤销工单失败，已整体回滚:', e)
    return { ok: false, msg: '撤销失败，本次操作未生效，请稍后重试' }
  }
}

// 设施拆除：在途工单直接作废
export function cancelOrdersByRide(rideId) {
  db.prepare(`UPDATE maintenance_orders SET status='cancelled', completed_tick=?, completed_day=?
              WHERE ride_id=? AND status IN ('queued','processing')`).run(ctx.tick(), ctx.day(), rideId)
}

// ---------------- 完工 ----------------
// 完工结算 + 恢复运营 + 重开时段 + 费用入账 + 投诉联动在同一事务提交，任一步失败整体回滚
function completeOrder(o) {
  return tx(() => {
    const ride = db.prepare('SELECT * FROM rides WHERE id=?').get(o.ride_id)
    const st = o.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(o.assignee_id) : null

    db.prepare("UPDATE maintenance_orders SET status='done', progress=100, completed_tick=?, completed_day=? WHERE id=?")
      .run(ctx.tick(), ctx.day(), o.id)
    // 完工恢复：健康度修复至 100，设施恢复运营，可售时段重新开放
    if (ride) {
      db.prepare("UPDATE rides SET status='operating', health=100, queue=0 WHERE id=?").run(ride.id)
      const sync = ctx.syncRideSlots?.({ ...ride, status: 'operating' })
      if (sync && !sync.ok) throw new Error(`恢复运营联动失败：${sync.msg || sync.code || '未知错误'}`)
    }
    // 检修费用完工结算入账
    setSetting('cash', Math.round(ctx.cash() - o.cost))
    ctx.logFinance?.(ctx.day(), '维护', -o.cost, `检修完工 ${o.code} · ${ride?.name || `设施#${o.ride_id}`}`)
    // 员工修好设施，满意度提升
    if (st) {
      db.prepare('UPDATE staff SET morale=? WHERE id=?').run(Math.min(100, st.morale + 3), st.id)
    }
    logOrder(o.id, 'complete',
      `${st ? st.name + ' 完成' : '完成'}检修并恢复运营，费用 ¥${o.cost.toLocaleString()} 已入账`, st?.id ?? null)
    // 完工回写排班工时模块：当值维修工本班满意度 +3（结算时落士气与工资）
    if (st) ctx.onWorkComplete?.(st.id, 'maintenance', { code: o.code })
    // 事件中心留痕（正向小事件）
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(ctx.tick(), ctx.day(), 'maintenance', '设施检修完工',
        `「${ride?.name || `设施#${o.ride_id}`}」检修完成，健康度恢复至 100，已重新对外开放预约时段；检修费用 ¥${o.cost.toLocaleString()}。`, 1, 'active')
    // 联动投诉：针对该设施的设施故障投诉可由维修工在现场一并处置
    ctx.linkComplaintsToRide?.(o.ride_id, st?.id ?? null)
  })
}

// 每游戏小时推进：在修工单累计进度；维修工离岗则退回排队；进度满自动完工
// 逐单容错：一单推进/完工失败跳过本单（已回滚），不中断整批与游戏主循环
export function processMaintenance() {
  const rows = db.prepare("SELECT * FROM maintenance_orders WHERE status='processing'").all()
  for (const o of rows) {
    try {
      const st = o.assignee_id ? db.prepare('SELECT * FROM staff WHERE id=?').get(o.assignee_id) : null
      if (!st || !st.active) {
        // 离岗接续：进度保留，工单重新排队
        db.prepare("UPDATE maintenance_orders SET status='queued', assignee_id=NULL WHERE id=?").run(o.id)
        logOrder(o.id, 'release', '受理维修工离岗，工单退回排队等待接续，进度保留')
        continue
      }
      // 排班在岗校验：有排班但当前不在班（如已排晚班尚未到点）→ 工单挂起不推进，到班后自动继续
      const duty = ctx.staffDutyState?.(st.id)
      if (duty && !duty.onDuty) continue
      const progress = o.progress + repairRate(st)
      if (progress >= 100) completeOrder(o)
      else db.prepare('UPDATE maintenance_orders SET progress=? WHERE id=?').run(Math.round(progress * 10) / 10, o.id)
    } catch (e) {
      console.error(`[maintenance] 工单 #${o.id} 推进失败（已回滚跳过，不影响其他工单）:`, e)
    }
  }
}

// ---------------- 兼容既有检修状态 ----------------
// 启动/升级时对已处于 maintenance 且无在途工单的设施补建排队工单（不重复触发停运退改）
export function backfillMaintenanceOrders() {
  const rows = db.prepare(`SELECT r.* FROM rides r
                           WHERE r.status='maintenance'
                           AND NOT EXISTS (SELECT 1 FROM maintenance_orders mo WHERE mo.ride_id=r.id AND mo.status IN ('queued','processing'))`).all()
  for (const ride of rows) {
    const cost = repairCostFor(ride.health)
    const r = db.prepare(`INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day,note)
                          VALUES(?,?,'queued','system',?,?,?,?, '既有检修状态设施，系统补建工单')`)
      .run('', ride.id, ride.health, cost, ctx.tick(), ctx.day())
    const id = Number(r.lastInsertRowid)
    db.prepare('UPDATE maintenance_orders SET code=? WHERE id=?').run('WX' + String(id).padStart(4, '0'), id)
    logOrder(id, 'create', '兼容既有检修状态，补建检修工单')
  }
  return rows.length
}

// ---------------- 查询 ----------------
function etaText(o, staff) {
  if (o.status !== 'processing' || !staff) return ''
  const remain = Math.max(0, 100 - o.progress)
  return Math.ceil(remain / repairRate(staff))
}

export function listMaintenanceOrders({ status = null, limit = 200 } = {}) {
  const rides = db.prepare('SELECT id,name,status,health FROM rides').all()
  const rows0 = status
    ? db.prepare('SELECT * FROM maintenance_orders WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM maintenance_orders ORDER BY id DESC LIMIT ?').all(limit)
  return rows0.map(o => {
    const st = o.assignee_id ? db.prepare('SELECT id,name,role,skill,morale,active FROM staff WHERE id=?').get(o.assignee_id) : null
    const ride = rides.find(r => r.id === o.ride_id)
    return {
      ...o,
      ride_name: ride?.name || `设施#${o.ride_id}`,
      ride_status: ride?.status || '',
      assignee_name: st?.name || '',
      assignee_active: st ? !!st.active : false,
      eta_hours: etaText(o, st)
    }
  })
}

export function maintenanceOrderDetail(id) {
  const o = db.prepare('SELECT * FROM maintenance_orders WHERE id=?').get(id)
  if (!o) return null
  const [full] = listMaintenanceOrders({ limit: 10000 }).filter(x => x.id === o.id)
  const logs = db.prepare('SELECT * FROM maintenance_logs WHERE order_id=? ORDER BY id').all(id)
  return { order: full, logs }
}

// 维修工当前手头工单（供员工页展示负载）
export function staffLoad() {
  const map = new Map()
  for (const o of db.prepare("SELECT assignee_id, COUNT(*) n FROM maintenance_orders WHERE status='processing' AND assignee_id IS NOT NULL GROUP BY assignee_id").all()) {
    map.set(o.assignee_id, o.n)
  }
  return map
}

export function maintenanceStats() {
  const queued = db.prepare("SELECT COUNT(*) n FROM maintenance_orders WHERE status='queued'").get().n
  const processing = db.prepare("SELECT COUNT(*) n FROM maintenance_orders WHERE status='processing'").get().n
  const todayDone = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(cost),0) c FROM maintenance_orders WHERE status=? AND completed_day=?')
    .get('done', ctx.day())
  return { queued, processing, open: queued + processing, doneToday: todayDone.n, costToday: todayDone.c }
}
