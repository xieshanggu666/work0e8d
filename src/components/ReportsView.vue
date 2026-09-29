<script setup>
import { computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const income = computed(() => {
  const map = {}
  ;(store.data?.finance || []).forEach(f => {
    if (f.amount > 0) map[f.label] = (map[f.label] || 0) + f.amount
  })
  return Object.entries(map)
})

const expense = computed(() => {
  const map = {}
  ;(store.data?.finance || []).forEach(f => {
    if (f.amount < 0) map[f.label] = (map[f.label] || 0) - f.amount
  })
  return Object.entries(map)
})

const colors = ['#6dd5a0', '#66a6ff', '#ffd166', '#ff6b6b', '#a78bfa', '#4fc3f7', '#f78fb3']

function donut(entries) {
  const total = entries.reduce((s, e) => s + e[1], 0) || 1
  let off = 0
  const R = 62, C = 2 * Math.PI * R
  return entries.map((e, i) => {
    const len = (e[1] / total) * C
    const seg = { key: e[0], val: e[1], pct: Math.round((e[1] / total) * 100), off: -off, color: colors[i % colors.length] }
    off += len
    return seg
  })
}

const incomeSeg = computed(() => donut(income.value))
const expenseSeg = computed(() => donut(expense.value))

const totalIncome = computed(() => income.value.reduce((s, e) => s + e[1], 0))
const totalExpense = computed(() => expense.value.reduce((s, e) => s + e[1], 0))

// 声誉走势
const repData = computed(() => store.visitors.map(v => v.satisfaction))
const repMax = computed(() => Math.max(...repData.value, 1))
function satPath(min) {
  const vs = repData.value
  if (!vs.length) return ''
  const W = 600, H = 110
  const step = W / Math.max(vs.length - 1, 1)
  return 'M' + vs.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / 100) * H).toFixed(1)}`).join(' L')
}

const rideRanks = computed(() => [...store.rides].sort((a, b) => b.rev - a.rev).slice(0, 8))
const maxRideRev = computed(() => Math.max(...rideRanks.value.map(r => r.rev), 1))
</script>

<template>
  <div class="reports">
    <div class="rgrid">
      <div class="card donut-card">
        <h3>💵 收入构成</h3>
        <div class="donut-wrap">
          <svg viewBox="0 0 180 180" class="donut">
            <circle cx="90" cy="90" r="62" fill="none" stroke="#202846" stroke-width="30"/>
            <circle v-for="s in incomeSeg" :key="s.key" cx="90" cy="90" r="62" fill="none"
              :stroke="s.color" stroke-width="30"
              stroke-dasharray="389.4" :stroke-dashoffset="s.off" transform="rotate(-90 90 90)" stroke-linecap="butt"/>
          </svg>
          <div class="center"><b>¥{{ (totalIncome / 1000).toFixed(1) }}k</b><em class="muted">总收入</em></div>
        </div>
        <div class="leg">
          <div v-for="s in incomeSeg" :key="s.key">
            <span class="sw" :style="{ background: s.color }"></span>{{ s.key }} <b>{{ s.pct }}%</b>
          </div>
        </div>
      </div>

      <div class="card donut-card">
        <h3>💸 支出构成</h3>
        <div class="donut-wrap">
          <svg viewBox="0 0 180 180" class="donut">
            <circle cx="90" cy="90" r="62" fill="none" stroke="#202846" stroke-width="30"/>
            <circle v-for="s in expenseSeg" :key="s.key" cx="90" cy="90" r="62" fill="none"
              :stroke="s.color" stroke-width="30"
              stroke-dasharray="389.4" :stroke-dashoffset="s.off" transform="rotate(-90 90 90)"/>
          </svg>
          <div class="center"><b class="money neg">¥{{ (totalExpense / 1000).toFixed(1) }}k</b><em class="muted">总支出</em></div>
        </div>
        <div class="leg">
          <div v-for="s in expenseSeg" :key="s.key">
            <span class="sw" :style="{ background: s.color }"></span>{{ s.key }} <b>{{ s.pct }}%</b>
          </div>
        </div>
      </div>

      <div class="card chart">
        <h3>😊 游客满意度趋势</h3>
        <svg viewBox="0 0 620 120" preserveAspectRatio="none" class="svg">
          <path d="M0,60 L620,60" stroke="#2a3454" stroke-width="1"/>
          <path d="M0,24 L620,24" stroke="#202846" stroke-width="1"/>
          <path d="M0,96 L620,96" stroke="#202846" stroke-width="1"/>
          <path :d="satPath()" fill="none" stroke="var(--blue)" stroke-width="2.6" stroke-linecap="round"/>
        </svg>
        <div class="axis"><span>100</span><span>60</span><span>0</span></div>
      </div>
    </div>

    <div class="card">
      <h3>🏅 设施营收排行榜</h3>
      <div class="rank" v-for="(r, i) in rideRanks" :key="r.id">
        <span class="no">{{ i + 1 }}</span>
        <div class="rname"><b>{{ r.name }}</b><em class="muted">{{ r.type }} · 累计游玩 {{ r.play_count }}</em></div>
        <div class="rbar"><i :style="{ width: (r.rev / maxRideRev) * 100 + '%', background: colors[i % colors.length] }"></i></div>
        <b class="money">¥{{ r.rev.toLocaleString() }}</b>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reports { display: flex; flex-direction: column; gap: 16px; }
.rgrid { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 16px; }
@media (max-width: 1000px) { .rgrid { grid-template-columns: 1fr; } }
.donut-wrap { position: relative; width: 180px; margin: 6px auto; }
.donut { width: 180px; height: 180px; }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.center b { font-size: 22px; }
.center em { font-style: normal; font-size: 12px; }
.leg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 12px; font-size: 12px; }
.leg div { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.leg b { color: var(--text); margin-left: auto; }
.sw { width: 10px; height: 10px; border-radius: 3px; }
.svg { width: 100%; height: 120px; }
.axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; }
.rank { display: grid; grid-template-columns: 30px 1.2fr 2fr 90px; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.rank .no { width: 24px; height: 24px; background: var(--accent2); color: #000; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
.rname b { display: block; }
.rname em { font-style: normal; font-size: 11px; }
.rbar { height: 12px; background: var(--panel2); border-radius: 6px; overflow: hidden; }
.rbar i { display: block; height: 100%; border-radius: 6px; }
</style>