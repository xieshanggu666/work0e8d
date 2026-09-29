<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const OPEN_STATUSES = ['open', 'processing', 'ready']

const tabs = [
  { k: 'open', label: '待处置' },
  { k: 'closed', label: '已结案' },
  { k: 'all', label: '全部' }
]
const tab = ref('open')

const list = computed(() => {
  const all = store.complaints
  if (tab.value === 'open') return all.filter(c => OPEN_STATUSES.includes(c.status))
  if (tab.value === 'closed') return all.filter(c => !OPEN_STATUSES.includes(c.status))
  return all
})

const CATS = [
  { k: 'queue', name: '排队秩序', icon: '⏳' },
  { k: 'hygiene', name: '环境卫生', icon: '🧹' },
  { k: 'facility', name: '设施故障', icon: '🛠️' },
  { k: 'safety', name: '安全隐患', icon: '🚨' },
  { k: 'food', name: '餐饮质量', icon: '🍔' },
  { k: 'service', name: '服务态度', icon: '💁' },
  { k: 'pricing', name: '价格争议', icon: '💰' },
  { k: 'missing', name: '物品遗失', icon: '🎒' }
]

const COMP_OPTIONS = [
  { k: 'apology', name: '真诚道歉', desc: '零成本，小幅安抚', costText: '¥0' },
  { k: 'ticket', name: '赠门票', desc: '成本=当日票价，游客好感较高', costText: '当日票价' },
  { k: 'fastpass', name: '快速通行券', desc: '热门设施免排队，评价明显回升', costText: '¥150' },
  { k: 'voucher', name: '园内消费券', desc: '可回流商铺二次消费', costText: '¥300' },
  { k: 'cash', name: '现金补偿', desc: '最有诚意，口碑回流最强', costText: '¥600' },
  { k: 'points', name: '会员积分', desc: '仅会员投诉，零现金成本（按运营配置积分档）', costText: '积分', memberOnly: true }
]

const statusMeta = st => ({
  open: { label: '待受理', cls: 'st-open' },
  processing: { label: '处理中', cls: 'st-processing' },
  ready: { label: '待确认补偿', cls: 'st-ready' },
  closed_resolved: { label: '已补偿结案', cls: 'st-done' },
  closed_force: { label: '未补偿结案', cls: 'st-bad' },
  closed_timeout: { label: '超时差评', cls: 'st-bad' }
}[st] || { label: st, cls: '' })

const sevCls = s => (s >= 3 ? 'sev3' : s === 2 ? 'sev2' : 'sev1')
const deadlineText = c => c.overdue ? '已超时' : `剩 ${c.remain_ticks}h`

const activeStaff = computed(() => store.staff.filter(s => s.active))
const assignees = ref({})   // complaintId -> staffId
const compChoice = ref({})  // complaintId -> comp key

function staffText(s) {
  return `${s.name} · ${s.role} · Lv.${s.skill}${s.morale < 45 ? ' · 低士气' : ''}`
}
function assign(c) {
  const sid = assignees.value[c.id]
  if (!sid) return
  store.assignComplaint(c.id, sid)
}
function escalate(c) { store.escalateComplaint(c.id) }
function resolveC(c) { store.resolveComplaint(c.id, compChoice.value[c.id] || 'apology') }
function forceClose(c) { store.closeComplaint(c.id) }
function compName(k) { return COMP_OPTIONS.find(o => o.k === k)?.name || '—' }

// ---- 详情时间线 ----
const detail = ref(null)
const detailLogs = ref([])
const ACTION_LABEL = {
  submit: '游客提交', assign: '指派受理', ready: '处置完成', resolve: '补偿结案',
  escalate: '升级', auto_escalate: '自动升级', unassign: '退回待受理', force: '不予补偿结案', timeout: '超时结案'
}
async function openDetail(c) {
  const r = await store.complaintDetail(c.id)
  if (r?.complaint) { detail.value = r.complaint; detailLogs.value = r.logs || [] }
}
function closeDetail() { detail.value = null }

