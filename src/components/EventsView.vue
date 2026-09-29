<script setup>
import { ref } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()

const activity = ref({ type: '烟火', title: '', budget: 8000, desc: '' })
const types = [
  { k: '烟火', icon: '🎆', desc: '夜晚烟花表演，大幅拉动声誉与客流', budget: 10000, min: 5000 },
  { k: '花车巡游', icon: '🎉', desc: '主题花车巡游，提升游客满意度', budget: 8000, min: 4000 },
  { k: '怀旧折扣日', icon: '🏷️', desc: '门票折扣吸引客流，回馈游客', budget: 6000, min: 3000 },
  { k: '音乐节', icon: '🎤', desc: '现场音乐节，年轻游客聚集', budget: 12000, min: 6000 }
]
const typeMeta = t => types.find(x => x.k === t)

const evIcon = t => ({ '烟火':'🎆','花车巡游':'🎉','怀旧折扣日':'🏷️','音乐节':'🎤','weather':'🌧️','crowd':'👥','fault':'⚠️','maintenance':'🛠️','celebrity':'🌟','protest':'📣','fever':'🔥','overdue':'🏦','complaint':'📮' }[t] || '📌')

function submit() {
  const m = typeMeta(activity.value.type)
  store.planEvent({ ...activity.value, title: activity.value.title || activity.value.type, budget: activity.value.budget || m.min })
  activity.value = { type: '烟火', title: '', budget: 8000, desc: '' }
}

function resolve(e) { store.resolveEvent(e.id) }

const sortedEvents = () => [...store.events].sort((a, b) => b.id - a.id)
</script>

<template>
  <div class="events">
    <div class="planner card">
      <h3>🗓️ 策划园区活动</h3>
      <div class="atype">
        <button v-for="t in types" :key="t.k" :class="{ on: activity.type === t.k }" @click="activity.type = t.k">
          <span class="big-ic">{{ t.icon }}</span><b>{{ t.k }}</b><em>{{ t.desc }}</em>
        </button>
      </div>
      <div class="afields">
        <label>活动标题 <input v-model="activity.title" :placeholder="activity.type" /></label>
        <label>预算　<span class="muted">¥{{ activity.budget }}</span>
          <input type="range" :min="typeMeta(activity.type).min" max="30000" step="500" v-model.number="activity.budget" />
        </label>
      </div>
      <button class="primary" @click="submit">举办活动 · 预算 ¥{{ activity.budget.toLocaleString() }}</button>
    </div>

    <div class="events-l">
      <div class="card">
        <h3>🚨 待处理事件 <span class="tag" v-if="store.activeEvents.length">{{ store.activeEvents.length }}</span></h3>
        <div class="elist" v-if="store.activeEvents.length">
          <div v-for="e in store.activeEvents" :key="e.id" class="ev" :class="e.impact > 0 ? 'good' : 'bad'">
            <div class="evh">
              <span class="big-ic">{{ evIcon(e.type) }}</span>
              <div>
                <b>{{ e.title }}</b>
                <p class="muted">{{ e.desc }}</p>
              </div>
              <button class="ghost" @click="resolve(e)">{{ e.impact > 0 ? '收益已入账' : '立即处置' }}</button>
            </div>
          </div>
        </div>
        <div class="muted empty" v-else>当前无待处理事件，园区平稳运行 ✅</div>
      </div>

      <div class="card">
        <h3>📜 事件历史</h3>
        <div class="hist" v-for="e in sortedEvents()" :key="e.id">
          <span class="h-ic">{{ evIcon(e.type) }}</span>
          <span class="hl"><b>{{ e.title }}</b><em class="muted">第{{ e.day }}天 · {{ e.status === 'active' ? '进行中' : '已了结' }}</em></span>
          <span class="h-impact" :class="e.impact > 0 ? 'good' : 'bad'">{{ e.impact > 0 ? '+' : '' }}{{ e.impact }}</span>
        </div>
        <div class="muted empty" v-if="!store.events.length">暂无事件记录。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.events { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; }
@media (max-width: 960px) { .events { grid-template-columns: 1fr; } }
.atype { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 12px 0; }
.atype button { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 12px 8px; text-align: center; }
.atype button.on { border-color: var(--accent); background: rgba(255,107,107,.12); }
.atype .big-ic { font-size: 26px; }
.atype em { font-style: normal; font-size: 11px; color: var(--muted); }
.type { }
.afields { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.afields label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.planner .primary { width: 100%; padding: 11px; font-size: 15px; }
.events-l { display: flex; flex-direction: column; gap: 16px; }
.elist { display: flex; flex-direction: column; gap: 10px; }
.ev { border-radius: 10px; padding: 12px; border: 1px solid var(--border); }
.ev.good { border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.07); }
.ev.bad { border-color: rgba(255,107,107,.45); background: rgba(255,107,107,.07); }
.evh { display: flex; gap: 12px; align-items: flex-start; }
.evh .big-ic { font-size: 24px; }
.evh p { font-size: 12px; margin-top: 4px; }
.evh .ghost { margin-left: auto; white-space: nowrap; }
.hist { display: flex; align-items: center; gap: 10px; padding: 8px; border-bottom: 1px solid var(--border); font-size: 13px; }
.hl b { display: block; }
.hl em { font-style: normal; font-size: 11px; }
.h-impact { margin-left: auto; font-weight: 700; }
.h-impact.good { color: var(--green); }
.h-impact.bad { color: var(--red); }
.empty { padding: 16px; text-align: center; }
</style>