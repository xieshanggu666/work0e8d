<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const typeFilter = ref('all')
const zoneFilter = ref(0)
const buildOpen = ref(false)
const build = ref({ type: '过山车', zone_id: 1, name: '' })

const types = ['过山车', '旋转木马', '摩天轮', '跳楼机', '碰碰车', '海盗船', '水上漂流', '云霄飞车']
const typeIcon = t => ({ '过山车':'🎢', '旋转木马':'🎠', '摩天轮':'🎡', '跳楼机':'🪂', '碰碰车':'🚗', '海盗船':'⛵', '水上漂流':'💦', '云霄飞车':'🚀' }[t])

const list = computed(() => store.rides.filter(r =>
  (typeFilter.value === 'all' || r.type === typeFilter.value) &&
  (!zoneFilter.value || r.zone_id === zoneFilter.value)
))

// ---- 检修工单 ----
const repairStaff = computed(() => store.staff.filter(s => s.active && s.role === '维修'))
const openOrders = computed(() => store.maintenanceOrders.filter(o => ['queued', 'processing'].includes(o.status)))
const doneOrders = computed(() => store.maintenanceOrders.filter(o => o.status === 'done' || o.status === 'cancelled'))
const showDone = ref(false)
const picks = ref({})      // orderId -> staffId
const msg = ref('')

const ORDER_STATUS = {
  queued: { name: '排队待接单', cls: 'st-queued' },
  processing: { name: '检修中', cls: 'st-processing' },
  done: { name: '已完工', cls: 'st-done' },
  cancelled: { name: '已撤销', cls: 'st-cancel' }
}
const SOURCE_NAME = { manual: '人工报修', auto: '故障停运', system: '既有检修' }
const ACTION_LABEL = {
  create: '报修建单', assign: '员工接单', transfer: '转派',
  release: '离岗接续', complete: '检修完工', cancel: '撤销工单'
}
const ACTION_ICON = { create: '🛎️', assign: '🛠️', transfer: '🔁', release: '📤', complete: '✅', cancel: '🚫' }

// 在岗且手头无在修工单的维修工（排队单可接）；转派时允许把当前接单人之外的空闲工列入候选
function freeStaffFor(order) {
  return repairStaff.value.filter(s => !s.maint_load || (order && order.assignee_id === s.id))
}

function staffText(s) {
  return `${s.name} · Lv.${s.skill}${s.morale < 45 ? ' · 低士气' : ''}`
}
function orderOf(rideId) {
  return store.maintenanceOrders.find(o => o.ride_id === rideId && ['queued', 'processing'].includes(o.status))
}
async function assignOrder(o) {
  const sid = Number(picks.value[o.id])
  if (!sid) { msg.value = '请先选择维修工'; return }
  const r = await store.assignMaintenance(o.id, sid)
  if (!r?.ok) msg.value = r?.msg || '接单失败'
  else msg.value = ''
}
async function transferOrder(o) {
  const sid = Number(picks.value[o.id])
  if (!sid) { msg.value = '请先选择要转派的维修工'; return }
  if (sid === o.assignee_id) { msg.value = '该员工已在检修此设施'; return }
  const r = await store.assignMaintenance(o.id, sid)
  if (!r?.ok) msg.value = r?.msg || '转派失败'
  else msg.value = ''
}
async function cancelOrder(o) {
  const r = await store.cancelMaintenance(o.id)
  if (!r?.ok) msg.value = r?.msg || '撤销失败'
}
function repair(r) {
  store.updateRide(r.id, { repair: 1 }).then(res => {
    if (res && res.ok === false) msg.value = res.msg || '报修失败'
  })
}

// ---- 工单详情时间线 ----
const detail = ref(null)
const detailLogs = ref([])
async function openDetail(o) {
  const r = await store.maintenanceDetail(o.id)
  if (r?.order) { detail.value = r.order; detailLogs.value = r.logs || [] }
}
function closeDetail() { detail.value = null }

