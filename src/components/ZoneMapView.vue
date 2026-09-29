<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const selected = ref(null)
const showBuild = ref(false)

const themeColor = t => ({
  '奇幻': '#a78bfa', '冒险': '#ff6b6b', '未来': '#66a6ff',
  '水上': '#4fc3f7', '儿童': '#ffd166', '美食': '#6dd5a0'
}[t] || '#888')

const grid = computed(() => {
  const cells = []
  const zones = store.zones
  for (const z of zones) {
    cells.push({
      z,
      rides: store.rides.filter(r => r.zone_id === z.id),
      vendors: store.vendors.filter(v => v.zone_id === z.id)
    })
  }
  return cells
})

const selRide = computed(() => selected.value ? store.rides.find(r => r.id === selected.value.r && selected.value.k === 'ride') : null)
const selVendor = computed(() => selected.value ? store.vendors.find(v => v.id === selected.value.r && selected.value.k === 'vendor') : null)
</script>

<template>
  <div class="map">
    <div class="legend">
      <span class="muted">图例：</span>
      <span v-for="z in store.zones" :key="z.id" class="lg" :style="{ borderColor: themeColor(z.theme) }">{{ z.name }}</span>
    </div>

    <div class="map-grid">
      <div v-for="c in grid" :key="c.z.id" class="zone card"
           :style="{ borderColor: themeColor(c.z.theme), opacity: c.z.open ? 1 : .55 }">
        <div class="zhead">
          <b>{{ c.z.open ? c.z.name : '🔒 ' + c.z.name }}</b>
          <span class="tag" :style="{ color: themeColor(c.z.theme), borderColor: themeColor(c.z.theme) }">{{ c.z.theme }}</span>
        </div>
        <div class="zmeta muted">清洁 {{ c.z.cleanliness }} · 景观 {{ c.z.scenery }} · 容量 {{ c.z.capacity }}</div>
        <div class="cleanbar"><i :style="{ width: c.z.cleanliness + '%', background: c.z.cleanliness > 60 ? 'var(--green)' : c.z.cleanliness > 40 ? 'var(--accent2)' : 'var(--red)' }"></i></div>

        <div class="items">
          <button v-for="r in c.rides" :key="r.id" class="pin" :class="r.status" @click="selected = { k:'ride', r:r.id }">
            <span class="pi" :style="{ background: themeColor(c.z.theme) }">{{ r.type === '过山车' ? '🎢' : r.type === '摩天轮' ? '🎡' : r.type === '水上漂流' ? '💦' : '🎠' }}</span>
            <b>{{ r.name }}</b>
            <em class="muted">{{ r.status === 'operating' ? '运营中' : r.status === 'maintenance' ? '检修中' : '已关闭' }}</em>
          </button>
          <button v-for="v in c.vendors" :key="v.id" class="pin vendor" @click="selected = { k:'vendor', r:v.id }">
            <span class="pi">{{ v.type === '餐饮' ? '🍔' : v.type === '饮品' ? '🥤' : '🎁' }}</span>
            <b>{{ v.name }}</b>
            <em class="muted">{{ v.type }}</em>
          </button>
        </div>

        <div class="zfoot">
          <button class="ghost" @click="c.z.unlocked ? (selected={k:'zone',r:c.z.id,zone:c.z,color:themeColor(c.z.theme)}) : store.unlock(c.z.id)">
            {{ c.z.unlocked ? '查看区域' : '扩建此区 8万' }}
          </button>
          <button class="ghost" v-if="c.z.unlocked" @click="c.z.open ? store.updateZone(c.z.id,{open:0}) : store.updateZone(c.z.id,{open:1})">
            {{ c.z.open ? '关园' : '开园' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 设施详情弹窗 -->
    <div class="modal" v-if="selRide">
      <div class="modal-box card">
        <h3>{{ selRide.type }} · {{ selRide.name }}</h3>
        <div class="mh">
          <div><em class="muted">健康度</em><b>{{ selRide.health }}</b></div>
          <div><em class="muted">刺激度</em><b>{{ selRide.thrill }}</b></div>
          <div><em class="muted">单车票价</em><b class="money">{{ selRide.price }}</b></div>
          <div><em class="muted">累计营收</em><b class="money">{{ selRide.rev.toLocaleString() }}</b></div>
        </div>
        <div class="mh">
          <div><em class="muted">排队人数</em><b>{{ selRide.queue }}</b></div>
          <div><em class="muted">累计游玩</em><b>{{ selRide.play_count }}</b></div>
          <div><em class="muted">每日运营成本</em><b class="money neg">{{ selRide.run_cost }}</b></div>
        </div>
        <div class="acts">
          <button v-if="!selRide.maint_status" :class="selRide.status==='operating'?'danger':''" @click="store.updateRide(selRide.id,{status: selRide.status==='operating'?'closed':'operating'})">
            {{ selRide.status === 'operating' ? '关闭' : '重新开放' }}
          </button>
          <button v-if="selRide.maint_status" disabled>检修工单进行中</button>
          <button v-if="selRide.status !== 'operating' && !selRide.maint_status" @click="store.updateRide(selRide.id,{repair:1})">报修检修</button>
          <button @click="store.updateRide(selRide.id,{upgrade:10})">升级刺激度(3万)</button>
          <button @click="store.delRide(selRide.id)">拆除</button>
          <button class="ghost" @click="selected=null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 商铺详情 -->
    <div class="modal" v-if="selVendor">
      <div class="modal-box card">
        <h3>{{ selVendor.type }} · {{ selVendor.name }}</h3>
        <div class="mh">
          <div><em class="muted">单价</em><b class="money">{{ selVendor.price }}</b></div>
          <div><em class="muted">毛利率</em><b>{{ Math.round(selVendor.margin*100) }}%</b></div>
          <div><em class="muted">月租</em><b class="money neg">{{ selVendor.rent }}</b></div>
          <div><em class="muted">累计销量</em><b>{{ selVendor.sold }}</b></div>
        </div>
        <div class="acts">
          <button @click="store.delVendor(selVendor.id)">关闭店面</button>
          <button class="ghost" @click="selected=null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.map { display: flex; flex-direction: column; gap: 16px; }
.legend { display: flex; gap: 8px; flex-wrap: wrap; }
.lg { font-size: 12px; border: 2px solid; border-radius: 20px; padding: 2px 10px; }
.map-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.zone { border-width: 2px; }
.zhead { display: flex; justify-content: space-between; align-items: center; }
.zhead b { font-size: 16px; }
.zmeta { font-size: 12px; margin: 8px 0 6px; }
.cleanbar { height: 6px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
.cleanbar i { display: block; height: 100%; transition: .4s; }
.items { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.pin { display: flex; flex-direction: column; align-items: center; gap: 3px; width: 84px; padding: 8px 4px; }
.pin b { font-size: 11px; }
.pin em { font-style: normal; font-size: 10px; }
.pi { width: 34px; height: 34px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
.pin.vendor .pi { background: var(--panel2); }
.pin.maintenance { outline: 1px dashed var(--accent2); }
.pin.closed { opacity: .5; }
.zfoot { display: flex; gap: 6px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(460px, 92vw); }
.mh { display: flex; gap: 10px; margin: 12px 0; flex-wrap: wrap; }
.mh div { background: var(--panel2); border-radius: 10px; padding: 10px 14px; flex: 1; min-width: 90px; text-align: center; }
.mh em { display: block; font-style: normal; font-size: 11px; }
.mh b { font-size: 20px; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
</style>