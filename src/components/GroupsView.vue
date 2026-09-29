<script setup>
import { ref, computed, watch } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()
const today = computed(() => store.clock.day)

function errText(r, fallback = '操作失败，请稍后重试') {
  if (r?.ok) return ''
  const msg = r?.msg || fallback
  const tag = r?.code ? `〔${r.code}${r.reqId ? ' · ' + r.reqId : ''}〕` : ''
  return msg + tag
}

// 浏览器原生确认（轻交互）
function confirm2(msg) { return window.confirm(msg) }

const tabs = [
  { k: 'leader', label: '领队报团' },
  { k: 'orders', label: '团队行程' },
  { k: 'config', label: '订金配置' }
]
const tab = ref('leader')
const stats = computed(() => store.groupStats)

// ============ 页签一：领队提交入园 + 多设施行程 ============
const cfg = computed(() => store.groupConfig)
const form = ref({
  leader_name: '',
  leader_phone: '',
  qty: 15,
  dayOffset: 1
})
const entryHour = ref(10)
const rideLines = ref([])   // [{ ride_id, hour }]
const submitMsg = ref(null)
const submitting = ref(false)
const submitReqId = ref(newRequestId())

const visitDay = computed(() => today.value + num(form.value.dayOffset))
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d }

const operatingRides = computed(() => store.rides.filter(r => r.status === 'operating'))
const availableRides = computed(() => operatingRides.value.filter(r =>
  !rideLines.value.some(l => l.ride_id === r.id)))
const rideHoursFor = h => cfg.value.rideHours.filter(x => x > h)

const pricePreview = computed(() => {
  const entry = +store.ticket
  const rides = rideLines.value.reduce((s, l) => {
    const r = store.rides.find(x => x.id === l.ride_id)
    return s + (r?.price || 0)
  }, 0)
  const unit = entry + rides
  const total = unit * num(form.value.qty)
  return { unit, total, deposit: Math.round(total * cfg.value.depositRate) }
})

function addRideLine() {
  const r = availableRides.value[0]
  if (!r) return
  const h = rideHoursFor(entryHour.value)[0]
  rideLines.value.push({ ride_id: r.id, hour: h })
  bumpReq()
}
function removeRideLine(i) { rideLines.value.splice(i, 1); bumpReq() }
function bumpReq() { submitReqId.value = newRequestId() }
watch([entryHour, form, rideLines], bumpReq, { deep: true })

function onEntryHour() {
  // 设施时段必须晚于入园；不合法的自动修正
  rideLines.value.forEach(l => { if (l.hour <= entryHour.value) l.hour = rideHoursFor(entryHour.value)[0] || entryHour.value + 1 })
}

async function submit() {
  submitMsg.value = null
  if (submitting.value) return
  if (!form.value.leader_name.trim()) { submitMsg.value = { ok: false, text: '请填写领队姓名' }; return }
  const q = Math.round(num(form.value.qty))
  if (q < cfg.value.minQty || q > cfg.value.maxQty) {
    submitMsg.value = { ok: false, text: `团队人数需为 ${cfg.value.minQty}~${cfg.value.maxQty} 人` }; return
  }
  const itinerary = [{ kind: 'entry', day: visitDay.value, hour: entryHour.value }]
  for (const l of rideLines.value) {
    if (!l.ride_id || !l.hour) { submitMsg.value = { ok: false, text: '请完善设施行程（设施与时段）' }; return }
    if (l.hour <= entryHour.value) { submitMsg.value = { ok: false, text: '设施游玩时段必须晚于入园时段' }; return }
    itinerary.push({ kind: 'ride', ride_id: l.ride_id, day: visitDay.value, hour: l.hour })
  }
  submitting.value = true
  try {
    const r = await store.submitGroup({
      leader_name: form.value.leader_name,
      leader_phone: form.value.leader_phone,
      qty, itinerary, request_id: submitReqId.value
    })
    if (r?.ok) {
      submitMsg.value = { ok: true, text: `提交成功！团号 ${r.code}，待运营确认后统一锁定名额并收取订金 ¥${r.deposit.toLocaleString()}` }
      form.value.leader_name = ''
      form.value.leader_phone = ''
      rideLines.value = []
      bumpReq()
    } else {
      submitMsg.value = { ok: false, text: errText(r, '行程提交失败') }
    }
  } finally {
    submitting.value = false
  }
}

