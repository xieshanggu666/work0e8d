<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const ticket = ref(120)
const loanAmt = ref(50000)
const periods = ref(10)
const ratePct = ref(1)

const periodChoices = computed(() => store.data?.loanChoices?.periods || [5, 10, 20, 30])
const rateChoices = computed(() => store.data?.loanChoices?.rates || [0.5, 1, 2])

const entrants = computed(() => {
  const p = +store.ticket
  const base = store.data?.guestBase ?? 600
  const rep = store.data?.reputation ?? 70
  const priceFactor = Math.max(0.2, 2.0 - p / 100)
  return Math.round(base * priceFactor * (0.4 + rep / 100) * 0.85)
})

const revenue = computed(() => entrants.value * (+store.ticket) + entrants.value * 30)

// 等额本息每期应还（与后端一致的取整规则）
const installment = computed(() => {
  const p = Math.max(0, +loanAmt.value || 0)
  const n = +periods.value
  const r = (+ratePct.value || 0) / 100
  if (!p || !n) return 0
  if (!r) return Math.round(p / n)
  return Math.round(p * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1))
})
const totalRepay = computed(() => installment.value * (+periods.value || 0))
const totalInterest = computed(() => Math.max(0, totalRepay.value - (+loanAmt.value || 0)))

async function applyLoan() {
  await store.takeLoan(Math.round(+loanAmt.value), +periods.value, +ratePct.value)
}

async function repay(l) {
  await store.repayLoan(l.id)
}
</script>

<template>
  <div class="ticket">
    <div class="twocol">
      <div class="card econ">
        <h3>🎫 门票定价策略</h3>
        <div class="label muted">当前票价：<b class="money" style="font-size:28px">¥{{ store.ticket }}</b></div>
        <input type="range" min="10" max="500" step="5" v-model.number="ticket" style="width:100%" />
        <div class="scale"><span>¥10 亲民</span><span>¥500 高端</span></div>
        <div class="kv-grid">
          <div><em>预期入园/时</em><b>{{ entrants }}</b></div>
          <div><em>预期营收/时</em><b class="money">≈¥{{ revenue.toLocaleString() }}</b></div>
        </div>
        <div class="muted tip">提示：票价升高会减少入园量，但可提升单客收入，需平衡满意流失客。声誉降低时游客对价格更敏感。</div>
        <button class="primary" @click="store.setTicket(ticket)">应用票价 ¥{{ ticket }}</button>
      </div>

      <div class="card bank">
        <h3>🏦 园区财务</h3>
        <div class="kv-grid">
          <div><em>可用现金</em><b class="money">¥{{ store.data?.cash?.toLocaleString() ?? 0 }}</b></div>
          <div><em>未偿贷款本金</em><b class="money neg">¥{{ store.debt.remainPrincipal.toLocaleString() }}</b></div>
        </div>

        <!-- 逾期告警 -->
        <div class="overdue" v-if="store.debt.overdueCount">
          ⚠️ 有 <b>{{ store.debt.overdueCount }}</b> 笔分期还款已逾期，挂账
          <b class="money neg">¥{{ store.debt.arrears.toLocaleString() }}</b>，按日计 2% 罚息，后续日结将优先补扣。
        </div>

        <!-- 申请分期贷款 -->
        <div class="loan">
          <label class="muted">借款金额（¥1,000 ~ ¥5,000,000）</label>
          <input type="number" v-model.number="loanAmt" min="1000" max="5000000" step="1000" />
          <label class="muted">分期期数（1 期 = 1 个游戏日，日结扣款）</label>
          <div class="chips">
            <button v-for="p in periodChoices" :key="p" type="button" class="chip" :class="{ on: periods === p }" @click="periods = p">{{ p }} 期</button>
          </div>
          <label class="muted">每期利率</label>
          <div class="chips">
            <button v-for="r in rateChoices" :key="r" type="button" class="chip" :class="{ on: ratePct === r }" @click="ratePct = r">{{ r }}%</button>
          </div>
          <div class="quote">
            <div><span>每期应还（等额本息）</span><b class="money neg">¥{{ installment.toLocaleString() }}</b></div>
            <div><span>预计总利息</span><b class="money">¥{{ totalInterest.toLocaleString() }}</b></div>
            <div><span>还款总额</span><b class="money">¥{{ totalRepay.toLocaleString() }}</b></div>
          </div>
        </div>
        <button class="succ" @click="applyLoan">申请 {{ periods }} 期分期贷款 ¥{{ (+loanAmt || 0).toLocaleString() }}</button>
        <div class="muted tip">每日闭园日结时自动扣款，按「利息 → 本金」记账；现金不足则部分偿还、余额挂账转逾期并计罚息，待后续有现金时优先补缴。</div>

        <!-- 进行中的贷款 -->
        <template v-if="store.loans.length">
          <h3 style="margin-top:20px">📑 分期账单</h3>
          <div class="loan-item" v-for="l in store.loans" :key="l.id" :class="{ over: l.over }">
            <div class="li-head">
              <b>#{{ l.id }} 借款 ¥{{ l.principal.toLocaleString() }}</b>
              <span class="tag" :class="l.over ? 'tag-over' : 'tag-ok'">{{ l.over ? '逾期中' : '正常' }}</span>
            </div>
            <div class="li-grid">
              <span><em>{{ l.ratePct }}%/期</em></span>
              <span><em>已还</em>{{ l.paid_periods }}/{{ l.periods }} 期</span>
              <span><em>剩余本金</em>¥{{ l.remain_principal.toLocaleString() }}</span>
            </div>
            <div class="li-grid" v-if="l.over">
              <span><em>挂账金额</em><b class="money neg">¥{{ l.arrears.toLocaleString() }}</b></span>
              <span><em>逾期天数</em>{{ l.overdue_days }}</span>
            </div>
            <div class="li-foot">
              <span class="muted">{{ l.over ? '下一日结优先补扣挂账' : `下一期应还 ¥${l.nextDue.toLocaleString()}（息 ¥${l.nextInterest.toLocaleString()}）` }}</span>
              <button class="ghost" @click="repay(l)">提前结清 ¥{{ (l.remain_principal + l.arrears_i).toLocaleString() }}</button>
            </div>
          </div>
        </template>

        <h3 style="margin-top:20px">💡 经营建议</h3>
        <ul class="tips">
          <li v-if="+store.ticket > 200">票价已处于高位，留意入园量下降。</li>
          <li v-if="(store.data?.avgs?.satisfaction ?? 0) < 55">满意度偏低：及时检修设施、增聘保洁。</li>
          <li v-if="store.debt.overdueCount">尽快补充现金偿还逾期贷款，罚息与信用损失会持续累积。</li>
          <li v-else-if="store.zones.some(z=>!z.unlocked)">有未开放区域，可分期贷款扩建吸引更多客流。</li>
          <li v-else>所有区域已开放，聚焦提升单客消费与满意度。</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ticket { }