// ---- 前台手动登记 ----
const blankManual = () => ({ category: 'service', severity: 1, content: '', target_type: '', target_id: '', member_id: null })
const manual = ref(blankManual())
const manualMsg = ref('')
const targetOptions = computed(() => {
  if (manual.value.target_type === 'ride') return store.rides
  if (manual.value.target_type === 'vendor') return store.vendors
  if (manual.value.target_type === 'zone') return store.zones
  return []
})
async function submitManual() {
  if (!manual.value.content.trim()) { manualMsg.value = '请填写游客反馈内容'; return }
  const r = await store.fileComplaint({ ...manual.value, target_id: manual.value.target_id || undefined })
  if (r?.ok) {
    manualMsg.value = `已登记工单 ${r.code}，请及时指派员工处置`
    manual.value = blankManual()
  } else {
    manualMsg.value = r?.msg || '登记失败'
  }
}

const stats = computed(() => store.complaintStats)
const wom = computed(() => store.wordOfMouth)
const womText = computed(() => `${wom.value > 0 ? '+' : ''}${wom.value.toFixed(1)}`)
</script>

<template>
  <div class="cp">
    <div class="stat-grid">
      <div class="card stat" :class="{ alert: stats.overdue }">
        <span>📮</span><b>{{ stats.open }}</b><em>待处置投诉</em>
      </div>
      <div class="card stat" :class="{ alert: stats.overdue }">
        <span>⏰</span><b :class="{ neg: stats.overdue }">{{ stats.overdue }}</b><em>已超时限</em>
      </div>
      <div class="card stat"><span>✅</span><b>{{ stats.todayClosed }}</b><em>今日结案</em></div>
      <div class="card stat"><span>⭐</span><b>{{ stats.resolved ? stats.avgRating : '—' }}</b><em>平均结案评价</em></div>
      <div class="card stat">
        <span>💬</span><b :class="wom > 0 ? 'pos' : wom < 0 ? 'neg' : ''">{{ womText }}</b><em>服务口碑 · 回流客流</em>
      </div>
      <div class="card stat"><span>💸</span><b class="money neg">¥{{ stats.compTotal.toLocaleString() }}</b><em>累计补偿支出</em></div>
    </div>

    <div class="cols">
      <div class="left card">
        <h3>📨 投诉工单
          <span class="tag" v-if="stats.open">{{ stats.open }} 待处置</span>
        </h3>
        <div class="tabs">
          <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
        </div>

        <div class="clist">
          <div v-for="c in list" :key="c.id" class="citem" :class="[sevCls(c.severity), { overdue: c.overdue, closed: !OPEN_STATUSES.includes(c.status) }]">
            <div class="ci-head">
              <span class="big-ic">{{ c.category_icon }}</span>
              <div class="ci-title">
                <b>{{ c.title }}</b>
                <em class="muted">{{ c.code }} · 第{{ c.day }}天提交 · {{ c.target_name || '园区整体' }}<span v-if="c.source==='manual'"> · 前台登记</span></em>
                <em class="muted" v-if="c.member_code"> · 💎 会员 {{ c.member_code }}（{{ c.member_name }}）</em>
              </div>
              <span class="badge sev" :class="sevCls(c.severity)">{{ c.severity_name }}</span>
              <span class="badge" :class="statusMeta(c.status).cls">{{ statusMeta(c.status).label }}</span>
              <button class="ghost timeline-btn" @click="openDetail(c)">时间线</button>
            </div>
            <p class="content">{{ c.content }}</p>

            <!-- 处置中：员工与进度 -->
            <div class="ci-body" v-if="c.status === 'processing'">
              <div class="assignee">
                <span v-if="c.assignee_name">
                  👷 {{ c.assignee_name }}（{{ c.assignee_role }}）
                  <i :class="c.role_match ? 'match' : 'mismatch'">{{ c.role_match ? '岗位匹配' : '岗位不符·效率减半' }}</i>
                </span>
                <span v-else class="muted">暂无受理人</span>
              </div>
              <div class="pbar"><i :style="{ width: c.progress + '%' }"></i><b>{{ Math.round(c.progress) }}%</b></div>
            </div>

            <!-- 待受理：指派员工 -->
            <div class="ci-body" v-else-if="c.status === 'open'">
              <select v-model.number="assignees[c.id]">
                <option :value="undefined" disabled>选择受理员工…</option>
                <option v-for="s in activeStaff" :key="s.id" :value="s.id">{{ staffText(s) }}</option>
              </select>
            </div>

            <!-- 待确认补偿：补偿方案（会员积分档仅会员投诉可用） -->
            <div class="ci-body" v-else-if="c.status === 'ready'">
              <div class="comps">
                <button v-for="o in COMP_OPTIONS" :key="o.k"
                        :class="{ on: (compChoice[c.id] || 'apology') === o.k, dis: o.memberOnly && !c.member_id }"
                        :disabled="o.memberOnly && !c.member_id"
                        :title="o.memberOnly && !c.member_id ? '仅会员本人投诉可积分补偿' : o.desc"
                        @click="compChoice[c.id] = o.k">
                  <b>{{ o.name }}</b><em>{{ o.memberOnly ? `${store.memberConfig.pointsComp} 分` : o.costText }}</em>
                </button>
              </div>
              <em class="muted comp-tip" v-if="c.member_code">💎 会员投诉：{{ c.member_code }} {{ c.member_name }}，可使用积分补偿（零现金成本）</em>
            </div>

            <!-- 已结案信息 -->
            <div class="ci-body closed-info" v-else>
              <span v-if="c.status === 'closed_resolved'">🎁 {{ compName(c.compensation) }}<em v-if="c.comp_cost"> · ¥{{ c.comp_cost.toLocaleString() }}</em> · 评价
                <b class="stars">{{ '★'.repeat(c.rating) }}<span class="dim">{{ '★'.repeat(5 - c.rating) }}</span></b>
              </span>
              <span v-else class="neg">😞 {{ c.close_reason }}</span>
            </div>

            <div class="ci-foot" v-if="OPEN_STATUSES.includes(c.status)">
              <span class="sla" :class="{ red: c.overdue || c.remain_ticks <= 2 }">
                🕒 {{ deadlineText(c) }}
              </span>
              <div class="actions">
                <button v-if="c.status === 'open'" class="succ" :disabled="!assignees[c.id]" @click="assign(c)">受理</button>
                <button v-if="c.status === 'ready'" class="succ" @click="resolveC(c)">确认补偿结案</button>
                <button v-if="c.severity < 3" class="ghost" @click="escalate(c)">⬆ 升级{{ c.escalated ? `（${c.escalations}次）` : '' }}</button>
                <button class="danger" @click="forceClose(c)">不予补偿结案</button>
              </div>
            </div>
          </div>
          <div class="muted empty" v-if="!list.length">
            {{ tab === 'open' ? '当前无待处置投诉，园区服务运转良好 🎉' : '暂无结案记录。' }}
          </div>
        </div>
      </div>

      <div class="right">
        <div class="card">
          <h3>📝 前台登记游客反馈</h3>
          <div class="mtype">
            <button v-for="t in CATS" :key="t.k" :class="{ on: manual.category === t.k }" :title="t.name" @click="manual.category = t.k">
              <span>{{ t.icon }}</span><em>{{ t.name }}</em>
            </button>
          </div>
          <div class="mfields">
            <label>严重程度
              <select v-model.number="manual.severity">
                <option :value="1">一般（限时 8h）</option>
                <option :value="2">严重（限时 5h）</option>
                <option :value="3">紧急（限时 3h）</option>
              </select>
            </label>
            <label>关联对象（可选）
              <select v-model="manual.target_type" @change="manual.target_id = ''">
                <option value="">不指定</option>
                <option value="ride">游乐设施</option>
                <option value="vendor">商铺</option>
                <option value="zone">区域</option>
              </select>
            </label>
            <select v-if="manual.target_type" v-model.number="manual.target_id">
              <option :value="''" disabled>请选择…</option>
              <option v-for="t in targetOptions" :key="t.id" :value="t.id">{{ t.name }}</option>
            </select>
            <label>会员投诉（可选，可积分补偿结案）
              <select v-model.number="manual.member_id">
                <option :value="null">非会员/散客</option>
                <option v-for="m in store.members.slice(0, 80)" :key="m.id" :value="m.id">{{ m.code }} · {{ m.name }} · {{ m.tier_name }}</option>
              </select>
            </label>
            <textarea v-model="manual.content" rows="3" maxlength="200" placeholder="游客原话：排队、卫生、设施、餐饮、服务……"></textarea>
            <button class="primary" @click="submitManual">生成投诉工单</button>
            <em v-if="manualMsg" class="mmsg">{{ manualMsg }}</em>
          </div>
        </div>

        <div class="card tips">
          <h3>🔁 服务补救如何回流经营</h3>
          <ul>
            <li>未结投诉按严重度持续压低游客<b>满意度</b>，紧急投诉超时会引发公开差评事件。</li>
            <li>指派岗位匹配、高技能高士气的员工，处置更快、结案评价更高。</li>
            <li>补偿越有诚意，<b>声誉</b>与<b>服务口碑</b>回升越多，口碑实时回流未来<b>客流</b>（每点约 ±1.2%）。</li>
            <li>「不予补偿结案」立省现金，但会扣减声誉与口碑，慎用。</li>
            <li>处置完成后 6 小时未确认补偿，系统将自动以「真诚道歉」结案。</li>
          </ul>
        </div>
      </div>
    </div>

    <!-- 投诉详情时间线 -->
    <div class="mask" v-if="detail" @click.self="closeDetail">
      <div class="dialog card">
        <h3>{{ detail.category_icon }} {{ detail.title }}
          <span class="badge sev" :class="sevCls(detail.severity)">{{ detail.severity_name }}</span>
          <button class="ghost x" @click="closeDetail">✕</button>
        </h3>
        <p class="content">{{ detail.content }}</p>
        <div class="d-meta muted">
          工单号 {{ detail.code }} · 第{{ detail.day }}天提交 · 状态「{{ statusMeta(detail.status).label }}」
          <span v-if="detail.assignee_name"> · 受理人 {{ detail.assignee_name }}（{{ detail.assignee_role }}）</span>
        </div>
        <div v-if="detail.status === 'closed_resolved'" class="d-result">
          补偿：{{ compName(detail.compensation) }}（¥{{ detail.comp_cost }}） · 游客评价
          <b class="stars">{{ '★'.repeat(detail.rating) }}<span class="dim">{{ '★'.repeat(5 - detail.rating) }}</span></b>
          <br /><em class="muted">{{ detail.close_reason }}</em>
        </div>
        <div v-else-if="!OPEN_STATUSES.includes(detail.status)" class="d-result">
          <span class="neg">{{ detail.close_reason }}</span>
        </div>
        <h4>处理时间线</h4>
        <div class="logs">
          <div v-for="l in detailLogs" :key="l.id" class="log">
            <span class="dot"></span>
            <b>{{ ACTION_LABEL[l.action] || l.action }}</b>
            <em class="muted">第{{ l.day }}天 {{ l.hour }}:00</em>
            <p class="muted">{{ l.note }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp { display: flex; flex-direction: column; gap: 16px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat span { font-size: 22px; }
.stat b { font-size: 24px; }
.stat em { font-style: normal; color: var(--muted); font-size: 12px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.pos { color: var(--green); }
.neg { color: var(--red); }

.cols { display: grid; grid-template-columns: 1.7fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }

.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tabs button { padding: 5px 14px; font-size: 12px; }
.tabs button.on { border-color: var(--accent); background: rgba(255,107,107,.14); color: var(--accent); }

.clist { display: flex; flex-direction: column; gap: 10px; max-height: 640px; overflow-y: auto; padding-right: 4px; }
.citem { border: 1px solid var(--border); border-left-width: 3px; border-radius: 10px; padding: 12px; background: rgba(255,255,255,.02); }
.citem.sev1 { border-left-color: var(--blue); }
.citem.sev2 { border-left-color: var(--accent2); }
.citem.sev3 { border-left-color: var(--red); }
.citem.overdue { background: rgba(255,107,107,.07); border-color: rgba(255,107,107,.4); }
.citem.closed { opacity: .85; }

.ci-head { display: flex; align-items: center; gap: 10px; }
.ci-head .big-ic { font-size: 22px; }
.ci-title { flex: 1; min-width: 0; }
.ci-title b { display: block; font-size: 14px; }
.ci-title em { font-style: normal; font-size: 11px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; border: 1px solid var(--border); background: var(--panel2); color: var(--muted); white-space: nowrap; }
.badge.sev.sev1 { color: var(--blue); border-color: rgba(102,166,255,.5); }
.badge.sev.sev2 { color: var(--accent2); border-color: rgba(255,209,102,.5); }
.badge.sev.sev3 { color: #fff; background: var(--red); border-color: var(--red); }
.st-open { color: var(--accent2) !important; }
.st-processing { color: var(--blue) !important; }
.st-ready { color: var(--purple) !important; }
.st-done { color: var(--green) !important; }
.st-bad { color: var(--red) !important; }
.timeline-btn { font-size: 12px; padding: 4px 10px; }

.content { font-size: 13px; margin: 8px 0; color: var(--text); }

.ci-body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.assignee { font-size: 12px; }
.assignee i { font-style: normal; font-size: 11px; margin-left: 6px; padding: 1px 7px; border-radius: 12px; }
.assignee i.match { background: rgba(109,213,160,.15); color: var(--green); }
.assignee i.mismatch { background: rgba(255,107,107,.15); color: var(--red); }
.pbar { position: relative; height: 18px; background: var(--panel2); border-radius: 9px; overflow: hidden; }
.pbar i { display: block; height: 100%; background: linear-gradient(90deg, var(--blue), var(--purple)); border-radius: 9px; transition: .4s; }
.pbar b { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; }
.ci-body select { font-size: 12px; }

.comps { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 6px; }
.comps button { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; }
.comps button.on { border-color: var(--green); background: rgba(109,213,160,.12); }
.comps button.dis { opacity: .4; }
.comp-tip { font-size: 11px; margin-top: 6px; display: block; }
.comps em { font-style: normal; font-size: 11px; color: var(--muted); }

.closed-info { font-size: 13px; }
.stars { color: var(--accent2); letter-spacing: 1px; }
.stars .dim { color: #3a4366; }

.ci-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; }
.sla { font-size: 12px; color: var(--muted); }
.sla.red { color: var(--red); font-weight: 700; }
.actions { display: flex; gap: 6px; }
.actions button { font-size: 12px; padding: 6px 12px; }

.empty { padding: 24px; text-align: center; }

/* 手动登记 */
.mtype { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 10px 0; }
.mtype button { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 2px; }
.mtype button.on { border-color: var(--accent); background: rgba(255,107,107,.14); }
.mtype span { font-size: 18px; }
.mtype em { font-style: normal; font-size: 11px; color: var(--muted); }
.mfields { display: flex; flex-direction: column; gap: 8px; }
.mfields label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.mfields textarea { font-family: inherit; resize: vertical; }
.mfields .primary { padding: 10px; }
.mmsg { color: var(--green); font-size: 12px; font-style: normal; }

.tips ul { list-style: none; display: flex; flex-direction: column; gap: 9px; font-size: 12.5px; color: var(--muted); }
.tips li { padding-left: 16px; position: relative; line-height: 1.6; }
.tips li::before { content: '•'; position: absolute; left: 2px; color: var(--accent); }
.tips b { color: var(--text); }

/* 详情弹层 */
.mask { position: fixed; inset: 0; background: rgba(5,8,18,.65); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
.dialog { width: min(560px, 100%); max-height: 86vh; overflow-y: auto; position: relative; }
.dialog h3 { position: sticky; top: -18px; background: linear-gradient(180deg, var(--panel) 70%, transparent); padding: 4px 0 8px; z-index: 1; }
.dialog .x { margin-left: auto; }
.d-meta { font-size: 12px; }
.d-result { margin-top: 10px; font-size: 13px; background: var(--panel2); border-radius: 8px; padding: 10px; }
.dialog h4 { margin: 16px 0 10px; font-size: 13px; }
.logs { display: flex; flex-direction: column; gap: 0; }
.log { position: relative; padding: 0 0 16px 20px; border-left: 2px solid var(--border); margin-left: 5px; }
.log:last-child { border-left-color: transparent; padding-bottom: 0; }
.log .dot { position: absolute; left: -7px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg); }
.log b { font-size: 13px; margin-right: 8px; }
.log em { font-size: 11px; }
.log p { font-size: 12px; margin-top: 3px; }
</style>
