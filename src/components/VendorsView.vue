<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const buildOpen = ref(false)
const build = ref({ type: '餐饮', zone_id: 1, name: '' })
const types = ['餐饮', '纪念品', '饮品']

const list = computed(() => store.vendors)
const typeIcon = t => ({ '餐饮':'🍔', '饮品':'🥤', '纪念品':'🎁' }[t])

function submit() {
  store.buildVendor({ ...build.value, name: build.value.name || `新${build.value.type}摊` })
  buildOpen.value = false
  build.value.name = ''
}
</script>

<template>
  <div class="vendors">
    <div class="bar">
      <span class="gm">累计商铺营收：<b class="money">{{ store.vendors.reduce((s,v)=>s+v.rev,0).toLocaleString() }}</b></span>
      <button class="primary" @click="buildOpen = true">＋ 开设商铺</button>
    </div>

    <div class="cards">
      <div class="vcard card" v-for="v in list" :key="v.id">
        <div class="vhead">
          <span class="big-ic">{{ typeIcon(v.type) }}</span>
          <div>
            <b>{{ v.name }}</b>
            <em class="muted">{{ v.type }} · {{ store.zones.find(z=>z.id===v.zone_id)?.name }}</em>
          </div>
          <button class="ghost danger" @click="store.delVendor(v.id)">✕</button>
        </div>
        <div class="vmeta">
          <div><em>单价</em><b class="money">{{ v.price }}</b></div>
          <div><em>毛利率</em><b>{{ Math.round(v.margin*100) }}%</b></div>
          <div><em>月租</em><b class="money neg">{{ v.rent }}</b></div>
        </div>
        <div class="vbottom">
          <span class="muted">累计售出 {{ v.sold }} 件</span><span class="money">¥{{ v.rev.toLocaleString() }}</span>
        </div>
        <div class="vprice">
          <input type="range" min="10" max="120" v-model.number="v.price" @change="store.updateVendor(v.id,{price:v.price})" />
          <span class="muted">时价 {{ v.price }}</span>
        </div>
      </div>
    </div>

    <div class="modal" v-if="buildOpen">
      <div class="modal-box card">
        <h3>🏪 开设新商铺</h3>
        <div class="form">
          <label>商铺类型
            <select v-model="build.type"><option v-for="t in types" :key="t" :value="t">{{ t }}</option></select>
          </label>
          <label>所属区域
            <select v-model.number="build.zone_id"><option v-for="z in store.zones.filter(z=>z.unlocked)" :key="z.id" :value="z.id">{{ z.name }}</option></select>
          </label>
          <label>名称 <input v-model="build.name" placeholder="留空自动命名" /></label>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">确认开店</button>
          <button class="ghost" @click="buildOpen=false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vendors { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.gm { font-size: 13px; color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; }
.vhead { display: flex; align-items: center; gap: 10px; }
.big-ic { font-size: 34px; }
.vhead b { display: block; }
.vhead em { font-style: normal; font-size: 12px; }
.vhead .ghost { margin-left: auto; }
.vmeta { display: flex; gap: 8px; margin: 12px 0; }
.vmeta div { background: var(--panel2); flex: 1; text-align: center; border-radius: 8px; padding: 8px; }
.vmeta em { display: block; font-style: normal; font-size: 11px; color: var(--muted); }
.vmeta b { font-size: 16px; }
.vbottom { display: flex; justify-content: space-between; font-size: 13px; }
.vprice { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.vprice input { flex: 1; accent-color: var(--accent); }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { width: min(420px, 92vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.acts { display: flex; gap: 8px; }
</style>