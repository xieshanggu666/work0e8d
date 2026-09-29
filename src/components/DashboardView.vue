<script setup>
import { computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const s = computed(() => {
  const data = store.data || {}
  const fin = data.finance || []
  const today = fin.filter(f => f.day === (data.clock?.day || 1))
  const rev = today.filter(f => f.amount > 0).reduce((a, b) => a + b.amount, 0)
  const exp = today.filter(f => f.amount < 0).reduce((a, b) => a + b.amount, 0)
  const ops = (data.rides || []).filter(r => r.status === 'operating').length
  return {
    visitors: data.visitorToday || 0,
    rev, exp,
    ops,
    total: (data.rides || []).length,
    activeEvents: (data.events || []).filter(e => e.status === 'active').length,
    buildZones: (data.zones || []).filter(z => !z.unlocked).length,
    lowHealth: (data.rides || []).filter(r => r.health < 40).length
  }
})

const trendMax = computed(() => {
  const vs = store.visitors
  return Math.max(...vs.map(v => v.count), 50)
})

function trendPath() {
  const vs = store.visitors
  if (!vs.length) return ''
  const W = 620, H = 130
  const step = W / Math.max(vs.length - 1, 1)
  const pts = vs.map((v, i) => [i * step, H - (v.count / trendMax.value) * (H - 8)])
  return 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')
}

function areaPath() {
  const vs = store.visitors
  if (!vs.length) return ''
  const W = 620, H = 130
  const step = W / Math.max(vs.length - 1, 1)
  const pts = vs.map((v, i) => [i * step, H - (v.count / trendMax.value) * (H - 8)])
  const base = `L ${W},${H} L 0,${H} Z`
  return 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L') + ' ' + base
}

const repLabels = Array.from({ length: Math.min(store.visitors.length, 12) }, (_, i) => `${store.visitors[i]?.hour ?? ''}:00`)
</script>

<template>
  <div class="dash" v-if="store.loaded">
    <div class="stat-grid">
      <div class="card stat"><span>👥</span><b>{{ s.visitors.toLocaleString() }}</b><em>今日入园</em></div>
      <div class="card stat"><span>📈</span><b class="money">{{ s.rev.toLocaleString() }}</b><em>今日营收</em></div>
      <div class="card stat"><span>📉</span><b class="money neg">{{ s.exp.toLocaleString() }}</b><em>今日支出</em></div>
      <div class="card stat"><span>🔄</span><b class="money">{{ (s.rev + s.exp).toLocaleString() }}</b><em>今日净利</em></div>
      <div class="card stat"><span>🎢</span><b>{{ s.ops }}/{{ s.total }}</b><em>运营设施</em></div>
      <div class="card stat"><span>🎆</span><b>{{ s.activeEvents }}</b><em>待处理事件</em></div>
      <div class="card stat" :class="{ alert: store.complaintStats.overdue }">
        <span>📮</span><b>{{ store.complaintStats.open }}</b><em>待处置投诉<span v-if="store.complaintStats.overdue">（{{ store.complaintStats.overdue }} 超时）</span></em>
      </div>
      <div class="card stat">
        <span>💬</span><b :class="store.wordOfMouth > 0 ? 'money' : store.wordOfMouth < 0 ? 'money neg' : ''">{{ store.wordOfMouth > 0 ? '+' : '' }}{{ store.wordOfMouth }}</b><em>服务口碑</em>
      </div>
      <div class="card stat">
        <span>✅</span><b>{{ store.reservationStats.todayChecked }}</b><em>分时预约已核销</em>
      </div>
      <div class="card stat" :class="{ alert: store.reservationStats.oversoldPending }">
        <span>⚠️</span><b :class="store.reservationStats.oversoldPending ? 'money neg' : ''">{{ store.reservationStats.oversoldPending }}</b><em>超售待消化</em>
      </div>
      <div class="card stat">
        <span>💳</span><b>{{ store.memberStats.activeCards }}</b><em>有效持卡会员</em>
      </div>
      <div class="card stat">
        <span class="money">¥</span><b class="money">{{ store.memberStats.cardRevToday.toLocaleString() }}</b><em>今日购卡收入</em>
      </div>
      <div class="card stat" :class="{ alert: store.memberStats.expiring }">
        <span>⏳</span><b :class="store.memberStats.expiring ? 'money neg' : ''">{{ store.memberStats.expiring }}</b><em>会员卡即将到期</em>
      </div>
    </div>

    <div class="row">
      <div class="card chart">
        <h3>📈 入园客流趋势 <span class="muted">(近 {{ store.visitors.length }} 个时段)</span></h3>
        <svg viewBox="0 0 640 150" preserveAspectRatio="none" class="svg">
          <defs>
            <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#ff6b6b" stop-opacity=".45"/>
              <stop offset="1" stop-color="#ff6b6b" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path :d="areaPath()" fill="url(#tg)"/>
          <path :d="trendPath()" fill="none" stroke="#ff6b6b" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
        <div class="axis-labels">
          <span v-for="(l,i) in repLabels" :key="i">{{ l }}</span>
        </div>
      </div>

      <div class="card satisfaction">
        <h3>😊 游客满意度</h3>
        <div class="sat-num">{{ Math.round(store.data?.avgs?.satisfaction ?? 0) }}</div>
        <div class="bar"><i :style="{ width: (store.data?.avgs?.satisfaction ?? 0) + '%', background: (store.data?.avgs?.satisfaction ?? 70) > 60 ? 'var(--green)' : (store.data?.avgs?.satisfaction ?? 70) > 40 ? 'var(--accent2)' : 'var(--red)' }"></i></div>
        <div class="muted">设备开放率 {{ Math.round((store.data?.avgs?.openRatio ?? 0) * 100) }}%</div>
        <div class="kv"><span>🎢 低健康度设施</span><b>{{ s.lowHealth }}</b></div>
        <div class="kv"><span>🧹 待清洁区域</span><b>{{ store.zones.filter(z => z.cleanliness < 45).length }}</b></div>
      </div>
    </div>

    <div class="row-3">
      <div class="card">
        <h3>🏗️ 待开发区域</h3>
        <div class="zoneq" v-if="store.zones.filter(z=>!z.unlocked).length">
          <div v-for="z in store.zones.filter(z=>!z.unlocked)" :key="z.id" class="lock">
            🔒 {{ z.name }} <em class="muted">{{ z.theme }}</em>
            <button class="ghost danger" @click="store.unlock(z.id)">扩建 8万</button>
          </div>
        </div>
        <div class="muted" v-else>所有区域均已开放 🎉</div>
      </div>
      <div class="card">
        <h3>🚨 待处理事件</h3>
        <div v-if="store.activeEvents.length">
          <div v-for="e in store.activeEvents.slice(0,5)" :key="e.id" class="ev"
               :style="{ borderColor: e.impact > 0 ? 'var(--green)' : 'var(--red)' }">
            <b>{{ e.impact > 0 ? '✨' : '⚠️' }} {{ e.title }}</b>
            <button class="ghost" @click="store.resolveEvent(e.id)">处理</button>
          </div>
        </div>
        <div class="muted" v-else>园区一切正常，无待办事件 ✅</div>
      </div>
      <div class="card">
        <h3>🏆 设施营收 TOP</h3>
        <div class="rank" v-for="(r,i) in [...store.rides].sort((a,b)=>b.rev-a.rev).slice(0,5)" :key="r.id">
          <span class="no">{{ i+1 }}</span>
          <span>{{ r.name }}</span>
          <b class="money">{{ r.rev.toLocaleString() }}</b>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 16px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat span { font-size: 24px; }
.stat b { font-size: 26px; }
.stat em { font-style: normal; color: var(--muted); font-size: 13px; }
.stat.alert { border-color: rgba(255,107,107,.55); }
.stat.alert em span { color: var(--red); }
.row { display: grid; grid-template-columns: 1.8fr 1fr; gap: 16px; }
.row-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
@media (max-width: 1000px) { .row, .row-3 { grid-template-columns: 1fr; } }
.svg { width: 100%; height: 130px; }
.axis-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 4px; }
.sat-num { font-size: 46px; font-weight: 800; color: var(--accent2); }
.bar { height: 12px; background: var(--panel2); border-radius: 8px; overflow: hidden; margin: 10px 0; }
.bar i { display: block; height: 100%; border-radius: 8px; transition: .4s; }
.kv, .zoneq .lock, .ev, .rank { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
.zoneq .lock { border: 1px dashed var(--border); border-radius: 8px; margin-bottom: 6px; }
.ev { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; }
.rank .no { width: 20px; height: 20px; border-radius: 6px; background: var(--accent2); color: #000; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
</style>