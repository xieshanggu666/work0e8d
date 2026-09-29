<script setup>
import { ref, computed } from 'vue'
import { useParkStore, newRequestId } from '@/store/park'

const store = useParkStore()

function errText(r, fallback = '操作失败，请稍后重试') {
  if (r?.ok) return ''
  const msg = r?.msg || fallback
  const tag = r?.code ? `〔${r.code}${r.reqId ? ' · ' + r.reqId : ''}〕` : ''
  return msg + tag
}

const tabs = [
  { k: 'members', label: '会员档案' },
  { k: 'cards', label: '购卡办理' },
  { k: 'benefits', label: '积分·权益' },
  { k: 'ops', label: '运营配置' }
]
const tab = ref('members')

const stats = computed(() => store.memberStats)
const cfg = computed(() => store.memberConfig)

const TIER_BADGE = {
  none: { cls: 't-none', name: '普通会员', icon: '🎫' },
  silver: { cls: 't-silver', name: '银卡', icon: '🥈' },
  gold: { cls: 't-gold', name: '金卡', icon: '🥇' },
  diamond: { cls: 't-dia', name: '钻石', icon: '💎' }
}

// ============ 会员档案 ============
const fTier = ref('all')
const fStatus = ref('all')
const fQ = ref('')
const filteredMembers = computed(() => store.members.filter(m => {
  if (fTier.value !== 'all') {
    if (fTier.value === 'none') { if (m.tier_now !== 'none') return false }
    else if (m.tier_now !== fTier.value) return false
  }
  if (fStatus.value !== 'all' && m.status !== fStatus.value) return false
  if (fQ.value) {
    const q = fQ.value.trim()
    if (!m.name.includes(q) && !(m.phone || '').includes(q) && !m.code.includes(q)) return false
  }
  return true
}))

const detail = ref(null)
const detailLogs = ref(null)
const busy = ref(false)
async function openDetail(m) {
  const d = await store.memberDetail(m.id)
  if (d) { detail.value = d.member; detailLogs.value = d }
}
function closeDetail() { detail.value = null; detailLogs.value = null }

const ACTION_LABEL = {
  register: '注册建档', card: '购卡', renew: '续费', upgrade: '升级',
  freeze: '冻结', unfreeze: '解冻', expire: '到期降级', redeem: '积分兑换',
  topup: '储值充值', adjust: '积分调整', ticket: '现场购票', vendor: '商铺消费'
}
const POINT_SRC = {
  card: '开卡赠送', entry: '入园消费', ride: '设施消费', vendor: '商铺消费',
  redeem: '积分兑换', refund: '退款回退', adjust: '运营调整', expire: '过期', comp: '投诉补偿'
}

async function toggleFreeze(m) {
  if (busy.value) return
  busy.value = true
  try {
    let r
    if (m.status === 'frozen') r = await store.freezeMember(m.id, false)
    else r = await store.freezeMember(m.id, true, '运营风险管控')
    if (!r?.ok) alert(errText(r, '冻结/解冻失败'))
  } finally { busy.value = false }
}

// 调分弹窗
const adj = ref({ open: false, change: 0, note: '' })
function openAdjust(m) { adj.value = { open: true, id: m.id, change: 0, note: '', msg: null } }
async function submitAdjust() {
  const r = await store.adjustMemberPoints(adj.value.id, +adj.value.change, adj.value.note)
  if (r?.ok) { adj.value.open = false } else adj.value.msg = errText(r)
}

// 归属运营人员
async function changeOwner(m, staffId) {
  const r = await store.setOwner(m.id, staffId || null)
  if (!r?.ok) alert(errText(r, '归属设置失败'))
}

// 快捷充值（详情内）
const topupAmt = ref(100)
const topupMsg = ref(null)
async function doTopup() {
  const r = await store.memberTopup(detail.value.id, +topupAmt.value, newRequestId())
  topupMsg.value = r?.ok ? { ok: true, text: `充值成功，余额 ¥${r.balance}` } : { ok: false, text: errText(r) }
  if (r?.ok) { const d = await store.memberDetail(detail.value.id); detail.value = d.member; detailLogs.value = d }
}

// ============ 购卡办理 ============
const regForm = ref({ name: '', phone: '', staff_id: null })
const regMsg = ref(null)
const pickedMember = ref(null)
const cardReqId = ref(newRequestId())
const cardBusy = ref(false)
const cardMsg = ref(null)