function update(r, payload) { store.updateRide(r.id, payload) }
function submit() {
  store.buildRide({ ...build.value, name: build.value.name || `${build.value.type}·新馆` })
  buildOpen.value = false
  build.value.name = ''
}
</script>

<template>
  <div class="rides">
    <div class="bar">
      <div class="filters">
        <select v-model="typeFilter"><option value="all">全部类型</option><option v-for="t in types" :key="t" :value="t">{{ t }}</option></select>
        <select v-model="zoneFilter"><option :value="0">全部区域</option><option v-for="z in store.zones" :key="z.id" :value="z.id">{{ z.name }}</option></select>
      </div>
      <button class="primary" @click="buildOpen = true">＋ 新建设施</button>
    </div>

    <div class="hint" v-if="msg">⚠️ {{ msg }}</div>

    <!-- 检修工单队列 -->
    <div class="card orders">
      <h3>🛠️ 检修工单
        <span class="tag" v-if="store.maintenanceStats.queued">排队 {{ store.maintenanceStats.queued }}</span>
        <span class="tag warn" v-if="store.maintenanceStats.processing">在修 {{ store.maintenanceStats.processing }}</span>
        <em class="muted" v-if="!openOrders.length">　暂无在途工单</em>
      </h3>
      <div class="empty muted" v-if="!openOrders.length">
        所有设施运行正常。健康度跌破 25 会自动停运并生成工单，也可在下方列表对设施「报修检修」（预约将联动全额退款、完工后自动恢复可售时段）。
      </div>
      <div class="ocard" v-for="o in openOrders" :key="o.id">
        <div class="o-main">
          <div class="o-head">
            <b>{{ o.code }}</b>
            <span class="badge" :class="ORDER_STATUS[o.status].cls">{{ ORDER_STATUS[o.status].name }}</span>
            <span class="muted">{{ typeIcon(store.rides.find(r=>r.id===o.ride_id)?.type) }}{{ o.ride_name }}</span>
            <span class="muted">来源：{{ SOURCE_NAME[o.source] }}</span>
            <span class="muted">核定费用 <b class="money neg">¥{{ o.cost.toLocaleString() }}</b><em>（完工结算）</em></span>
          </div>
          <div class="o-prog">
            <div class="pb"><i :style="{ width: o.progress + '%' }"></i></div>
            <span>{{ Math.round(o.progress) }}%</span>
            <span class="muted" v-if="o.status==='processing'">
              {{ o.assignee_name ? `${o.assignee_name} 检修中` : '' }}
              <em v-if="!o.assignee_active">（原维修工已离岗）</em>
              · 预计还需 {{ o.eta_hours }} 游戏小时
            </span>
            <span class="muted" v-else>等待维修员工接单</span>
          </div>
        </div>
        <div class="o-ops">
          <template v-if="o.status === 'queued'">
            <select v-model.number="picks[o.id]">
              <option :value="0" disabled>选择维修工…</option>
              <option v-for="s in freeStaffFor(o)" :key="s.id" :value="s.id">{{ staffText(s) }}</option>
            </select>
            <button class="primary sm" @click="assignOrder(o)">派单</button>
            <button class="ghost sm" @click="cancelOrder(o)">撤销</button>
          </template>
          <template v-else>
            <select v-model.number="picks[o.id]">
              <option :value="0" disabled>转派给…</option>
              <option v-for="s in freeStaffFor(o)" :key="s.id" :value="s.id" :disabled="s.id===o.assignee_id">{{ staffText(s) }}</option>
            </select>
            <button class="ghost sm" @click="transferOrder(o)">转派</button>
          </template>
          <button class="ghost sm" @click="openDetail(o)">时间线</button>
        </div>
      </div>

      <div v-if="doneOrders.length" class="done-toggle">
        <button class="ghost sm" @click="showDone = !showDone">{{ showDone ? '隐藏' : '查看' }}最近完工/撤销工单（{{ doneOrders.length }}）</button>
      </div>
      <div class="ocard done" v-for="o in doneOrders" :key="'d'+o.id" v-show="showDone">
        <div class="o-head">
          <b>{{ o.code }}</b>
          <span class="badge" :class="ORDER_STATUS[o.status].cls">{{ ORDER_STATUS[o.status].name }}</span>
          <span class="muted">{{ o.ride_name }}</span>
          <span class="muted" v-if="o.status==='done'">{{ o.assignee_name }} 完工 · 费用 ¥{{ o.cost.toLocaleString() }}</span>
        </div>
        <div class="o-ops"><button class="ghost sm" @click="openDetail(o)">时间线</button></div>
      </div>
    </div>

    <div class="table card">
      <div class="thead">
        <span>设施</span><span>类型</span><span>区域</span><span>状态</span><span>健康度</span><span>刺激度</span><span>票价</span><span>累计营收</span><span>操作</span>
      </div>
      <div class="trow" v-for="r in list" :key="r.id">
        <span><b>{{ r.name }}</b><em class="muted">{{ r.type }}</em></span>
        <span>{{ typeIcon(r.type) }}</span>
        <span>{{ store.zones.find(z=>z.id===r.zone_id)?.name }}</span>
        <span>
          <i class="dot" :class="r.status"></i>{{ r.status === 'operating' ? '运营' : r.status === 'maintenance' ? '检修' : '关闭' }}
          <em class="muted" v-if="r.maint_status === 'queued'">·工单排队中</em>
          <em class="muted" v-else-if="r.maint_status === 'processing'">·检修推进中</em>
        </span>
        <span><div class="hb"><i :style="{width:r.health+'%', background: r.health>60?'var(--green)':r.health>40?'var(--accent2)':'var(--red)'}"></i></div>{{ r.health }}</span>
        <span>{{ r.thrill }}</span>
        <span class="money">{{ r.price }}</span>
        <span class="money">{{ r.rev.toLocaleString() }}</span>
        <span class="ops">
          <template v-if="orderOf(r.id)">
            <button class="ghost" @click="openDetail(orderOf(r.id))">工单详情</button>
          </template>
          <template v-else>
            <button class="ghost" @click="r.status==='operating'?update(r,{status:'closed'}):update(r,{status:'operating'})">{{ r.status==='operating'?'关闭':'开放' }}</button>
            <button class="ghost" @click="repair(r)">报修检修</button>
          </template>
          <button class="ghost" @click="update(r,{upgrade:10})">升级</button>
          <button class="ghost danger" @click="store.delRide(r.id)">拆除</button>
        </span>
      </div>
    </div>

    <div class="modal" v-if="buildOpen">
      <div class="modal-box card">
        <h3>🏗️ 新建设施</h3>
        <div class="form">
          <label>设施类型
            <select v-model="build.type"><option v-for="t in types" :key="t" :value="t">{{ t }}</option></select>
          </label>
          <label>所属区域
            <select v-model.number="build.zone_id"><option v-for="z in store.zones.filter(z=>z.unlocked)" :key="z.id" :value="z.id">{{ z.name }}</option></select>
          </label>
          <label>名称 <input v-model="build.name" placeholder="留空自动命名" /></label>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">确认建造</button>
          <button class="ghost" @click="buildOpen=false">取消</button>
        </div>
      </div>
    </div>

    <!-- 工单详情时间线 -->
    <div class="modal" v-if="detail">
      <div class="modal-box card wide">
        <h3>🛠️ 检修工单 {{ detail.code }}</h3>
        <div class="d-meta">
          <div><em class="muted">设施</em><b>{{ detail.ride_name }}</b></div>
          <div><em class="muted">状态</em><b><span class="badge" :class="ORDER_STATUS[detail.status].cls">{{ ORDER_STATUS[detail.status].name }}</span></b></div>
          <div><em class="muted">来源</em><b>{{ SOURCE_NAME[detail.source] }}</b></div>
          <div><em class="muted">维修工</em><b>{{ detail.assignee_name || '待接单' }}</b></div>
          <div><em class="muted">核定费用</em><b class="money neg">¥{{ detail.cost.toLocaleString() }}</b></div>
          <div><em class="muted">进度</em><b>{{ Math.round(detail.progress) }}%</b></div>
        </div>
        <div class="pb big"><i :style="{ width: detail.progress + '%' }"></i></div>
        <h4>处理时间线</h4>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="log-row">
            <span class="l-ic">{{ ACTION_ICON[l.action] || '📍' }}</span>
            <div>
              <b>{{ ACTION_LABEL[l.action] || l.action }}<em class="muted">　第{{ l.day }}天 {{ l.hour }}:00</em></b>
              <p class="muted">{{ l.note }}</p>
            </div>
          </div>
          <div class="muted empty" v-if="!detailLogs.length">暂无记录</div>
        </div>
        <div class="acts"><button class="ghost" @click="closeDetail">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rides { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.filters { display: flex; gap: 8px; }
.hint { background: rgba(255,209,102,.12); border: 1px solid rgba(255,209,102,.4); color: var(--accent2); padding: 8px 12px; border-radius: 8px; font-size: 13px; }
.orders { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.orders h3 { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.orders h3 em { font-style: normal; font-size: 12px; }
.tag { font-size: 11px; background: rgba(102,187,255,.18); color: #66bbff; border: 1px solid rgba(102,187,255,.4); padding: 1px 8px; border-radius: 20px; }
.tag.warn { background: rgba(255,209,102,.18); color: var(--accent2); border-color: rgba(255,209,102,.4); }
.empty { padding: 10px 2px; font-size: 13px; line-height: 1.6; }
.ocard { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; }
.ocard.done { opacity: .75; }
.o-main { flex: 1; min-width: 280px; display: flex; flex-direction: column; gap: 6px; }
.o-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.o-head em { font-style: normal; font-size: 11px; }
.o-prog { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.o-prog em { font-style: normal; }
.o-ops { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sm { font-size: 12px; padding: 5px 10px; }
.done-toggle { margin-top: 2px; }
.badge { font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid transparent; }
.st-queued { background: rgba(255,209,102,.16); color: var(--accent2); border-color: rgba(255,209,102,.4); }
.st-processing { background: rgba(102,187,255,.14); color: #66bbff; border-color: rgba(102,187,255,.4); }
.st-done { background: rgba(80,220,120,.14); color: var(--green); border-color: rgba(80,220,120,.4); }
.st-cancel { background: rgba(150,150,160,.14); color: var(--muted); border-color: var(--border); }
.pb { width: 220px; height: 8px; background: rgba(255,255,255,.08); border-radius: 5px; overflow: hidden; }
.pb i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent2), #ffd166); border-radius: 5px; transition: width .3s; }
.pb.big { width: 100%; margin: 6px 0 12px; }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: 1.6fr .5fr .8fr .9fr 1fr .6fr .6fr .9fr 2fr; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 900px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.trow b { display: block; }
.trow em { font-style: normal; font-size: 11px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot.operating { background: var(--green); }
.dot.maintenance { background: var(--accent2); }
.dot.closed { background: var(--red); }
.hb { width: 90px; height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; display: inline-block; margin-right: 6px; vertical-align: middle; }
.hb i { display: block; height: 100%; }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.ops button { font-size: 11px; padding: 4px 8px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(420px, 92vw); }
.modal-box.wide { width: min(560px, 94vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.acts { display: flex; gap: 8px; }
.d-meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 12px 0 8px; }
.d-meta em { display: block; font-style: normal; font-size: 11px; }
.d-meta b { font-size: 14px; }
.logs { display: flex; flex-direction: column; gap: 10px; max-height: 280px; overflow-y: auto; margin: 6px 0 12px; }
.log-row { display: flex; gap: 10px; }
.l-ic { font-size: 18px; }
.log-row p { font-size: 12px; margin-top: 2px; line-height: 1.5; }
.log-row b em { font-style: normal; font-weight: normal; font-size: 11px; margin-left: 6px; }
</style>
