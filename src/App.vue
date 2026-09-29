<script setup>
import { ref, onMounted } from 'vue'
import { useParkStore } from '@/store/park'
import DashboardView from '@/components/DashboardView.vue'
import ZoneMapView from '@/components/ZoneMapView.vue'
import RidesView from '@/components/RidesView.vue'
import VendorsView from '@/components/VendorsView.vue'
import StaffView from '@/components/StaffView.vue'
import SchedulingView from '@/components/SchedulingView.vue'
import TicketView from '@/components/TicketView.vue'
import MembersView from '@/components/MembersView.vue'
import ReservationsView from '@/components/ReservationsView.vue'
import GroupsView from '@/components/GroupsView.vue'
import EventsView from '@/components/EventsView.vue'
import ComplaintsView from '@/components/ComplaintsView.vue'
import ReportsView from '@/components/ReportsView.vue'

const store = useParkStore()
const view = ref('dashboard')

const navs = [
  { k: 'dashboard', icon: '📊', label: '总览' },
  { k: 'zones', icon: '🗺️', label: '园区地图' },
  { k: 'rides', icon: '🎢', label: '游乐设施' },
  { k: 'vendors', icon: '🏪', label: '商铺' },
  { k: 'staff', icon: '👷', label: '员工管理' },
  { k: 'scheduling', icon: '🗓️', label: '排班工时' },
  { k: 'ticket', icon: '🎫', label: '票务定价' },
  { k: 'members', icon: '💎', label: '会员权益' },
  { k: 'reservations', icon: '📅', label: '预约调度' },
  { k: 'groups', icon: '🧑‍✈️', label: '领队组团' },
  { k: 'events', icon: '🎆', label: '活动事件' },
  { k: 'complaints', icon: '🗂️', label: '投诉补救' },
  { k: 'reports', icon: '📈', label: '经营报表' }
]

const evolve = setInterval(() => store.refresh(), 2000)
onMounted(store.refresh)
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <span class="logo">🎡</span>
        <div>
          <b>奇妙乐园</b>
          <em class="muted">ThemePark Tycoon</em>
        </div>
      </div>
      <nav>
        <button v-for="n in navs" :key="n.k" class="navitem" :class="{ on: view === n.k }" @click="view = n.k">
          <span>{{ n.icon }}</span>{{ n.label }}
        </button>
      </nav>
      <div class="clock card">
        <div class="chip">第 {{ store.clock.day }} 天</div>
        <div class="big">{{ store.clock.hour }}:00</div>
        <div class="muted">园区营业中</div>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <div class="la">
          <h2>{{ navs.find(n => n.k === view)?.label }}</h2>
          <span class="halo" v-if="store.activeEvents.length">{{ store.activeEvents.length }} 个待处理事件</span>
          <span class="halo red" v-if="store.complaintStats.open">{{ store.complaintStats.open }} 条投诉待处置</span>
          <span class="halo" v-if="store.maintenanceStats.queued">🛠️ {{ store.maintenanceStats.queued }} 张检修工单待接单</span>
          <span class="halo" v-if="store.schedulingStats.pendingRequests">🗓️ {{ store.schedulingStats.pendingRequests }} 个调班/加班待审批</span>
          <span class="halo red" v-if="store.schedulingStats.absentToday">❌ {{ store.schedulingStats.absentToday }} 人今日旷工</span>
          <span class="halo" v-if="store.schedulingStats.coverageBlocks">⛔ {{ store.schedulingStats.coverageBlocks }} 项关键岗位缺岗</span>
          <span class="halo" v-if="store.reservationStats.oversoldPending">⚠️ {{ store.reservationStats.oversoldPending }} 个超售时段待消化</span>
          <span class="halo" v-if="store.groupStats.pending">🧑‍✈️ {{ store.groupStats.pending }} 个团队待确认</span>
          <span class="halo red" v-if="store.groupStats.interrupted">🚧 {{ store.groupStats.interrupted }} 段团队行程停运待处置</span>
          <span class="halo" v-if="store.memberStats.expiring">💳 {{ store.memberStats.expiring }} 张会员卡即将到期</span>
        </div>
        <div class="stats">
          <div class="pill">💰 <b :class="store.data && store.data.cash < 0 ? 'neg money' : 'money'">{{ store.data?.cash?.toLocaleString() ?? 0 }}</b></div>
          <div class="pill" :class="{ 'debt-warn': store.debt.overdueCount }" v-if="store.debt.remainPrincipal">🏦 负债 <b class="money neg">{{ store.debt.remainPrincipal.toLocaleString() }}</b><em v-if="store.debt.overdueCount">（逾期 ¥{{ store.debt.arrears.toLocaleString() }}）</em></div>
          <div class="pill">⭐ 声誉 <b>{{ store.data?.reputation ?? 0 }}</b></div>
          <div class="pill">😊 满意度 <b>{{ Math.round(store.data?.avgs?.satisfaction ?? 0) }}</b></div>
          <div class="pill">🎫 今日入园 <b>{{ store.data?.visitorToday ?? 0 }}</b></div>
        </div>
      </header>
      <section class="views">
        <DashboardView v-if="view === 'dashboard'" />
        <ZoneMapView v-else-if="view === 'zones'" />
        <RidesView v-else-if="view === 'rides'" />
        <VendorsView v-else-if="view === 'vendors'" />
        <StaffView v-else-if="view === 'staff'" />
        <SchedulingView v-else-if="view === 'scheduling'" />
        <TicketView v-else-if="view === 'ticket'" />
        <MembersView v-else-if="view === 'members'" />
        <ReservationsView v-else-if="view === 'reservations'" />
        <GroupsView v-else-if="view === 'groups'" />
        <EventsView v-else-if="view === 'events'" />
        <ComplaintsView v-else-if="view === 'complaints'" />
        <ReportsView v-else />
      </section>
    </main>
  </div>