async function submitRegister() {
  regMsg.value = null
  const r = await store.registerMember({
    name: regForm.value.name, phone: regForm.value.phone, staff_id: regForm.value.staff_id
  })
  if (r?.ok) {
    regMsg.value = { ok: true, text: `建档成功：${r.code}` }
    regForm.value = { name: '', phone: '', staff_id: regForm.value.staff_id }
    pickedMember.value = store.members.find(m => m.id === r.id) || null
  } else {
    regMsg.value = { ok: false, text: errText(r, '注册失败') }
  }
}

function pickForCard(m) { pickedMember.value = m; cardMsg.value = null; cardReqId.value = newRequestId() }

async function buyCard(card) {
  if (!pickedMember.value) { cardMsg.value = { ok: false, text: '请先选择或新建会员' }; return }
  if (cardBusy.value) return
  cardBusy.value = true
  try {
    const r = await store.applyCard(pickedMember.value.id, card.tier, { request_id: cardReqId.value })
    if (r?.ok) {
      cardMsg.value = { ok: true, text: `${r.type === 'new' ? '购卡' : r.type === 'renew' ? '续费' : '升级'}成功：${r.code}，¥${r.price}，有效期至第 ${r.expire_day} 天` }
      cardReqId.value = newRequestId()
      pickedMember.value = store.members.find(m => m.id === pickedMember.value.id) || pickedMember.value
    } else {
      cardMsg.value = { ok: false, text: errText(r) }
    }
  } finally { cardBusy.value = false }
}

// 会员现场购票
const ticketBusy = ref(false)
const ticketMsg = ref(null)
async function buyTicket() {
  if (!pickedMember.value) return
  ticketBusy.value = true
  try {
    const r = await store.buyMemberTicket(pickedMember.value.id, 1, newRequestId())
    ticketMsg.value = r?.ok
      ? { ok: true, text: `出票成功：${TIER_BADGE[pickedMember.value.tier_now]?.name || '会员'}价 ¥${r.unit}，获 ${r.points} 积分` }
      : { ok: false, text: errText(r) }
  } finally { ticketBusy.value = false }
}

// ============ 积分·权益 ============
const benefitMember = ref(null)
const redeemMsg = ref(null)
function pickBenefitMember(m) { benefitMember.value = m; redeemMsg.value = null }
async function redeem(p) {
  if (!benefitMember.value || redeemMsg.value?.busy) return
  redeemMsg.value = { busy: true }
  const r = await store.redeemBenefit(benefitMember.value.id, p.code, newRequestId())
  redeemMsg.value = r?.ok ? { ok: true, text: `兑换成功：${p.name}` } : { ok: false, text: errText(r) }
}

// 会员商铺消费（联动核销）
const spendVendor = ref(null)
const spendMethod = ref('cash')
const spendVoucherId = ref(null)
const spendMsg = ref(null)
const spendVouchers = ref([])
async function loadSpendVouchers() {
  if (!benefitMember.value || spendMethod.value !== 'voucher') { spendVoucherId.value = null; spendVouchers.value = []; return }
  const d = await store.memberDetail(benefitMember.value.id)
  spendVouchers.value = (d?.benefits || []).filter(b => b.kind === 'voucher' && b.status === 'unused')
  spendVoucherId.value = spendVouchers.value[0]?.id || null
}
async function doSpend() {
  if (!benefitMember.value || !spendVendor.value) return
  if (spendMethod.value === 'voucher' && !spendVoucherId.value) { spendMsg.value = { ok: false, text: '该会员没有可用消费券' }; return }
  const r = await store.memberVendorSpend(benefitMember.value.id, spendVendor.value.id, {
    pay_method: spendMethod.value, benefit_id: spendVoucherId.value, qty: 1
  })
  spendMsg.value = r?.ok
    ? { ok: true, text: `消费 ¥${r.bill}（现金 ¥${r.cashPart}/储值 ¥${r.balancePart}/券 ¥${r.voucherPart}），获 ${r.points} 积分` }
    : { ok: false, text: errText(r) }
}

// ============ 运营配置 ============
const cfgForm = ref(null)
function editCfg() {
  cfgForm.value = { ...cfg.value, msg: null }
}
async function saveCfg() {
  const r = await store.saveMemberConfig({
    enabled: cfgForm.value.enabled, pointRate: +cfgForm.value.pointRate,
    pointsComp: +cfgForm.value.pointsComp, benefitValidDays: +cfgForm.value.benefitValidDays
  })
  cfgForm.value.msg = r?.ok ? { ok: true, text: '配置已保存' } : { ok: false, text: errText(r) }
}

