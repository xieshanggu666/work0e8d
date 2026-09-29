<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const hireOpen = ref(false)
const names = ['周明','吴磊','郑爽','冯强','梁静','许文','何琳','高翔','罗勇','唐悦','韩雪','沈飞']

const roles = [
  { k: '保安', icon: '🛡️', desc: '维护秩序，减少拥挤投诉' },
  { k: '保洁', icon: '🧹', desc: '维持区域清洁度' },
  { k: '维修', icon: '🛠️', desc: '负责设施检修' },
  { k: '会员专员', icon: '💎', desc: '购卡接待与会员归属运营' },
  { k: '运营主管', icon: '🧑‍💼', desc: '排班、调班/加班审批与岗位覆盖' }
]

const roleDesc = k => roles.find(r => r.k === k)?.desc

const wageSum = computed(() => store.staff.filter(s => s.active).reduce((a, b) => a + b.wage, 0))

function hire() {
  const role = roles[Math.floor(Math.random() * roles.length)].k
  store.hire({ name: names[Math.floor(Math.random() * names.length)], role, zone_id: 1 })
  hireOpen.value = false
}
</script>

<template>
  <div class="staff">
    <div class="bar">
      <span class="gm">在岗 {{ store.staff.filter(s=>s.active).length }} 人 · 日薪合计 <b class="money neg">¥{{ wageSum }}</b></span>
      <button class="primary" @click="hireOpen = true">＋ 招聘员工</button>
    </div>

    <div class="role-intro">
      <div class="card" v-for="r in roles" :key="r.k">
        <span class="big-ic">{{ r.icon }}</span>
        <b>{{ r.k }}</b>
        <em class="muted">{{ r.desc }}</em>
      </div>
    </div>

    <div class="table card">
      <div class="thead">
        <span>员工</span><span>岗位</span><span>区域</span><span>技能</span><span>满意度</span><span>日薪</span><span>状态</span><span>操作</span>
      </div>
      <div class="trow" v-for="s in store.staff" :key="s.id">
        <span><b>{{ s.name }}</b></span>
        <span>{{ roleDesc(s.role) }}</span>
        <span>
          <select :value="s.zone_id" @change="store.updateStaff(s.id,{zone_id:+$event.target.value})">
            <option v-for="z in store.zones" :key="z.id" :value="z.id">{{ z.name }}</option>
          </select>
        </span>
        <span>Lv.{{ s.skill }}</span>
        <span><div class="hb"><i :style="{width:s.morale+'%',background:s.morale>60?'var(--green)':s.morale>40?'var(--accent2)':'var(--red)'}"></i></div>{{ s.morale }}</span>
        <span class="money neg">¥{{ s.wage }}</span>
        <span>
          <i class="dot" :class="s.active?'on':'off'"></i>{{ s.active ? '在岗' : '已辞退' }}
          <em class="load" v-if="s.active && s.role==='维修'">{{ s.maint_load ? `🔧 检修中 ×${s.maint_load}` : '空闲可接单' }}</em>
        </span>
        <span>
          <button class="ghost" @click="s.active ? store.updateStaff(s.id,{active:0}) : store.updateStaff(s.id,{active:1})">{{ s.active ? '解雇' : '返聘' }}</button>
        </span>
      </div>
      <div class="muted empty" v-if="!store.staff.length">暂无员工，点击右上角招聘。</div>
    </div>
  </div>
</template>

<style scoped>
.staff { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.gm { font-size: 13px; color: var(--muted); }
.role-intro { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
.role-intro .card { display: flex; align-items: center; gap: 10px; }
.role-intro .big-ic { font-size: 26px; }
.role-intro em { font-style: normal; font-size: 12px; margin-left: auto; text-align: right; }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: 1fr 1.2fr 1.4fr .6fr 1fr .7fr .8fr .8fr; gap: 8px; align-items: center; padding: 10px 12px; font-size: 13px; min-width: 760px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.hb { width: 80px; height: 7px; background: var(--panel2); border-radius: 4px; overflow: hidden; display: inline-block; margin-right: 6px; vertical-align: middle; }
.hb i { display: block; height: 100%; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
.dot.on { background: var(--green); }
.dot.off { background: var(--red); }
.load { display: block; font-size: 11px; color: var(--accent2); margin-top: 3px; font-style: normal; }
.empty { padding: 16px; text-align: center; }
</style>