</template>

<style scoped>
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 225px; flex-shrink: 0; padding: 18px 14px;
  background: rgba(15,20,38,.8); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 14px; position: sticky; top: 0; height: 100vh;
}
.brand { display: flex; gap: 10px; align-items: center; padding: 4px 6px; }
.brand .logo { font-size: 30px; }
.brand b { font-size: 17px; display: block; }
.brand em { font-style: normal; font-size: 11px; }
nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.navitem {
  display: flex; align-items: center; gap: 10px; text-align: left; width: 100%;
  background: transparent; border: 1px solid transparent; color: var(--muted); font-size: 14px; padding: 10px 12px;
}
.navitem:hover { background: var(--panel); color: var(--text); }
.navitem.on { background: linear-gradient(135deg, rgba(255,107,107,.18), rgba(255,107,107,.05)); border-color: rgba(255,107,107,.4); color: var(--accent); }
.clock { text-align: center; }
.clock .chip { font-size: 12px; background: var(--accent); color: #fff; border-radius: 20px; padding: 2px 10px; display: inline-block; margin-bottom: 6px; }
.clock .big { font-size: 30px; font-weight: 800; letter-spacing: 1px; }
main { flex: 1; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; border-bottom: 1px solid var(--border); background: rgba(15,20,38,.6); position: sticky; top:0; z-index: 20; backdrop-filter: blur(6px); }
.topbar .la { display: flex; align-items: center; gap: 12px; }
.halo { font-size: 12px; background: rgba(255,209,102,.2); color: var(--accent2); border: 1px solid rgba(255,209,102,.4); padding: 2px 10px; border-radius: 20px; }
.halo.red { background: rgba(255,107,107,.18); color: var(--red); border-color: rgba(255,107,107,.45); }
.stats { display: flex; gap: 12px; flex-wrap: wrap; }
.pill { font-size: 13px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); padding: 6px 12px; border-radius: 20px; }
.pill b { color: var(--text); margin-left: 4px; }
.pill em { font-style: normal; color: #ff8080; margin-left: 4px; }
.pill.debt-warn { border-color: rgba(255,80,80,.55); background: rgba(255,80,80,.12); }
</style>