const editingCard = ref({})
function beginCardEdit(c) { editingCard.value[c.id] = { ...c } }
async function saveCard(c) {
  const e = editingCard.value[c.id]
  const r = await store.updateCardProduct(c.tier, {
    price: +e.price, valid_days: +e.valid_days, point_mul: +e.point_mul,
    discount_entry: +e.discount_entry, discount_ride: +e.discount_ride, discount_vendor: +e.discount_vendor,
    give_ticket: +e.give_ticket, give_voucher: +e.give_voucher, give_fastpass: +e.give_fastpass,
    bonus_points: +e.bonus_points, active: e.active ? 1 : 0
  })
  if (r?.ok) editingCard.value[c.id] = null
  else alert(errText(r, '卡种保存失败'))
}
const fmtPct = v => Math.round(v * 100) + '%'

const memberChoices = computed(() => store.members)
</script>

<template>
  <div class="mem">
    <!-- 顶部指标 -->
    <div class="stat-grid">
      <div class="card stat"><span>👥</span><b>{{ stats.total }}</b><em>会员总数</em></div>
      <div class="card stat"><span>💳</span><b>{{ stats.activeCards }}</b><em>有效持卡会员</em></div>
      <div class="card stat"><span>🥇</span><b>{{ stats.gold + stats.diamond }}</b><em>金卡/钻石会员</em></div>
      <div class="card stat" :class="{ alert: stats.expiring }"><span>⏳</span><b :class="stats.expiring ? 'neg' : ''">{{ stats.expiring }}</b><em>3 日内到期</em></div>
      <div class="card stat" :class="{ alert: stats.frozen }"><span>🔒</span><b :class="stats.frozen ? 'neg' : ''">{{ stats.frozen }}</b><em>冻结账户</em></div>
      <div class="card stat"><span class="money">¥</span><b class="money">{{ stats.cardRevToday.toLocaleString() }}</b><em>今日购卡收入</em></div>
      <div class="card stat"><span>🏦</span><b>{{ stats.balanceLiability.toLocaleString() }}</b><em>储值负债余额</em></div>
      <div class="card stat"><span>🎁</span><b>{{ stats.pointsOutstanding.toLocaleString() }}</b><em>会员积分存量</em></div>
    </div>

    <div class="tabs card">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
      <span class="muted hint" v-if="!cfg.enabled" style="color:var(--red)">⚠️ 会员体系当前已停用（运营配置中可重新开启）</span>
    </div>

    <!-- ============ 会员档案 ============ -->
    <div v-if="tab === 'members'" class="card">
      <div class="filters">
        <div class="seg">
          <button :class="{ on: fTier === 'all' }" @click="fTier = 'all'">全部</button>
          <button :class="{ on: fTier === 'diamond' }" @click="fTier = 'diamond'">💎 钻石</button>
          <button :class="{ on: fTier === 'gold' }" @click="fTier = 'gold'">🥇 金卡</button>
          <button :class="{ on: fTier === 'silver' }" @click="fTier = 'silver'">🥈 银卡</button>
          <button :class="{ on: fTier === 'none' }" @click="fTier = 'none'">🎫 普通</button>
        </div>
        <div class="seg">
          <button :class="{ on: fStatus === 'all' }" @click="fStatus = 'all'">所有状态</button>
          <button :class="{ on: fStatus === 'active' }" @click="fStatus = 'active'">正常</button>
          <button :class="{ on: fStatus === 'frozen' }" @click="fStatus = 'frozen'">冻结</button>
        </div>
        <input v-model="fQ" placeholder="搜索姓名 / 手机号 / 会员号" class="search" />
      </div>

      <div class="table">
        <div class="thead">
          <span>会员</span><span>等级</span><span>积分</span><span>储值</span><span>权益</span><span>有效期</span><span>归属专员</span><span>状态</span><span>操作</span>
        </div>
        <div class="trow" v-for="m in filteredMembers" :key="m.id">
          <span>
            <b>{{ m.name }}</b>
            <em class="muted">{{ m.code }}<template v-if="m.phone"> · {{ m.phone }}</template></em>
          </span>
          <span><span class="tier" :class="TIER_BADGE[m.tier_now].cls">{{ TIER_BADGE[m.tier_now].icon }} {{ TIER_BADGE[m.tier_now].name }}</span></span>
          <span class="pts">{{ m.points.toLocaleString() }}</span>
          <span class="money">¥{{ m.balance.toLocaleString() }}</span>
          <span class="bens">
            <em v-if="m.benefits.ticket" title="免票券">🎟️×{{ m.benefits.ticket }}</em>
            <em v-if="m.benefits.voucher" title="消费券">🧧×{{ m.benefits.voucher }}</em>
            <em v-if="m.benefits.fastpass" title="快速通行券">⚡×{{ m.benefits.fastpass }}</em>
            <em v-if="!m.benefits.ticket && !m.benefits.voucher && !m.benefits.fastpass" class="muted">—</em>
          </span>
          <span>
            <template v-if="m.card_valid">
              <span :class="{ exp: m.card_expiring }">第{{ m.card_expire_day }}天</span>
              <em class="muted">剩{{ m.remain_days }}天</em>
            </template>
            <em v-else class="muted">无卡</em>
          </span>
          <span>
            <select :value="m.owner_staff_id || ''" @change="changeOwner(m, +$event.target.value || null)">
              <option value="">未分配</option>
              <option v-for="s in store.memberSpecialists" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </span>
          <span>
            <i class="dot" :class="m.status"></i>{{ m.status === 'frozen' ? '已冻结' : '正常' }}
          </span>
          <span class="ops">
            <button class="ghost" @click="openDetail(m)">档案</button>
            <button class="ghost" @click="pickForCard(m); tab = 'cards'">办卡</button>
            <button class="ghost" @click="pickBenefitMember(m); tab = 'benefits'">权益</button>
            <button class="ghost" :class="{ danger: m.status !== 'frozen' }" @click="toggleFreeze(m)">{{ m.status === 'frozen' ? '解冻' : '冻结' }}</button>
          </span>
        </div>
        <div class="muted empty" v-if="!filteredMembers.length">没有符合条件的会员。</div>
      </div>
    </div>

    <!-- ============ 购卡办理 ============ -->
    <div v-if="tab === 'cards'" class="cards-wrap">
      <div class="card reg-card">
        <h3>📝 新建/检索会员</h3>
        <label class="fld">姓名<input v-model="regForm.name" placeholder="游客姓名" maxlength="12" /></label>
        <label class="fld">手机号（选填）<input v-model="regForm.phone" placeholder="用于会员唯一识别" maxlength="11" /></label>
        <label class="fld">接待专员
          <select v-model.number="regForm.staff_id">
            <option :value="null">不指定</option>
            <option v-for="s in store.memberSpecialists" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <button class="primary wide" @click="submitRegister">注册会员</button>
        <em v-if="regMsg" class="msg" :class="{ err: !regMsg.ok }">{{ regMsg.text }}</em>
        <div class="divider"></div>
        <h3>选择在店会员</h3>
        <select :value="pickedMember?.id || ''" @change="pickForCard(store.members.find(m => m.id === +$event.target.value))">
          <option value="" disabled>选择会员…</option>
          <option v-for="m in store.members.slice(0, 60)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }} · {{ TIER_BADGE[m.tier_now].name }}</option>
        </select>
      </div>

      <div class="card buy-card">
        <h3>💳 卡种办理
          <span class="muted" v-if="pickedMember" style="font-size:12px">
            当前：{{ pickedMember.name }}（{{ TIER_BADGE[pickedMember.tier_now].name }}<template v-if="pickedMember.card_valid">，剩 {{ pickedMember.remain_days }} 天</template>）
          </span>
        </h3>
        <div class="card-grid">
          <div v-for="c in store.cardProducts" :key="c.id" class="plan" :class="[c.tier, { off: !c.active }]">
            <div class="plan-h">
              <b>{{ c.name }}</b>
              <div class="price">¥{{ c.price }}<em>/{{ c.valid_days }}天</em></div>
            </div>
            <ul>
              <li>积分倍率 ×{{ c.point_mul }}</li>
              <li>门票 / 设施 {{ fmtPct(c.discount_entry) }}</li>
              <li>商铺 {{ fmtPct(c.discount_vendor) }}</li>
              <li v-if="c.give_ticket">赠免票券 ×{{ c.give_ticket }}</li>
              <li v-if="c.give_voucher">赠消费券 ×{{ c.give_voucher }}</li>
              <li v-if="c.give_fastpass">赠快速通行券 ×{{ c.give_fastpass }}</li>
              <li v-if="c.bonus_points">开卡赠 {{ c.bonus_points }} 积分</li>
            </ul>
            <button class="primary" :disabled="!pickedMember || cardBusy || !c.active" @click="buyCard(c)">
              {{ !c.active ? '已停售' : pickedMember ? (pickedMember.tier_now === c.tier ? '续费' : (pickedMember.tier_now === 'none' ? '购买' : '升级')) : '请先选会员' }}
            </button>
          </div>
        </div>
        <em v-if="cardMsg" class="msg" :class="{ err: !cardMsg.ok }">{{ cardMsg.text }}</em>
        <div class="divider"></div>
        <h3>🎫 会员现场优惠票（直接入园）</h3>
        <div class="ticket-row">
          <button class="succ" :disabled="!pickedMember || ticketBusy" @click="buyTicket">
            {{ pickedMember ? `会员价出票（当日票价 ¥${store.ticket}）` : '请先选择会员' }}
          </button>
          <em v-if="ticketMsg" class="msg" :class="{ err: !ticketMsg.ok }">{{ ticketMsg.text }}</em>
        </div>
      </div>
    </div>

    <!-- ============ 积分·权益 ============ -->
    <div v-if="tab === 'benefits'" class="ben-wrap">
      <div class="card">
        <h3>🎯 选择会员
          <select class="inline-sel" :value="benefitMember?.id || ''" @change="pickBenefitMember(store.members.find(m => m.id === +$event.target.value))">
            <option value="" disabled>选择会员…</option>
            <option v-for="m in store.members.slice(0, 80)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }} · {{ m.points }} 积分</option>
          </select>
        </h3>
        <div v-if="benefitMember" class="ben-summary">
          <div><em>可用积分</em><b>{{ benefitMember.points.toLocaleString() }}</b></div>
          <div><em>储值余额</em><b class="money">¥{{ benefitMember.balance }}</b></div>
          <div><em>免票券</em><b>🎟️ {{ benefitMember.benefits.ticket || 0 }}</b></div>
          <div><em>消费券</em><b>🧧 {{ benefitMember.benefits.voucher || 0 }}</b></div>
          <div><em>快速通行券</em><b>⚡ {{ benefitMember.benefits.fastpass || 0 }}</b></div>
        </div>
        <div v-else class="muted empty">请选择会员查看积分与权益。</div>
      </div>

      <div class="card" v-if="benefitMember">
        <h3>🛍️ 积分兑换中心</h3>
        <div class="ex-grid">
          <div v-for="p in store.benefitProducts.filter(x => x.active)" :key="p.id" class="ex-item">
            <b>{{ p.kind === 'balance' ? '💰' : p.kind === 'voucher' ? '🧧' : p.kind === 'ticket' ? '🎟️' : '⚡' }} {{ p.name }}</b>
            <em class="cost">{{ p.points_cost }} 积分</em>
            <button :disabled="benefitMember.points < p.points_cost || redeemMsg?.busy" @click="redeem(p)">兑换</button>
          </div>
        </div>
        <em v-if="redeemMsg" class="msg" :class="{ err: !redeemMsg.ok }">{{ redeemMsg.text }}</em>
        <p class="muted tips">储值为会员负债（充值/兑换入账，消费时才确认商业收入）；免票券用于分时入园 0 元预约；快速通行券可在满员时段下单并走快速通道核销。</p>
      </div>

      <div class="card" v-if="benefitMember">
        <h3>🏪 会员商铺消费（联动核销）</h3>
        <div class="spend-row">
          <select v-model.number="spendVendor">
            <option :value="null" disabled>选择商铺…</option>
            <option v-for="v in store.vendors" :key="v.id" :value="v">{{ v.name }}（¥{{ v.price }}）</option>
          </select>
          <select v-model="spendMethod" @change="loadSpendVouchers">
            <option value="cash">现金支付</option>
            <option value="balance">储值支付（余额 ¥{{ benefitMember.balance }}）</option>
            <option value="voucher">消费券支付</option>
          </select>
          <select v-if="spendMethod === 'voucher'" v-model.number="spendVoucherId">
            <option :value="null" disabled>{{ spendVouchers.length ? '选择消费券…' : '无可用消费券' }}</option>
            <option v-for="b in spendVouchers" :key="b.id" :value="b.id">🧧 ¥{{ b.amount }} · 第{{ b.expire_day }}天到期</option>
          </select>
          <button class="succ" :disabled="!spendVendor || (spendMethod === 'voucher' && !spendVoucherId)" @click="doSpend">会员折扣消费</button>
        </div>
        <em v-if="spendMsg" class="msg" :class="{ err: !spendMsg.ok }">{{ spendMsg.text }}</em>
      </div>
    </div>

    <!-- ============ 运营配置 ============ -->
    <div v-if="tab === 'ops'" class="ops-wrap">
      <div class="card">
        <h3>⚙️ 会员体系参数</h3>
        <button class="ghost" @click="editCfg">编辑参数</button>
        <div v-if="!cfgForm" class="cfg-list">
          <div><span>会员体系</span><b :class="cfg.enabled ? 'money' : 'neg'">{{ cfg.enabled ? '运行中' : '已停用' }}</b></div>
          <div><span>积分基准（每 ¥10 实付）</span><b>{{ cfg.pointRate }} 分</b></div>
          <div><span>投诉积分补偿档</span><b>{{ cfg.pointsComp }} 分</b></div>
          <div><span>券类权益有效期</span><b>{{ cfg.benefitValidDays }} 游戏日</b></div>
        </div>
        <div v-else class="cfg-form">
          <label class="fld row2"><span>启用会员体系</span><input type="checkbox" v-model="cfgForm.enabled" /></label>
          <label class="fld row2"><span>积分基准（每 ¥10 实付，0~10）</span><input type="number" step="0.1" min="0" max="10" v-model.number="cfgForm.pointRate" /></label>
          <label class="fld row2"><span>投诉积分补偿（0~10000）</span><input type="number" min="0" max="10000" v-model.number="cfgForm.pointsComp" /></label>
          <label class="fld row2"><span>权益有效期（1~365 游戏日）</span><input type="number" min="1" max="365" v-model.number="cfgForm.benefitValidDays" /></label>
          <button class="primary" @click="saveCfg">保存配置</button>
          <em v-if="cfgForm.msg" class="msg" :class="{ err: !cfgForm.msg.ok }">{{ cfgForm.msg.text }}</em>
        </div>
      </div>

      <div class="card">
        <h3>💳 卡种配置</h3>
        <div class="table">
          <div class="thead cfg-head">
            <span>卡种</span><span>价格</span><span>有效天</span><span>积分倍率</span><span>入园折</span><span>设施折</span><span>商铺折</span><span>赠票/券/FP</span><span>赠分</span><span>状态</span><span></span>
          </div>
          <div class="trow cfg-row" v-for="c in store.cardProducts" :key="c.id">
            <template v-if="!editingCard[c.id]">
              <span><b>{{ c.name }}</b></span>
              <span>¥{{ c.price }}</span>
              <span>{{ c.valid_days }}</span>
              <span>×{{ c.point_mul }}</span>
              <span>{{ fmtPct(c.discount_entry) }}</span>
              <span>{{ fmtPct(c.discount_ride) }}</span>
              <span>{{ fmtPct(c.discount_vendor) }}</span>
              <span>{{ c.give_ticket }}/{{ c.give_voucher }}/{{ c.give_fastpass }}</span>
              <span>{{ c.bonus_points }}</span>
              <span><i class="dot" :class="c.active ? 'on' : 'off'"></i>{{ c.active ? '在售' : '停售' }}</span>
              <span><button class="ghost" @click="beginCardEdit(c)">调整</button></span>
            </template>
            <template v-else>
              <span><b>{{ c.name }}</b></span>
              <span><input type="number" v-model.number="editingCard[c.id].price" class="mini-in" /></span>
              <span><input type="number" v-model.number="editingCard[c.id].valid_days" class="mini-in" /></span>
              <span><input type="number" step="0.1" v-model.number="editingCard[c.id].point_mul" class="mini-in" /></span>
              <span><input type="number" step="0.01" min="0.1" max="1" v-model.number="editingCard[c.id].discount_entry" class="mini-in" /></span>
              <span><input type="number" step="0.01" min="0.1" max="1" v-model.number="editingCard[c.id].discount_ride" class="mini-in" /></span>
              <span><input type="number" step="0.01" min="0.1" max="1" v-model.number="editingCard[c.id].discount_vendor" class="mini-in" /></span>
              <span class="gifts">
                <input type="number" min="0" v-model.number="editingCard[c.id].give_ticket" title="免票券" />
                <input type="number" min="0" v-model.number="editingCard[c.id].give_voucher" title="消费券" />
                <input type="number" min="0" v-model.number="editingCard[c.id].give_fastpass" title="快速通行券" />
              </span>
              <span><input type="number" min="0" v-model.number="editingCard[c.id].bonus_points" class="mini-in" /></span>
              <span><label class="sw"><input type="checkbox" v-model="editingCard[c.id].active" />在售</label></span>
              <span class="ops">
                <button class="succ" @click="saveCard(c)">保存</button>
                <button class="ghost" @click="editingCard[c.id] = null">取消</button>
              </span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 会员档案详情抽屉 ============ -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <h3>👤 {{ detail.name }}
          <span class="tier" :class="TIER_BADGE[detail.tier_now].cls">{{ TIER_BADGE[detail.tier_now].icon }} {{ detail.tier_name }}</span>
          <button class="ghost x" @click="closeDetail">✕</button>
        </h3>
        <div class="d-grid">
          <div><em>会员号</em><b>{{ detail.code }}</b></div>
          <div><em>手机</em><b>{{ detail.phone || '—' }}</b></div>
          <div><em>积分</em><b class="pts">{{ detail.points }}（累计 {{ detail.total_points }}）</b></div>
          <div><em>储值</em><b class="money">¥{{ detail.balance }}</b></div>
          <div><em>卡有效期</em><b>{{ detail.card_valid ? `第${detail.card_expire_day}天（剩${detail.remain_days}天）` : '无卡' }}</b></div>
          <div><em>状态</em><b :class="detail.status === 'frozen' ? 'neg' : 'money'">{{ detail.status === 'frozen' ? '已冻结' : '正常' }}</b></div>
        </div>

        <div class="d-actions">
          <div class="topup-line">
            <select v-model.number="topupAmt">
              <option :value="50">充值 ¥50</option>
              <option :value="100">充值 ¥100</option>
              <option :value="300">充值 ¥300</option>
              <option :value="500">充值 ¥500</option>
            </select>
            <button class="primary" @click="doTopup">储值充值</button>
          </div>
          <button class="ghost" @click="openAdjust(detail)">手动调分</button>
          <button class="ghost" @click="pickBenefitMember(detail); closeDetail(); tab = 'benefits'">去兑换</button>
        </div>
        <em v-if="topupMsg" class="msg" :class="{ err: !topupMsg.ok }">{{ topupMsg.text }}</em>

        <h4>🎁 权益账户</h4>
        <div class="ben-list">
          <div v-for="b in (detailLogs?.benefits || [])" :key="b.id" class="ben-row">
            <span>{{ { balance: '💰 储值', voucher: '🧧 消费券', ticket: '🎟️ 免票券', fastpass: '⚡ 快速通行券' }[b.kind] }}</span>
            <em class="muted" v-if="b.amount">面额 ¥{{ b.amount }}</em>
            <em class="muted">第{{ b.expire_day }}天到期</em>
            <span class="tag" :class="'st-' + b.status">{{ { unused: '未使用', used: '已核销', expired: '已过期', refunded: '已返还' }[b.status] }}</span>
            <em class="muted" v-if="b.used_ref_type">{{ b.used_ref_type === 'reservation' ? '预约核销' : b.used_ref_type === 'vendor' ? '商铺核销' : b.used_ref_type }}</em>
          </div>
          <div v-if="!(detailLogs?.benefits || []).length" class="muted">暂无权益记录。</div>
        </div>

        <h4>📒 积分流水</h4>
        <div class="logs">
          <div v-for="l in (detailLogs?.pointLogs || []).slice(0, 12)" :key="l.id" class="log">
            <span class="ldot"></span>
            <b :class="l.change >= 0 ? 'money' : 'neg'">{{ l.change >= 0 ? '+' : '' }}{{ l.change }}</b>
            <em class="muted">{{ POINT_SRC[l.source] || l.source }} · 余额 {{ l.balance_after }}</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>

        <h4>🕘 生命周期</h4>
        <div class="logs">
          <div v-for="l in (detailLogs?.logs || []).slice(0, 10)" :key="l.id" class="log">
            <span class="ldot"></span>
            <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 手动调分弹窗 -->
    <div class="mask" v-if="adj.open" @click.self="adj.open = false">
      <div class="dialog card small">
        <h3>✏️ 手动调整积分<button class="ghost x" @click="adj.open = false">✕</button></h3>
        <label class="fld">变动积分（正数赠送 / 负数扣减）<input type="number" v-model.number="adj.change" /></label>
        <label class="fld">原因<input v-model="adj.note" placeholder="如：活动奖励 / 异常扣减" maxlength="50" /></label>
        <em v-if="adj.msg" class="msg err">{{ adj.msg }}</em>
        <button class="primary wide" @click="submitAdjust">确认调整</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mem { display: flex; flex-direction: column; gap: 14px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.neg { color: var(--red); }

.tabs { display: flex; align-items: center; gap: 8px; }
.tabs button { padding: 7px 18px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }
.tabs .hint { margin-left: 8px; font-size: 12px; }

.seg { display: flex; gap: 6px; }
.seg button { padding: 6px 12px; font-size: 12px; }
.seg button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }

.filters { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.search { min-width: 220px; }
.table { overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: 1.3fr .8fr .7fr .7fr .9fr .9fr 1fr .7fr 2fr; gap: 8px; align-items: center; padding: 10px 8px; font-size: 13px; min-width: 1050px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.trow em { display: block; font-style: normal; font-size: 11px; }
.ops { display: flex; gap: 4px; flex-wrap: wrap; }
.ops button { font-size: 11px; padding: 4px 8px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot.on, .dot.active { background: var(--green); }
.dot.off, .dot.frozen { background: var(--red); }
.pts { color: var(--accent2); font-weight: 600; }
.exp { color: var(--red); font-weight: 600; }
.bens em { font-style: normal; font-size: 11px; margin-right: 4px; white-space: nowrap; }
.empty { padding: 18px; text-align: center; }

.tier { display: inline-block; font-size: 11px; padding: 2px 9px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); }
.t-none { color: var(--muted); }
.t-silver { color: #d7dce8; border-color: #8b93ad; background: rgba(200,205,220,.12); }
.t-gold { color: var(--accent2); border-color: rgba(255,209,102,.55); background: rgba(255,209,102,.1); }
.t-dia { color: #8fd8ff; border-color: rgba(120,200,255,.6); background: rgba(120,200,255,.12); }

/* 购卡 */
.cards-wrap { display: grid; grid-template-columns: 340px 1fr; gap: 14px; align-items: start; }
@media (max-width: 1000px) { .cards-wrap { grid-template-columns: 1fr; } }
.fld { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
.fld.row2 { flex-direction: row; align-items: center; justify-content: space-between; }
.fld.row2 input[type=number] { width: 140px; }
.wide { width: 100%; padding: 10px; }
.msg { display: block; margin-top: 10px; font-size: 12.5px; color: var(--green); font-style: normal; }
.msg.err { color: var(--red); }
.divider { height: 1px; background: var(--border); margin: 16px 0; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.plan { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--panel2); display: flex; flex-direction: column; gap: 10px; }
.plan.silver { border-top: 3px solid #b9c0d2; }
.plan.gold { border-top: 3px solid var(--accent2); }
.plan.diamond { border-top: 3px solid #7cc7ff; }
.plan.off { opacity: .55; }
.plan-h b { font-size: 16px; }
.plan .price { font-size: 24px; font-weight: 800; color: var(--accent); }
.plan .price em { font-size: 12px; color: var(--muted); font-weight: 400; font-style: normal; }
.plan ul { list-style: none; font-size: 12.5px; color: var(--muted); flex: 1; display: flex; flex-direction: column; gap: 5px; }
.ticket-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }

/* 积分权益 */
.ben-wrap { display: flex; flex-direction: column; gap: 14px; }
.inline-sel { min-width: 220px; margin-left: 10px; }
.ben-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap: 10px; margin-top: 12px; }
.ben-summary div { background: var(--panel2); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 4px; }
.ben-summary em { font-style: normal; font-size: 11px; color: var(--muted); }
.ben-summary b { font-size: 17px; }
.ex-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; }
.ex-item { border: 1px solid var(--border); border-radius: 10px; padding: 14px; background: var(--panel2); display: flex; flex-direction: column; gap: 8px; }
.ex-item b { font-size: 14px; }
.ex-item .cost { font-style: normal; font-size: 12px; color: var(--accent2); }
.tips { font-size: 12px; line-height: 1.7; margin-top: 10px; }
.spend-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.spend-row select { min-width: 180px; }

/* 运营配置 */
.ops-wrap { display: flex; flex-direction: column; gap: 14px; }
.cfg-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.cfg-list div { display: flex; justify-content: space-between; font-size: 13px; padding: 6px 0; border-bottom: 1px dashed var(--border); }
.cfg-form { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; max-width: 420px; }
.cfg-head { grid-template-columns: repeat(11, minmax(60px, 1fr)); min-width: 1000px; }
.cfg-row { grid-template-columns: repeat(11, minmax(60px, 1fr)); min-width: 1000px; }
.mini-in { width: 64px; padding: 4px 6px; }
.gifts { display: flex; gap: 4px; }
.gifts input { width: 42px; padding: 4px; }
.sw { font-size: 12px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }

/* 详情抽屉 */
.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(640px, 100%); max-height: 88vh; overflow-y: auto; }
.dialog.small { width: min(420px, 100%); }
.dialog .x { margin-left: auto; }
.dialog h3 { display: flex; align-items: center; gap: 10px; }
.dialog h4 { margin: 18px 0 10px; font-size: 13px; }
.d-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin: 14px 0; }
.d-grid div { display: flex; justify-content: space-between; font-size: 13px; border-bottom: 1px dashed var(--border); padding: 5px 0; }
.d-grid em { font-style: normal; color: var(--muted); }
.d-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.topup-line { display: flex; gap: 6px; }
.ben-list { display: flex; flex-direction: column; gap: 6px; }
.ben-row { display: flex; gap: 10px; align-items: center; font-size: 12.5px; padding: 7px 10px; background: var(--panel2); border-radius: 8px; flex-wrap: wrap; }
.ben-row .tag.st-unused { color: var(--green); border-color: rgba(109,213,160,.5); }
.ben-row .tag.st-used { color: var(--muted); }
.ben-row .tag.st-refunded { color: var(--blue); border-color: rgba(102,166,255,.5); }
.logs { display: flex; flex-direction: column; }
.log { position: relative; padding: 0 0 14px 18px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .ldot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 2px; }
</style>