// ============ 页签二：团队行程管理 ============
const filter = ref('active')
const filters = [
  { k: 'active', label: '进行中' },
  { k: 'pending', label: '待确认' },
  { k: 'interrupted', label: '停运待处置' },
  { k: 'all', label: '全部' },
  { k: 'closed', label: '已结案' }
]
const ACTIVE_ST = ['confirmed', 'settled']
const CLOSED_ST = ['completed', 'cancelled', 'rejected', 'closed_noshow']
const filteredGroups = computed(() => {
  if (filter.value === 'all') return store.groups
  if (filter.value === 'active') return store.groups.filter(g => ACTIVE_ST.includes(g.status))
  if (filter.value === 'pending') return store.groups.filter(g => g.status === 'pending')
  if (filter.value === 'closed') return store.groups.filter(g => CLOSED_ST.includes(g.status))
  if (filter.value === 'interrupted') return store.groups.filter(g => g.interrupted_count > 0)
  return store.groups
})

const statusClass = st => ({
  pending: 'b-pending', confirmed: 'b-confirmed', settled: 'b-settled',
  completed: 'b-checked', cancelled: 'b-cancel', rejected: 'b-cancel', closed_noshow: 'b-noshow'
}[st] || 'b-cancel')
const itemClass = st => ({
  pending: 'i-pending', active: 'i-active', rerouted: 'i-reroute', interrupted: 'i-interrupt',
  refund_park: 'i-refund', refund_guest: 'i-refund', noshow: 'i-noshow', checked: 'i-checked'
}[st] || 'i-pending')

const busy = ref({})
const flashes = ref({})
function flash(id, ok, msg) { flashes.value[id] = { ok, msg }; setTimeout(() => delete flashes.value[id], 6000) }
const reqIds = ref({})
function rid(key) { if (!reqIds.value[key]) reqIds.value[key] = newRequestId(); return reqIds.value[key] }
function newRid(key) { reqIds.value[key] = newRequestId() }

async function withBusy(key, fn, id) {
  if (busy.value[key]) return
  busy.value[key] = true
  try {
    const r = await fn()
    if (r?.ok) { flash(id ?? key, true, r.msg || '操作成功'); newRid(key) }
    else flash(id ?? key, false, errText(r))
  } finally { busy.value[key] = false }
}

function confirm(g) {
  withBusy('confirm-' + g.id, () => store.confirmGroup(g.id, rid('confirm-' + g.id)), g.id)
}
function reject(g) {
  if (!confirm2('确认拒绝该团单？')) return
  withBusy('reject-' + g.id, () => store.rejectGroup(g.id, { reason: '名额无法安排', request_id: rid('reject-' + g.id) }), g.id)
}
function withdraw(g) {
  withBusy('cancel-' + g.id, () => store.cancelGroup(g.id, rid('cancel-' + g.id)), g.id)
}
const balanceInput = ref({})
function quickBalance(g, amount) {
  const amt = amount ?? Number(balanceInput.value[g.id])
  if (!amt || amt <= 0) { flash(g.id, false, '请填写收款金额'); return }
  withBusy('bal-' + g.id, () => store.payGroupBalance(g.id, amt, rid('bal-' + g.id)), g.id)
}
function checkinItem(g, item, qty) {
  withBusy('ci-' + item.id, () => store.checkinGroupItem(item.id, qty, rid('ci-' + item.id)), g.id)
}
const ciInput = ref({})
function customCheckin(g, item) {
  const q = Math.round(Number(ciInput.value[item.id] || 0))
  if (!q) { flash(g.id, false, '请填写本批核销人数'); return }
  checkinItem(g, item, q)
}
function refundLeg(g, item) {
  const remain = item.remain
  const late = g.visit_day === today.value
  const msg = late
    ? `当日退团将扣除已付部分 50% 手续费，确认 ${remain} 人退团？`
    : `确认 ${remain} 人提前退团？已付部分按比例原路退回。`
  if (!confirm2(msg)) return
  withBusy('rf-' + item.id, () => store.refundGroupLeg(item.id, remain, rid('rf-' + item.id)), g.id)
}
function outageRefund(g, item) {
  if (!confirm2('设施停运，确认对该行程按园方原因全额退回领队已付部分？')) return
  withBusy('or-' + item.id, () => store.refundOutageItem(item.id, rid('or-' + item.id)), g.id)
}

