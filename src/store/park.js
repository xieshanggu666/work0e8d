import { defineStore } from 'pinia'

const BASE = '/api'

// 生成幂等请求号：同一意图的双击/重试携带同一 requestId，服务端只执行一次
export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  try {
    const r = await fetch(BASE + path, opt)
    const data = await r.json().catch(() => null)
    if (!data) return { ok: false, code: 'BAD_RESPONSE', msg: `服务响应异常（HTTP ${r.status}），请稍后重试` }
    return data
  } catch (e) {
    // 网络中断/超时：请求可能未送达或已送达，提示用户勿盲目重复提交（携带幂等键的操作可安全重试）
    return { ok: false, code: 'NETWORK', msg: '网络异常，请求未送达，请检查连接后重试' }
  }
}

function emptyReservationStats() {
  return {
    todayCap: 0, todayBooked: 0, todayChecked: 0, todayRefunded: 0, todayFill: 0,
    pendingOrders: 0, pendingQty: 0, noshowToday: 0, refundOrdersToday: 0, refundAmountToday: 0,
    soldAheadQty: 0, soldAheadAmount: 0, oversoldPending: 0, calendar: []
  }
}

function emptyMemberStats() {
  return {
    total: 0, silver: 0, gold: 0, diamond: 0, activeCards: 0, frozen: 0, expiring: 0,
    pointsOutstanding: 0, balanceLiability: 0, cardRevToday: 0, topupToday: 0,
    vendorToday: 0, redeemToday: 0, memberOrdersToday: 0
  }
}

function emptySchedulingStats() {
  return {
    day: 1, todayScheduled: 0, onDuty: 0, absentToday: 0, lateToday: 0,
    overtimeHoursToday: 0, settledToday: 0, payToday: 0, pendingRequests: 0,
    coverageWarnings: 0, coverageBlocks: 0,
    dispatchOtRequests: 0, dispatchFilledToday: 0, nightOnDuty: 0, flowToday: 0
  }
}

function emptyGroupStats() {
  return {
    pending: 0, pendingQty: 0, activeToday: 0, activeQtyToday: 0, interrupted: 0,
    depositToday: 0, balanceToday: 0, refundToday: 0, checkedToday: 0
  }
}