.twocol { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .twocol { grid-template-columns: 1fr; } }
.label { margin-bottom: 10px; }
.label b { color: var(--accent2); }
.scale { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 4px; }
.kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 16px 0; }
.kv-grid div { background: var(--panel2); border-radius: 10px; padding: 12px; text-align: center; }
.kv-grid em { display: block; font-style: normal; font-size: 12px; color: var(--muted); }
.kv-grid b { font-size: 22px; }
.tip { font-size: 12px; margin: 12px 0; line-height: 1.6; }
.bank button { width: 100%; margin-top: 10px; }
.loan { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip {
  width: auto; margin: 0; padding: 5px 12px; font-size: 13px; border-radius: 16px;
  background: var(--panel2); border: 1px solid var(--border); color: var(--muted); cursor: pointer;
}
.chip.on { background: rgba(255,107,107,.18); border-color: var(--accent); color: var(--accent); }
.quote { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; background: var(--panel2); border-radius: 10px; padding: 10px 12px; font-size: 13px; }
.quote div { display: flex; justify-content: space-between; }
.quote span { color: var(--muted); }
.overdue { background: rgba(255,80,80,.12); border: 1px solid rgba(255,80,80,.45); color: #ff9a9a; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; line-height: 1.6; }
.loan-item { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-top: 10px; font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
.loan-item.over { border-color: rgba(255,80,80,.5); background: rgba(255,80,80,.06); }
.li-head { display: flex; justify-content: space-between; align-items: center; }
.li-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; color: var(--muted); font-size: 12px; }
.li-grid em { font-style: normal; color: var(--muted); margin-right: 4px; }
.li-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.li-foot button { width: auto; margin: 0; font-size: 12px; padding: 5px 10px; }
.tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; }
.tag-ok { background: rgba(109,213,160,.18); color: var(--green); }
.tag-over { background: rgba(255,80,80,.2); color: #ff8080; }
.tips { list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.tips li::before { content: '•'; color: var(--accent2); margin-right: 6px; }
</style>