// 重排目标时段（停运行程：其他开放设施；入园：入园时段）
const rerouteOpen = ref({})
const rerouteTarget = ref({})
async function openReroute(g, item) {
  rerouteOpen.value[item.id] = !rerouteOpen.value[item.id]
  rerouteTarget.value[item.id] = 0
}
async function doReroute(g, item) {
  const slotId = Number(rerouteTarget.value[item.id])
  if (!slotId) { flash(g.id, false, '请选择重排目标时段'); return }
  withBusy('rr-' + item.id, () => store.rerouteGroupItem(item.id, slotId, rid('rr-' + item.id)), g.id)
}
// 重排候选：设施取各开放设施的 rideSlots（store 已有 rideSlots 辅助），入园取 entrySlots
function rerouteCandidates(item) {
  if (item.kind === 'entry') {
    return store.entrySlots
      .filter(s => s.status === 'open' && (s.day > item.slot_day || (s.day === item.slot_day && s.hour > item.slot_hour)) && s.remain >= item.remain)
      .slice(0, 10)
  }
  // 设施：当天更晚的其他开放设施时段
  const out = []
  for (const s of rideSlotsAll.value) {
    if (s.ride_id === item.ride_id) continue
    if (s.day !== item.slot_day || s.hour <= item.slot_hour) continue
    if (s.status !== 'open' || s.remain < item.remain) continue
    out.push(s)
  }
  return out.slice(0, 12)
}
const rideSlotsAll = ref([])
async function loadAllRideSlots() {
  const rides = operatingRides.value
  const entries = await Promise.all(rides.map(r => store.rideSlots(r.id)))
  rideSlotsAll.value = entries.flatMap(e => e.list || [])
}
watch(tab, async t => { if (t === 'orders') await loadAllRideSlots() })
watch(() => store.clock.tick, async () => {
  if (tab.value === 'orders' && (filter.value === 'active' || filter.value === 'interrupted')) await loadAllRideSlots()
})

// 详情时间线
const detail = ref(null)
async function openDetail(g) {
  const d = await store.groupDetail(g.id)
  if (d?.ok === false) { flash(g.id, false, d.msg || '详情加载失败'); return }
  detail.value = d
}
function closeDetail() { detail.value = null }

const PAY_LABEL = { deposit: '订金', balance: '尾款', refund_park: '园方退款', refund_guest: '退团退款', fee: '手续费没收', noshow: '爽约没收' }
const LOG_LABEL = {
  submit: '领队提交', confirm: '运营确认', reject: '运营拒绝', cancel: '领队撤回',
  balance: '尾款结算', checkin: '分批核销', refund: '退改退款', reroute: '行程重排',
  outage: '停运联动', noshow: '爽约', noshow_close: '爽约结案', complete: '行程结案'
}

// ============ 页签三：订金配置 ============
const depositRate = ref(0.3)
const groupEnabled = ref(1)
const cfgMsg = ref(null)
watch(cfg, c => { depositRate.value = c.depositRate; groupEnabled.value = c.enabled }, { immediate: true })
async function saveConfig() {
  cfgMsg.value = null
  const r = await store.saveGroupConfig({ deposit_rate: depositRate.value, enabled: groupEnabled.value })
  cfgMsg.value = r?.ok ? { ok: true, text: '配置已保存' } : { ok: false, text: errText(r) }
}
</script>