export const useParkStore = defineStore('park', {
  state: () => ({
    data: null,
    loaded: false,
    speed: 1,
    lastTick: 0
  }),
  getters: {
    clock: s => s.data?.clock || { day: 1, hour: 9 },
    ticket: s => s.data?.ticket ?? 0,
    zones: s => s.data?.zones || [],
    rides: s => s.data?.rides || [],
    vendors: s => s.data?.vendors || [],
    staff: s => s.data?.staff || [],
    events: s => s.data?.events || [],
    finance: s => s.data?.finance || [],
    visitors: s => s.data?.visitors || [],
    loans: s => s.data?.loans || [],
    debt: s => s.data?.debt || { remainPrincipal: 0, arrears: 0, overdueCount: 0 },
    complaints: s => s.data?.complaints || [],
    complaintStats: s => s.data?.complaintStats || { open: 0, overdue: 0, todayClosed: 0, resolved: 0, total: 0, avgRating: 0, compTotal: 0 },
    maintenanceOrders: s => s.data?.maintenanceOrders || [],
    maintenanceStats: s => s.data?.maintenanceStats || { queued: 0, processing: 0, open: 0, doneToday: 0, costToday: 0 },
    openMaintenanceOrders: s => (s.data?.maintenanceOrders || []).filter(o => ['queued', 'processing'].includes(o.status)),
    wordOfMouth: s => s.data?.wordOfMouth ?? 0,
    entrySlots: s => s.data?.entrySlots || [],
    reservations: s => s.data?.reservations || [],
    reservationStats: s => s.data?.reservationStats || emptyReservationStats(),
    openComplaints: s => (s.data?.complaints || []).filter(c => ['open', 'processing', 'ready'].includes(c.status)),
    activeEvents: s => (s.data?.events || []).filter(e => e.status === 'active'),
    // 会员与权益
    members: s => s.data?.members || [],
    memberStats: s => s.data?.memberStats || emptyMemberStats(),
    memberConfig: s => s.data?.memberConfig || { enabled: true, pointRate: 1, pointsComp: 300, voucherFace: 30, benefitValidDays: 30 },
    cardProducts: s => s.data?.cardProducts || [],
    benefitProducts: s => s.data?.benefitProducts || [],
    memberSpecialists: s => (s.data?.staff || []).filter(x => x.role === '会员专员'),
    // 员工排班与工时结算
    shifts: s => s.data?.shifts || [],
    schedules: s => s.data?.schedules || [],
    attendance: s => s.data?.attendance || [],
    shiftRequests: s => s.data?.shiftRequests || [],
    schedulingStats: s => s.data?.schedulingStats || emptySchedulingStats(),
    coverageToday: s => s.data?.coverageToday || { warnings: [], rosterCount: 0 },
    dispatchPlanData: s => s.data?.dispatchPlan || { days: [], params: {}, mode: 'dynamic' },
    supervisors: s => (s.data?.staff || []).filter(x => x.role === '运营主管'),
    // 领队组团
    groups: s => s.data?.groups || [],
    groupStats: s => s.data?.groupStats || emptyGroupStats(),
    groupConfig: s => s.data?.groupConfig || { enabled: 1, depositRate: 0.3, minQty: 5, maxQty: 120, days: 3, entryHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18], rideHours: [9, 10, 11, 12, 13, 14, 15, 16, 17] }
  },
  actions: {
    async refresh() {
      this.data = await j('GET', '/state')
      this.loaded = true
      if (this.data) this.lastTick = this.data.clock.tick
    },
    async api(method, path, body) {
      const r = await j(method, path, body)
      await this.refresh()
      return r
    },
    buildRide(payload) { return this.api('POST', '/rides', payload) },
    updateRide(id, payload) { return this.api('POST', `/rides/${id}`, payload) },
    delRide(id) { return this.api('DELETE', `/rides/${id}`) },
    buildVendor(payload) { return this.api('POST', '/vendors', payload) },
    updateVendor(id, payload) { return this.api('POST', `/vendors/${id}`, payload) },
    delVendor(id) { return this.api('DELETE', `/vendors/${id}`) },
    hire(payload) { return this.api('POST', '/staff', payload) },
    updateStaff(id, payload) { return this.api('POST', `/staff/${id}`, payload) },
    unlock(zoneId) { return this.api('POST', `/zones/${zoneId}/unlock`, {}) },
    updateZone(zoneId, payload) { return this.api('POST', `/zones/${zoneId}`, payload) },
    setTicket(price) { return this.api('POST', '/ticket', { price }) },
    takeLoan(amount, periods, ratePct) { return this.api('POST', '/loan', { amount, periods, ratePct }) },
    repayLoan(id) { return this.api('POST', `/loans/${id}/repay`, {}) },
    planEvent(payload) { return this.api('POST', '/events', payload) },
    resolveEvent(id) { return this.api('POST', `/events/${id}/resolve`, {}) },
    fileComplaint(payload) { return this.api('POST', '/complaints', payload) },
    assignComplaint(id, staff_id) { return this.api('POST', `/complaints/${id}/assign`, { staff_id }) },
    escalateComplaint(id) { return this.api('POST', `/complaints/${id}/escalate`, {}) },
    resolveComplaint(id, compensation) { return this.api('POST', `/complaints/${id}/resolve`, { compensation }) },
    closeComplaint(id) { return this.api('POST', `/complaints/${id}/close`, {}) },
    async complaintDetail(id) { return j('GET', `/complaints/${id}`) },
    // 分时预约（写操作携带 request_id 幂等键，重放返回首次结果不产生重复副作用）
    bookReservation(payload) { return this.api('POST', '/reservations', payload) },
    rescheduleReservation(id, slot_id, request_id) { return this.api('POST', `/reservations/${id}/reschedule`, { slot_id, request_id }) },
    cancelReservation(id, request_id) { return this.api('POST', `/reservations/${id}/cancel`, { request_id }) },
    checkinReservation(id, request_id) { return this.api('POST', `/reservations/${id}/checkin`, { request_id }) },
    updateSlot(id, payload) { return this.api('POST', `/reservation-slots/${id}`, payload) },
    async rideSlots(rideId, day) { return j('GET', `/reservation-slots?scope=ride&rideId=${rideId}${day ? `&day=${day}` : ''}`) },
    async reservationDetail(id) { return j('GET', `/reservations/${id}`) },
    // 设施检修工单
    assignMaintenance(id, staff_id) { return this.api('POST', `/maintenance/${id}/assign`, { staff_id }) },
    cancelMaintenance(id) { return this.api('POST', `/maintenance/${id}/cancel`, {}) },
    async maintenanceDetail(id) { return j('GET', `/maintenance/${id}`) },
    // 游客会员与权益中心
    registerMember(payload) { return this.api('POST', '/members', payload) },
    applyCard(id, tier, payload) { return this.api('POST', `/members/${id}/cards/${tier}`, payload) },
    memberTopup(id, amount, request_id) { return this.api('POST', `/members/${id}/topup`, { amount, request_id }) },
    redeemBenefit(id, code, request_id) { return this.api('POST', `/members/${id}/redeem/${code}`, { request_id }) },
    buyMemberTicket(id, qty, request_id) { return this.api('POST', `/members/${id}/tickets`, { qty, request_id }) },
    memberVendorSpend(id, vendorId, payload) { return this.api('POST', `/members/${id}/vendors/${vendorId}/spend`, payload) },
    freezeMember(id, frozen, reason) { return this.api('POST', `/members/${id}/freeze`, { frozen, reason }) },
    adjustMemberPoints(id, change, note) { return this.api('POST', `/members/${id}/points`, { change, note }) },
    setMemberOwner(id, staff_id) { return this.api('POST', `/members/${id}/owner`, { staff_id }) },
    saveMemberConfig(payload) { return this.api('POST', '/member-config', payload) },
    updateCardProduct(tier, payload) { return this.api('POST', `/card-products/${tier}`, payload) },
    async memberDetail(id) { return j('GET', `/members/${id}`) },
    async memberQuote(id, payload) { return j('POST', `/members/${id}/quote`, payload) },
    // 员工排班与工时结算
    scheduleShift(payload) { return this.api('POST', '/schedules', payload) },
    cancelSchedule(id, request_id) { return this.api('POST', `/schedules/${id}/cancel`, { request_id }) },
    checkinSchedule(id, request_id) { return this.api('POST', `/schedules/${id}/checkin`, { request_id }) },
    leaveAttendance(id, reason, request_id) { return this.api('POST', `/attendance/${id}/leave`, { reason, request_id }) },
    requestSwap(id, payload) { return this.api('POST', `/schedules/${id}/swap`, payload) },
    requestOvertime(id, payload) { return this.api('POST', `/schedules/${id}/overtime`, payload) },
    approveShiftRequest(id, approver_id) { return this.api('POST', `/shift-requests/${id}/approve`, { approver_id }) },
    rejectShiftRequest(id, approver_id, note) { return this.api('POST', `/shift-requests/${id}/reject`, { approver_id, note }) },
    cancelShiftRequest(id, staff_id) { return this.api('POST', `/shift-requests/${id}/cancel`, { staff_id }) },
    saveScheduleConfig(payload) { return this.api('POST', '/schedule-config', payload) },
    runDispatch(payload) { return this.api('POST', '/dispatch/run', payload || {}) },
    async coverageOf(day) { return j('GET', `/coverage/${day}`) },
    async dispatchPlanFetch() { return j('GET', '/dispatch-plan') },
    async scheduleLogs(payload) {
      const q = new URLSearchParams(Object.entries(payload).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, v])).toString()
      return j('GET', `/schedules/logs?${q}`)
    },
    // 领队组团
    submitGroup(payload) { return this.api('POST', '/groups', payload) },
    confirmGroup(id, request_id) { return this.api('POST', `/groups/${id}/confirm`, { request_id }) },
    rejectGroup(id, payload) { return this.api('POST', `/groups/${id}/reject`, payload) },
    cancelGroup(id, request_id) { return this.api('POST', `/groups/${id}/cancel`, { request_id }) },
    payGroupBalance(id, amount, request_id) { return this.api('POST', `/groups/${id}/balance`, { amount, request_id }) },
    checkinGroupItem(id, qty, request_id) { return this.api('POST', `/group-items/${id}/checkin`, { qty, request_id }) },
    refundGroupLeg(id, qty, request_id) { return this.api('POST', `/group-items/${id}/refund`, { qty, request_id }) },
    rerouteGroupItem(id, slot_id, request_id) { return this.api('POST', `/group-items/${id}/reroute`, { slot_id, request_id }) },
    refundOutageItem(id, request_id) { return this.api('POST', `/group-items/${id}/refund-outage`, { request_id }) },
    saveGroupConfig(payload) { return this.api('POST', '/group-config', payload) },
    async groupDetail(id) { return j('GET', `/groups/${id}`) }
  }
})