<template>
  <div class="grp">
    <!-- 顶部统计 -->
    <div class="stat-grid">
      <div class="card stat"><em>待确认团单</em><b>{{ stats.pending }}</b><span>{{ stats.pendingQty }} 人待安排</span></div>
      <div class="card stat" :class="{ alert: stats.activeToday }"><em>今日到园团队</em><b>{{ stats.activeToday }}</b><span>{{ stats.activeQtyToday }} 人</span></div>
      <div class="card stat"><em>今日团队入园核销</em><b>{{ stats.checkedToday }}</b><span>人（回写客流）</span></div>
      <div class="card stat" :class="{ alert: stats.interrupted }"><em>停运待处置行程</em><b>{{ stats.interrupted }}</b><span>可重排/退款</span></div>
      <div class="card stat"><em>今日订金 + 尾款</em><b>¥{{ (stats.depositToday + stats.balanceToday).toLocaleString() }}</b><span>退款 ¥{{ stats.refundToday.toLocaleString() }}</span></div>
    </div>

    <div class="card">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      </div>
    </div>

    <!-- ============ 领队报团 ============ -->
    <div v-if="tab === 'leader'" class="leader-grid">
      <div class="card form">
        <h3>🧑‍✈️ 团队行程报团单</h3>
        <label class="fld">领队姓名
          <input v-model="form.leader_name" maxlength="20" placeholder="请输入领队姓名" />
        </label>
        <label class="fld">联系电话（选填）
          <input v-model="form.leader_phone" maxlength="20" placeholder="手机号，便于到园联络" />
        </label>
        <div class="fld-row">
          <label class="fld">团队人数
            <div class="stepper">
              <button @click="form.qty = Math.max(cfg.minQty, +form.qty - 1)">−</button>
              <b>{{ form.qty }}</b>
              <button @click="form.qty = Math.min(cfg.maxQty, +form.qty + 1)">＋</button>
            </div>
          </label>
          <label class="fld">入园日期
            <select v-model.number="form.dayOffset">
              <option v-for="d in cfg.days" :key="d" :value="d - 1">{{ d === 1 ? '今天' : d === 2 ? '明天' : `第 ${today + d - 1} 天（${d - 1} 天后）` }}</option>
            </select>
          </label>
        </div>

        <label class="fld">🏞️ 入园时段（先入园，后游玩）
          <div class="hour-chips">
            <button v-for="h in cfg.entryHours" :key="h" class="hchip" :class="{ on: entryHour === h }" @click="entryHour = h; onEntryHour()">{{ h }}:00</button>
          </div>
        </label>

        <div class="fld">
          <div class="rides-head">
            <span>🎢 设施行程（{{ rideLines.length }}）</span>
            <button class="ghost sm" :disabled="!availableRides.length" @click="addRideLine">＋ 添加设施</button>
          </div>
          <div class="ride-line" v-for="(l, i) in rideLines" :key="i">
            <select v-model.number="l.ride_id">
              <option v-for="r in operatingRides" :key="r.id" :value="r.id" :disabled="rideLines.some((x, j) => j !== i && x.ride_id === r.id)">
                {{ r.name }} · ¥{{ r.price }}
              </option>
            </select>
            <select v-model.number="l.hour">
              <option v-for="h in rideHoursFor(entryHour)" :key="h" :value="h">{{ h }}:00</option>
            </select>
            <button class="ghost sm danger" @click="removeRideLine(i)">移除</button>
          </div>
          <div v-if="!rideLines.length" class="muted hint-empty">可暂不添加设施，仅报入园团；建议为热门设施提前锁定名额。</div>
        </div>

        <button class="primary wide" :disabled="submitting" @click="submit">
          {{ submitting ? '提交中…' : `提交行程 · 确认时支付订金 ¥${pricePreview.deposit.toLocaleString()}` }}
        </button>
        <em v-if="submitMsg" class="bookmsg" :class="{ err: !submitMsg.ok }">{{ submitMsg.text }}</em>
      </div>

      <div class="card quote-card">
        <h3>报价明细</h3>
        <div class="qline"><span>🏞️ 入园门票</span><b>¥{{ (+store.ticket).toLocaleString() }}/人</b></div>
        <div class="qline" v-for="(l, i) in rideLines" :key="i">
          <span>🎢 {{ store.rides.find(r => r.id === l.ride_id)?.name }} · {{ l.hour }}:00</span>
          <b>¥{{ store.rides.find(r => r.id === l.ride_id)?.price ?? 0 }}/人</b>
        </div>
        <div class="divider"></div>
        <div class="qline total"><span>单人合计 × {{ form.qty }} 人</span><b>¥{{ pricePreview.total.toLocaleString() }}</b></div>
        <div class="qline"><span>确认时收取订金（{{ Math.round(cfg.depositRate * 100) }}%）</span><b class="money">¥{{ pricePreview.deposit.toLocaleString() }}</b></div>
        <div class="qline"><span>到园前应付尾款</span><b>¥{{ Math.max(0, pricePreview.total - pricePreview.deposit).toLocaleString() }}</b></div>
        <p class="muted tips">运营确认后统一锁定入园与各设施时段名额；支持到园后<b>分批核销、分批收尾款、部分退团</b>；
          若设施临时停运，系统将自动重排其他时段/设施，无法安排的行程园方全额退款。</p>
      </div>
    </div>

    <!-- ============ 团队行程 ============ -->
    <div v-if="tab === 'orders'" class="orders">
      <div class="card filters">
        <div class="seg">
          <button v-for="f in filters" :key="f.k" :class="{ on: filter === f.k }" @click="filter = f.k">{{ f.label }}</button>
        </div>
      </div>

      <div class="gcard card" v-for="g in filteredGroups" :key="g.id">
        <div class="g-head">
          <div class="g-title">
            <b class="gcode">{{ g.code }}</b>
            <span class="badge" :class="statusClass(g.status)">{{ g.status_name }}</span>
            <span class="tag" v-if="g.source === 'auto'">模拟团</span>
            <span class="tag interrupt" v-if="g.interrupted_count">⚠️ {{ g.interrupted_count }} 程停运待处置</span>
          </div>
          <div class="g-meta">
            🧑‍✈️ {{ g.leader_name }} <template v-if="g.leader_phone">· {{ g.leader_phone }}</template>
            · 👥 {{ g.qty }} 人 · 📅 第{{ g.visit_day }}天 {{ g.entry_hour }}:00 入园
          </div>
        </div>

        <!-- 行程明细 -->
        <div class="items">
          <div class="irow" v-for="it in g.items" :key="it.id">
            <div class="i-main">
              <span class="ikind">{{ it.kind === 'entry' ? '🏞️ 入园' : '🎢 ' + it.ride_name }}</span>
              <span class="itime">第{{ it.slot_day }}天 {{ it.slot_hour }}:00</span>
              <span class="iprice">¥{{ it.unit_price }}/人</span>
              <span class="badge sm" :class="itemClass(it.status)">{{ it.status_name }}</span>
              <span class="iprog">
                核销 <b>{{ it.checked_qty }}</b>/{{ it.qty }}
                <em v-if="it.refunded_qty" class="refund-text">· 退 {{ it.refunded_qty }}</em>
              </span>
            </div>
            <div class="i-ops">
              <template v-if="['active', 'rerouted'].includes(it.status) && ACTIVE_ST.includes(g.status)">
                <button class="succ sm" :disabled="busy['ci-' + it.id]" @click="checkinItem(g, it, it.remain)">✅ 全到({{ it.remain }})</button>
                <input class="mini-in" type="number" min="1" :max="it.remain" v-model.number="ciInput[it.id]" placeholder="分批人数" />
                <button class="ghost sm" @click="customCheckin(g, it)">分批核销</button>
                <button class="danger sm" :disabled="busy['rf-' + it.id]" @click="refundLeg(g, it)">部分退团</button>
                <button class="ghost sm" @click="openReroute(g, it)">改期</button>
              </template>
              <template v-if="it.status === 'interrupted'">
                <button class="primary sm" @click="openReroute(g, it)">🔀 重排行程</button>
                <button class="danger sm" :disabled="busy['or-' + it.id]" @click="outageRefund(g, it)">园方退款</button>
              </template>
            </div>
            <!-- 重排候选 -->
            <div class="reroute-box" v-if="rerouteOpen[it.id]">
              <select v-model.number="rerouteTarget[it.id]">
                <option :value="0" disabled>选择{{ it.kind === 'entry' ? '入园' : '其他开放设施' }}目标时段…</option>
                <option v-for="s in rerouteCandidates(it)" :key="s.id" :value="s.id">
                  第{{ s.day }}天 {{ s.hour }}:00 · 余 {{ s.remain }}<template v-if="it.kind === 'ride'"> · {{ s.ride_name }}</template>
                </option>
              </select>
              <button class="primary sm" :disabled="!rerouteTarget[it.id] || busy['rr-' + it.id]" @click="doReroute(g, it)">确认重排（不加价）</button>
              <button class="ghost sm" @click="rerouteOpen[it.id] = false">取消</button>
            </div>
          </div>
        </div>

        <!-- 财务条 -->
        <div class="g-fin">
          <div class="fin-item"><em>应收</em><b>¥{{ g.receivable_amount.toLocaleString() }}</b></div>
          <div class="fin-item"><em>订金</em><b>¥{{ g.deposit_amount.toLocaleString() }}</b></div>
          <div class="fin-item"><em>已收尾款</em><b>¥{{ g.paid_balance.toLocaleString() }}</b></div>
          <div class="fin-item"><em>已退</em><b class="refund-text">¥{{ g.refunded_amount.toLocaleString() }}</b></div>
          <div class="fin-item" v-if="g.fee_amount"><em>没收/手续费</em><b>¥{{ g.fee_amount.toLocaleString() }}</b></div>
          <div class="fin-item due" v-if="g.balance_due > 0 && ACTIVE_ST.includes(g.status)">
            <em>待收尾款</em><b class="money">¥{{ g.balance_due.toLocaleString() }}</b>
          </div>
        </div>

        <!-- 操作条 -->
        <div class="g-actions">
          <template v-if="g.status === 'pending'">
            <button class="succ" :disabled="busy['confirm-' + g.id]" @click="confirm(g)">✔ 确认并锁定名额·收订金</button>
            <button class="danger" :disabled="busy['reject-' + g.id]" @click="reject(g)">拒绝</button>
            <button class="ghost" :disabled="busy['cancel-' + g.id]" @click="withdraw(g)">领队撤回</button>
          </template>
          <template v-if="ACTIVE_ST.includes(g.status)">
            <template v-if="g.balance_due > 0">
              <input class="mini-in balance-in" type="number" min="1" :max="g.balance_due" v-model.number="balanceInput[g.id]" placeholder="本次收款金额" />
              <button class="primary" :disabled="busy['bal-' + g.id]" @click="quickBalance(g)">收取尾款</button>
              <button class="ghost" @click="quickBalance(g, g.balance_due)">一键结清 ¥{{ g.balance_due.toLocaleString() }}</button>
            </template>
            <span class="settled-tag" v-else>✅ 团款已结清，可放行核销</span>
          </template>
          <button class="ghost" @click="openDetail(g)">时间线/账务</button>
        </div>
        <em v-if="flashes[g.id]" class="flash" :class="{ ok: flashes[g.id].ok, err: !flashes[g.id].ok }">{{ flashes[g.id].msg }}</em>
      </div>

      <div class="muted empty card" v-if="!filteredGroups.length">当前没有符合条件的团单。</div>
    </div>

    <!-- ============ 订金配置 ============ -->
    <div v-if="tab === 'config'" class="card cfg">
      <h3>团队运营配置</h3>
      <label class="fld">模块开关
        <div class="seg narrow">
          <button :class="{ on: groupEnabled === 1 }" @click="groupEnabled = 1">开放领队报团</button>
          <button :class="{ on: groupEnabled === 0 }" @click="groupEnabled = 0">暂停</button>
        </div>
      </label>
      <label class="fld">订金比例（运营确认锁名额时收取）：<b class="money">{{ Math.round(depositRate * 100) }}%</b>
        <input type="range" min="0" max="100" step="5" :value="depositRate * 100"
               @input="depositRate = +$event.target.value / 100" />
      </label>
      <div class="muted">收齐订金后统一锁定入园与各设施时段名额；到园后可分批核销、分批收尾款。当日领队退团扣已付部分 50% 手续费，园方停运原因全额退回。</div>
      <button class="primary" @click="saveConfig">保存配置</button>
      <em v-if="cfgMsg" class="bookmsg" :class="{ err: !cfgMsg.ok }">{{ cfgMsg.text }}</em>
    </div>

    <!-- 团单详情时间线 -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <h3>🧑‍✈️ 团单 {{ detail.group.code }}
          <span class="badge" :class="statusClass(detail.group.status)">{{ detail.group.status_name }}</span>
          <button class="ghost x" @click="closeDetail">✕</button>
        </h3>
        <p class="d-meta muted">
          领队 {{ detail.group.leader_name }} · {{ detail.group.qty }} 人 ·
          第{{ detail.group.visit_day }}天 {{ detail.group.entry_hour }}:00 入园
        </p>
        <h4>资金流水</h4>
        <div class="pays">
          <div class="pay" v-for="p in detail.payments" :key="p.id">
            <span>{{ PAY_LABEL[p.kind] || p.kind }}</span>
            <em class="muted">第{{ p.day }}天</em>
            <b :class="p.amount < 0 ? 'refund-text' : ''">{{ p.amount < 0 ? '−' : '' }}¥{{ Math.abs(p.amount).toLocaleString() }}</b>
            <em class="muted pnote">{{ p.note }}</em>
          </div>
          <div v-if="!detail.payments.length" class="muted">暂无资金流水。</div>
        </div>
        <h4>核销批次</h4>
        <div class="pays">
          <div class="pay" v-for="c in detail.checkins" :key="c.id">
            <span>{{ c.source === 'auto' ? '🤖 自动' : '✅ 人工' }} · {{ c.qty }} 人</span>
            <em class="muted">第{{ c.day }}天 {{ c.hour }}:00</em>
            <em class="muted pnote">{{ c.note }}</em>
          </div>
          <div v-if="!detail.checkins.length" class="muted">尚无核销记录。</div>
        </div>
        <h4>生命周期时间线</h4>
        <div class="logs">
          <div v-for="l in detail.logs" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ LOG_LABEL[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grp { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat b { font-size: 22px; }
.stat span { font-size: 12px; color: var(--muted); }
.stat.alert { border-color: rgba(255,107,107,.55); }

.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 18px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }

/* 报团表单 */
.leader-grid { display: grid; grid-template-columns: 1.2fr .8fr; gap: 14px; align-items: start; }
@media (max-width: 1000px) { .leader-grid { grid-template-columns: 1fr; } }
.fld { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
.fld-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.stepper { display: flex; align-items: center; gap: 12px; }
.stepper button { width: 36px; padding: 6px 0; }
.stepper b { font-size: 18px; min-width: 30px; text-align: center; color: var(--text); }
.hour-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.hchip { padding: 5px 11px; font-size: 12px; border-radius: 16px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.hchip.on { background: rgba(255,107,107,.18); border-color: var(--accent); color: var(--accent); }
.rides-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.ride-line { display: grid; grid-template-columns: 1fr 120px auto; gap: 8px; margin-bottom: 8px; }
.hint-empty { font-size: 12px; padding: 8px 2px; }
.wide { width: 100%; padding: 11px; }
.sm { padding: 5px 10px; font-size: 12px; }
.bookmsg { display: block; margin-top: 10px; font-size: 12.5px; color: var(--green); font-style: normal; }
.bookmsg.err { color: var(--red); }

/* 报价卡 */
.quote-card h3 { margin-bottom: 12px; }
.qline { display: flex; justify-content: space-between; font-size: 13px; padding: 5px 0; color: var(--muted); }
.qline b { color: var(--text); font-weight: 600; }
.qline.total b { font-size: 16px; }
.divider { height: 1px; background: var(--border); margin: 8px 0; }
.tips { font-size: 12px; line-height: 1.8; margin-top: 10px; }

/* 团单列表 */
.filters .seg { margin-bottom: 0; flex-wrap: wrap; }
.seg.narrow { max-width: 320px; }
.gcard { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
.g-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.g-title { display: flex; align-items: center; gap: 8px; }
.gcode { font-size: 15px; }
.g-meta { font-size: 12.5px; color: var(--muted); }
.tag { font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
.tag.interrupt { color: var(--red); border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.12); }
.items { display: flex; flex-direction: column; gap: 6px; }
.irow { border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; display: flex; flex-direction: column; gap: 8px; background: var(--panel2); }
.i-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; }
.ikind { min-width: 110px; font-weight: 600; }
.itime, .iprice { color: var(--muted); font-size: 12px; }
.iprog { margin-left: auto; font-size: 12px; color: var(--muted); }
.iprog b { color: var(--text); }
.refund-text { color: var(--red) !important; }
.i-ops { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mini-in { width: 100px; padding: 5px 8px; }
.balance-in { width: 150px; }
.reroute-box { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.reroute-box select { flex: 1; min-width: 240px; max-width: 460px; }

.g-fin { display: flex; gap: 18px; flex-wrap: wrap; padding: 8px 12px; background: var(--panel); border-radius: 8px; }
.fin-item { display: flex; flex-direction: column; font-size: 12px; }
.fin-item em { font-style: normal; color: var(--muted); }
.fin-item b { font-size: 14px; }
.fin-item.due b { color: var(--accent2); }
.g-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.settled-tag { font-size: 13px; color: var(--green); }
.flash { font-style: normal; font-size: 12.5px; }
.flash.ok { color: var(--green); }
.flash.err { color: var(--red); }
.empty { padding: 22px; text-align: center; }

/* 状态徽标 */
.badge { font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel); color: var(--muted); }
.badge.sm { font-size: 10px; padding: 1px 7px; }
.b-pending { color: var(--accent2) !important; border-color: rgba(255,209,102,.5) !important; }
.b-confirmed { color: #f59e0b !important; border-color: rgba(245,158,11,.5) !important; }
.b-settled { color: var(--blue) !important; border-color: rgba(102,166,255,.5) !important; }
.b-checked { color: var(--green) !important; border-color: rgba(109,213,160,.5) !important; }
.b-noshow { color: #fff !important; background: var(--red) !important; border-color: var(--red) !important; }
.b-cancel { color: var(--muted) !important; }
.i-pending { color: var(--muted) !important; }
.i-active { color: var(--accent2) !important; border-color: rgba(255,209,102,.5) !important; }
.i-reroute { color: var(--blue) !important; border-color: rgba(102,166,255,.5) !important; }
.i-interrupt { color: #fff !important; background: var(--red) !important; border-color: var(--red) !important; }
.i-refund { color: var(--blue) !important; border-color: rgba(102,166,255,.4) !important; }
.i-noshow { color: var(--red) !important; border-color: rgba(255,107,107,.5) !important; }
.i-checked { color: var(--green) !important; border-color: rgba(109,213,160,.5) !important; }

/* 配置 */
.cfg { max-width: 560px; }
.cfg .fld { margin: 14px 0; }
.cfg input[type=range] { width: 100%; }

/* 详情 */
.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(620px, 100%); max-height: 86vh; overflow-y: auto; }
.dialog .x { margin-left: auto; }
.d-meta { font-size: 13px; margin: 8px 0; }
.dialog h4 { margin: 16px 0 10px; font-size: 13px; }
.pays { display: flex; flex-direction: column; gap: 6px; }
.pay { display: flex; gap: 10px; align-items: baseline; font-size: 13px; flex-wrap: wrap; }
.pay b { margin-left: auto; }
.pnote { font-size: 11px; width: 100%; }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 16px 20px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .ldot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 3px; }
</style>
