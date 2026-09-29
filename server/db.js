import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 可用 PARK_DB_PATH 覆盖（测试传 ':memory:' 隔离真实库）
const DB_PATH = process.env.PARK_DB_PATH || join(__dirname, 'park.db')

const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  theme TEXT NOT NULL,           -- 奇幻/冒险/水上/未来/儿童
  unlocked INTEGER NOT NULL DEFAULT 1,
  capacity INTEGER NOT NULL DEFAULT 200,
  cleanliness INTEGER NOT NULL DEFAULT 80,  -- 清洁度 0-100
  scenery INTEGER NOT NULL DEFAULT 60,      -- 景观值 0-100
  open INTEGER NOT NULL DEFAULT 1,
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 过山车/旋转木马/摩天轮/跳楼机/水上漂流/碰碰车/海盗船/云霄飞车
  zone_id INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'operating', -- operating/maintenance/closed
  capacity INTEGER NOT NULL DEFAULT 20,     -- 单轮载客
  cycle_min REAL NOT NULL DEFAULT 5,        -- 运行周期(游戏分钟)
  build_cost INTEGER NOT NULL DEFAULT 5000,
  run_cost INTEGER NOT NULL DEFAULT 60,     -- 每施工时段运行成本
  thrill INTEGER NOT NULL DEFAULT 50,       -- 刺激度
  attr REAL NOT NULL DEFAULT 60,            -- 游客吸引度
  health REAL NOT NULL DEFAULT 100,         -- 健康度 0-100
  queue INTEGER NOT NULL DEFAULT 0,
  price INTEGER NOT NULL DEFAULT 30,
  play_count INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,           -- 累计收入
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 餐饮/纪念品/饮品
  zone_id INTEGER NOT NULL DEFAULT 1,
  rent INTEGER NOT NULL DEFAULT 800,
  margin REAL NOT NULL DEFAULT 0.6,
  price INTEGER NOT NULL DEFAULT 25,
  sold INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  staff_id INTEGER,
  pos_row INTEGER NOT NULL DEFAULT 0,
  pos_col INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL,            -- 保安/保洁/维修/员工管理员
  zone_id INTEGER NOT NULL DEFAULT 1,
  wage INTEGER NOT NULL DEFAULT 300,
  skill INTEGER NOT NULL DEFAULT 1,
  morale INTEGER NOT NULL DEFAULT 80,      -- 满意度 0-100
  active INTEGER NOT NULL DEFAULT 1,
  assigned_ride_id INTEGER
);

CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,        -- 该时段入园人数
  satisfaction REAL NOT NULL DEFAULT 70,
  eat REAL NOT NULL DEFAULT 40,  -- 人均消费期望
  total_spend INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  label TEXT NOT NULL,           -- 门票/游乐/餐饮/纪念品/工资/租金/运营/消费/建设/升级/扩建/活动/贷款/利息
  amount INTEGER NOT NULL,       -- 正负(贷款正数=放款/本金返还，负数=偿还本金；利息负数=付息/罚息)
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal INTEGER NOT NULL,        -- 借款本金
  rate REAL NOT NULL,                -- 每期(每日)利率
  periods INTEGER NOT NULL,          -- 总期数(天)
  installment INTEGER NOT NULL,      -- 每期等额本息应还
  remain_principal INTEGER NOT NULL, -- 剩余本金(含已到期未还的本金)
  paid_periods INTEGER NOT NULL DEFAULT 0,
  arrears_p INTEGER NOT NULL DEFAULT 0, -- 逾期挂账本金
  arrears_i INTEGER NOT NULL DEFAULT 0, -- 逾期挂账利息(含罚息)
  overdue_days INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active/done
  start_day INTEGER NOT NULL,
  created_tick INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  impact INTEGER NOT NULL DEFAULT 0,  -- 影响力影响声誉/客流
  status TEXT NOT NULL DEFAULT 'active', -- active/resolved
  feedback TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',             -- 投诉单号 TS0001
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  category TEXT NOT NULL,                    -- queue/hygiene/facility/safety/food/service/pricing/missing
  severity INTEGER NOT NULL DEFAULT 1,       -- 1 一般 / 2 严重 / 3 紧急
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',      -- ride/vendor/zone
  target_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',       -- open/processing/ready/closed_resolved/closed_force/closed_timeout
  assignee_id INTEGER,                       -- 受理员工
  progress REAL NOT NULL DEFAULT 0,          -- 处置进度 0-100
  deadline_tick INTEGER NOT NULL,            -- 限时处置截止时刻(tick=游戏小时)
  escalated INTEGER NOT NULL DEFAULT 0,      -- 是否经历过升级
  escalations INTEGER NOT NULL DEFAULT 0,
  compensation TEXT NOT NULL DEFAULT '',     -- apology/ticket/fastpass/voucher/cash
  comp_cost INTEGER NOT NULL DEFAULT 0,
  rating INTEGER NOT NULL DEFAULT 0,         -- 游客结案评价 1-5
  close_reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'guest',      -- guest 游客自发 / manual 前台登记
  resolved_tick INTEGER NOT NULL DEFAULT 0,  -- 现场处置完成(待确认补偿)时刻
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS complaint_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,                      -- submit/assign/ready/resolve/escalate/auto_escalate/unassign/force/timeout
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaint_logs_cid ON complaint_logs(complaint_id);

-- 分时预约库存：scope=entry 为入园时段（ride_id 恒 NULL），scope=ride 为设施分时时段
CREATE TABLE IF NOT EXISTS reservation_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                 -- entry / ride
  ride_id INTEGER,                     -- entry 时段为 NULL
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  capacity INTEGER NOT NULL,           -- 时段容量（运营可调）
  oversell INTEGER NOT NULL DEFAULT 0, -- 超售余量（爽约率对冲，运营可调）
  booked_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  noshow_count INTEGER NOT NULL DEFAULT 0,
  refund_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'  -- open / closed
);
-- NULL 在 UNIQUE 中互不相等，entry/ride 各建部分唯一索引保证同一时段只有一条库存
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_entry ON reservation_slots(day,hour) WHERE scope='entry';
CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_ride ON reservation_slots(ride_id,day,hour) WHERE scope='ride';

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',        -- 预约号 YY0001
  guest_name TEXT NOT NULL DEFAULT '游客',
  guest_phone TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,                  -- entry / ride
  ride_id INTEGER,
  slot_id INTEGER,
  slot_day INTEGER NOT NULL,
  slot_hour INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,       -- 人数
  amount INTEGER NOT NULL DEFAULT 0,   -- 预收款（下单时即收取，现金制）
  status TEXT NOT NULL DEFAULT 'booked',-- booked/checked/noshow/refunded/refunded_half
  reason TEXT NOT NULL DEFAULT '',      -- guest/late/park/overbook/noshow
  source TEXT NOT NULL DEFAULT 'guest', -- guest 游客端 / auto 模拟客流 / manual 前台
  reschedules INTEGER NOT NULL DEFAULT 0,
  refund_amount INTEGER NOT NULL DEFAULT 0, -- 已退金额（退款留痕，幂等重放/对账用）
  refund_fee INTEGER NOT NULL DEFAULT 0,    -- 退款手续费（当日取消扣 50%）
  created_tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  checked_tick INTEGER NOT NULL DEFAULT 0,
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reservations_slot ON reservations(slot_day,slot_hour,status);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);

CREATE TABLE IF NOT EXISTS reservation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,  -- create/auto_book/checkin/reschedule/auto_reschedule/noshow/cancel/refund/split
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reservation_logs_rid ON reservation_logs(reservation_id);

-- 设施检修工单：报修后进入排队，维修员工接单后按游戏时间推进，支持转派与离岗接续
CREATE TABLE IF NOT EXISTS maintenance_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',           -- 工单号 WX0001
  ride_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued 排队待接单 / processing 检修中 / done 已完工 / cancelled 已撤销
  source TEXT NOT NULL DEFAULT 'manual',   -- manual 人工报修 / auto 故障自动停运 / system 兼容既有检修状态补建
  assignee_id INTEGER,                     -- 接单维修员工
  progress REAL NOT NULL DEFAULT 0,        -- 检修进度 0-100，按游戏小时推进
  cost INTEGER NOT NULL DEFAULT 0,         -- 检修费用（报修时按健康度核定，完工结算入账）
  create_tick INTEGER NOT NULL,
  create_day INTEGER NOT NULL,
  start_tick INTEGER NOT NULL DEFAULT 0,   -- 最近一次接单/转派到手时刻
  completed_tick INTEGER NOT NULL DEFAULT 0,
  completed_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_maint_ride ON maintenance_orders(ride_id);
CREATE INDEX IF NOT EXISTS idx_maint_status ON maintenance_orders(status);
CREATE INDEX IF NOT EXISTS idx_maint_assignee ON maintenance_orders(assignee_id);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,                    -- create/assign/transfer/release/complete/cancel
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_maint_logs_oid ON maintenance_logs(order_id);

-- 幂等请求键：同一 scope+key 的重复请求（双击/重试/网络重发）直接返回首次执行结果，不产生重复副作用
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,           -- create / cancel / reschedule / checkin / member_card / member_redeem
  key TEXT NOT NULL,             -- 客户端请求号（UUID）
  response TEXT NOT NULL,        -- 首次执行结果快照（JSON）
  created_tick INTEGER NOT NULL DEFAULT 0,
  created_day INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idem_scope_key ON idempotency_keys(scope,key);

-- ---------------- 游客会员与权益中心 ----------------
-- 会员卡商品（运营可配置：银卡/金卡/钻石卡，价格、有效期、折扣、积分倍率、开卡赠权益）
CREATE TABLE IF NOT EXISTS card_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tier TEXT NOT NULL UNIQUE,        -- silver/gold/diamond（无卡普通会员 tier=none，不在此表）
  name TEXT NOT NULL,
  price INTEGER NOT NULL,           -- 购卡价（¥）
  valid_days INTEGER NOT NULL,      -- 有效期（游戏日）
  point_mul REAL NOT NULL DEFAULT 1,-- 积分倍率
  discount_entry REAL NOT NULL DEFAULT 1,  -- 入园门票折扣（1=不打折，0.9=9 折）
  discount_ride REAL NOT NULL DEFAULT 1,   -- 设施票价折扣
  discount_vendor REAL NOT NULL DEFAULT 1, -- 商铺消费折扣
  give_ticket INTEGER NOT NULL DEFAULT 0,  -- 开卡赠免票券
  give_voucher INTEGER NOT NULL DEFAULT 0, -- 开卡赠消费券（张，每张面额 voucher_face）
  give_fastpass INTEGER NOT NULL DEFAULT 0,-- 开卡赠快速通行券
  bonus_points INTEGER NOT NULL DEFAULT 0, -- 开卡赠送积分
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 会员档案（注册即普通会员 none；购卡/升级/到期驱动 card_tier 与状态流转）
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',          -- 会员号 HY0001
  name TEXT NOT NULL DEFAULT '游客',
  phone TEXT NOT NULL DEFAULT '',
  card_tier TEXT NOT NULL DEFAULT 'none', -- none/silver/gold/diamond
  status TEXT NOT NULL DEFAULT 'active',  -- active/frozen/expired（到期由日结扫描置 expired）
  points INTEGER NOT NULL DEFAULT 0,      -- 当前可用积分
  total_points INTEGER NOT NULL DEFAULT 0,-- 累计获得积分
  balance INTEGER NOT NULL DEFAULT 0,     -- 储值余额（¥，充值为负债，消费才确认收入）
  card_expire_day INTEGER NOT NULL DEFAULT 0, -- 会员卡到期游戏日（0=无卡）
  join_day INTEGER NOT NULL,
  owner_staff_id INTEGER,                 -- 归属运营人员（会员专员）
  created_tick INTEGER NOT NULL DEFAULT 0,
  last_active_tick INTEGER NOT NULL DEFAULT 0
);
-- 空手机号允许多条（散客现场注册），仅对非空手机号唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_phone ON members(phone) WHERE phone IS NOT NULL AND phone<>'';
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status, card_tier);

-- 购卡/续费/升级订单（财务入账与对账留痕）
CREATE TABLE IF NOT EXISTS member_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',          -- HK0001
  member_id INTEGER NOT NULL,
  type TEXT NOT NULL,                     -- new/renew/upgrade
  tier TEXT NOT NULL,
  price INTEGER NOT NULL,
  staff_id INTEGER,
  day INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_morders_member ON member_orders(member_id);

-- 积分账户流水（获取/消费/回退/调整/过期，逐条可对账）
CREATE TABLE IF NOT EXISTS member_point_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  change INTEGER NOT NULL,                -- 正=获取，负=消费/回退
  balance_after INTEGER NOT NULL,
  source TEXT NOT NULL,                   -- card/entry/ride/vendor/redeem/refund/adjust/expire/comp
  ref_type TEXT NOT NULL DEFAULT '',      -- reservation/vendor/order/complaint/benefit
  ref_id INTEGER,
  day INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mpoints_member ON member_point_logs(member_id);

-- 积分兑换商品（运营可配置：储值/消费券/免票券/快速通行券）
CREATE TABLE IF NOT EXISTS benefit_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,       -- balance/voucher/ticket/fastpass
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- balance/voucher/ticket/fastpass
  points_cost INTEGER NOT NULL,    -- 兑换所需积分
  amount INTEGER NOT NULL DEFAULT 0, -- balance/voucher 的面额（¥）；券类为 0
  qty INTEGER NOT NULL DEFAULT 1,  -- 单次兑换发放数量
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 会员权益账户（开卡赠送 / 积分兑换所得，逐条核销与退还）
CREATE TABLE IF NOT EXISTS member_benefits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- balance/voucher/ticket/fastpass
  source TEXT NOT NULL,             -- card/redeem
  ref_id INTEGER,                  -- 来源订单/兑换记录
  amount INTEGER NOT NULL DEFAULT 0,-- 储值/消费券面额（¥）
  status TEXT NOT NULL DEFAULT 'unused', -- unused/used/expired/refunded
  expire_day INTEGER NOT NULL DEFAULT 0, -- 到期游戏日（0=随卡；券类固定有效期）
  used_tick INTEGER NOT NULL DEFAULT 0,
  used_ref_type TEXT NOT NULL DEFAULT '', -- reservation/vendor
  used_ref_id INTEGER,
  created_tick INTEGER NOT NULL DEFAULT 0,
  created_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mbenefits_member ON member_benefits(member_id, status);

-- 会员生命周期时间线（注册/购卡/续费/升级/冻结/解冻/到期/兑换/充值/调整）
CREATE TABLE IF NOT EXISTS member_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,             -- register/card/renew/upgrade/freeze/unfreeze/expire/redeem/topup/adjust/ticket/vendor
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mlogs_member ON member_logs(member_id);

-- ---------------- 员工排班与工时结算 ----------------
-- 班次模板：运营主管可配置；跨日夜班 cross_day=1（如 17:00~次日09:00）
CREATE TABLE IF NOT EXISTS shift_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,        -- morning/mid/evening/night
  name TEXT NOT NULL,
  start_hour INTEGER NOT NULL,
  end_hour INTEGER NOT NULL,
  cross_day INTEGER NOT NULL DEFAULT 0, -- 下班是否跨到次日
  standard_hours REAL NOT NULL DEFAULT 5, -- 结算基准工时（跨日夜班含闭园时段，按基准工时计薪）
  color TEXT NOT NULL DEFAULT '#66a6ff',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

-- 排班单：员工 × 游戏日 × 班次；status scheduled/swap/cancelled
CREATE TABLE IF NOT EXISTS staff_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',     -- PB0001
  staff_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  day INTEGER NOT NULL,              -- 上班所属游戏日（跨日夜班归当日）
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled 已排 / swap 调班中 / cancelled 已取消
  source TEXT NOT NULL DEFAULT 'manual', -- manual 主管手排 / auto 基础自动补位 / dispatch 动态调度按缺口补位
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
-- 同一员工同一游戏日只允许一个有效（非取消）排班
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_staff_day ON staff_schedules(staff_id,day) WHERE status<>'cancelled';
CREATE INDEX IF NOT EXISTS idx_sched_day ON staff_schedules(day,status);
CREATE INDEX IF NOT EXISTS idx_sched_shift ON staff_schedules(shift_id);

-- 考勤工时单：上班自动生成，离岗/完工回写，下班自动结算入工资财务（跨日夜班次日闭园结算）
CREATE TABLE IF NOT EXISTS staff_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',     -- KQ0001
  schedule_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  day INTEGER NOT NULL,              -- 排班所属游戏日（结算日：非跨日=当日，跨日=次日）
  shift_id INTEGER NOT NULL,
  cross_day INTEGER NOT NULL DEFAULT 0,
  checkin_tick INTEGER NOT NULL DEFAULT 0,  -- 实际上班时刻（线性游戏小时）
  checkout_tick INTEGER NOT NULL DEFAULT 0, -- 实际下班时刻；0=在岗未下班
  work_ticks INTEGER NOT NULL DEFAULT 0,    -- 已出勤游戏小时数（随引擎每小时累计）
  status TEXT NOT NULL DEFAULT 'checked_in', -- checked_in 在岗 / checked_out 已结算 / absent 旷工 / leave 离岗
  late INTEGER NOT NULL DEFAULT 0,          -- 是否迟到（调班/加班后上班晚于班次开始）
  overtime_ticks INTEGER NOT NULL DEFAULT 0,-- 已批加班小时数（1.5 倍时薪）
  ot_approved INTEGER NOT NULL DEFAULT 0,   -- 加班申请是否已主管审批
  leave_tick INTEGER NOT NULL DEFAULT 0,    -- 离岗时刻（非下班离岗）
  satisfaction_delta INTEGER NOT NULL DEFAULT 0, -- 本班满意度变动（完工回写/迟到/旷工/离岗累计）
  pay INTEGER NOT NULL DEFAULT 0,           -- 结算工资（基准工时+加班，实际进工资财务流水）
  settle_day INTEGER NOT NULL DEFAULT 0,    -- 实际结算游戏日
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_att_sched ON staff_attendance(schedule_id);
CREATE INDEX IF NOT EXISTS idx_att_staff_day ON staff_attendance(staff_id,day);
CREATE INDEX IF NOT EXISTS idx_att_status ON staff_attendance(status);

-- 调班 / 加班协作申请：员工发起，运营主管审批
CREATE TABLE IF NOT EXISTS shift_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',     -- TB0001
  kind TEXT NOT NULL,                -- swap 调班 / overtime 加班
  staff_id INTEGER NOT NULL,
  schedule_id INTEGER,               -- 关联排班（调班原排班 / 加班当值排班）
  day INTEGER NOT NULL,
  -- 调班：目标同事与目标班次（可换日换班）；加班：当前班次延后下班时长
  target_staff_id INTEGER,
  target_shift_id INTEGER,
  target_day INTEGER,
  ot_ticks INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending 待批 / approved 已批 / rejected 驳回 / cancelled 已取消
  source TEXT NOT NULL DEFAULT 'staff',    -- staff 员工发起 / dispatch 系统紧急加班调令（动态调度生成）
  approver_id INTEGER,
  create_tick INTEGER NOT NULL DEFAULT 0,
  create_day INTEGER NOT NULL DEFAULT 0,
  handle_tick INTEGER NOT NULL DEFAULT 0,
  handle_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_freq_status ON shift_requests(status,kind);
CREATE INDEX IF NOT EXISTS idx_freq_staff ON shift_requests(staff_id);

-- 排班 / 考勤 / 调班全生命周期时间线
CREATE TABLE IF NOT EXISTS shift_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER,
  attendance_id INTEGER,
  request_id INTEGER,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL, -- schedule/autofill/cancel/checkin/late/leave/checkout/absent/swap_request/swap_approve/swap_reject/ot_request/ot_approve/ot_reject
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER,
  approver_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shiftlogs_sched ON shift_logs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_shiftlogs_att ON shift_logs(attendance_id);
CREATE INDEX IF NOT EXISTS idx_shiftlogs_req ON shift_logs(request_id);

-- ---------------- 领队组团：入园 + 多设施行程团队预约 ----------------
-- 团单：领队提交（pending）→ 运营确认锁定名额并收订金（confirmed）→ 分批核销/尾款结算 → 完成/爽约结案/取消
CREATE TABLE IF NOT EXISTS group_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',            -- 团号 TU0001
  leader_name TEXT NOT NULL,                -- 领队姓名
  leader_phone TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL,                     -- 团队总人数
  visit_day INTEGER NOT NULL,               -- 入园游戏日
  entry_hour INTEGER NOT NULL,              -- 入园时段
  status TEXT NOT NULL DEFAULT 'pending',   -- pending/confirmed/settled/completed/cancelled/rejected/closed_noshow
  total_amount INTEGER NOT NULL DEFAULT 0,      -- 应收原额（提交时按牌价核定）
  receivable_amount INTEGER NOT NULL DEFAULT 0, -- 当前应收（部分退团/园方退一程逐额冲减）
  deposit_rate REAL NOT NULL DEFAULT 0.3,       -- 订金比例
  deposit_amount INTEGER NOT NULL DEFAULT 0,    -- 已收订金
  paid_balance INTEGER NOT NULL DEFAULT 0,      -- 已收尾款（可分批）
  refunded_amount INTEGER NOT NULL DEFAULT 0,   -- 已现金退还领队金额
  fee_amount INTEGER NOT NULL DEFAULT 0,        -- 没收/手续费累计（爽约、当日退团）
  source TEXT NOT NULL DEFAULT 'leader',        -- leader 领队端 / auto 模拟团
  note TEXT NOT NULL DEFAULT '',
  created_tick INTEGER NOT NULL,
  created_day INTEGER NOT NULL,
  confirm_tick INTEGER NOT NULL DEFAULT 0,
  closed_tick INTEGER NOT NULL DEFAULT 0,
  closed_day INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_groups_status ON group_orders(status);
CREATE INDEX IF NOT EXISTS idx_groups_day ON group_orders(visit_day);

-- 团行程明细：1 条入园 + N 条设施；锁定后一一对应 source='group' 的预约单（0 元，款项走团账）
CREATE TABLE IF NOT EXISTS group_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- entry 入园 / ride 设施
  ride_id INTEGER,                          -- entry 为 NULL
  slot_id INTEGER,                          -- 锁定后关联的分时库存
  slot_day INTEGER NOT NULL,
  slot_hour INTEGER NOT NULL,
  qty INTEGER NOT NULL,                     -- 该程总人数
  unit_price INTEGER NOT NULL DEFAULT 0,   -- 单人牌价（提交时快照）
  amount INTEGER NOT NULL DEFAULT 0,       -- 该程应收 = qty*unit_price
  checked_qty INTEGER NOT NULL DEFAULT 0,  -- 已分批核销人数
  refunded_qty INTEGER NOT NULL DEFAULT 0, -- 已退团/停运退款人数
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/active/interrupted/rerouted/refund_park/refund_guest/noshow/checked
  reservation_id INTEGER,                  -- 关联 reservations.id（重排停运时可能换单）
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gitems_group ON group_items(group_id);
CREATE INDEX IF NOT EXISTS idx_gitems_status ON group_items(status);

-- 团账务流水：订金/尾款/退款/没收逐笔留痕，供财务对账
CREATE TABLE IF NOT EXISTS group_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- deposit/balance/refund_park/refund_guest/fee/noshow
  amount INTEGER NOT NULL,                  -- 正=向领队收款，负=退还给领队（fee/noshow 为没收收入，记正）
  day INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gpay_group ON group_payments(group_id);

-- 分批核销批次（闸机/设施口逐批放行，每批一条）
CREATE TABLE IF NOT EXISTS group_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',    -- manual 人工 / auto 引擎自动
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gcheckin_group ON group_checkins(group_id);

-- 团生命周期时间线（提交/确认/收订金/核销批次/退团/重排/停运/退款/爽约结案）
CREATE TABLE IF NOT EXISTS group_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  staff_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_glog_group ON group_logs(group_id);
`)

// ---------- 轻量列迁移（兼容老库） ----------
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
}
// 退款金额/手续费留痕：幂等重放与财务对账
ensureColumn('reservations', 'refund_amount', "refund_amount INTEGER NOT NULL DEFAULT 0")
ensureColumn('reservations', 'refund_fee', "refund_fee INTEGER NOT NULL DEFAULT 0")
// 会员联动：下单会员、支付使用的权益（免票券/快速通行券）、实付积分获取留痕
ensureColumn('reservations', 'member_id', "member_id INTEGER")
ensureColumn('reservations', 'benefit_id', "benefit_id INTEGER")
// 投诉联动：会员本人投诉，可积分补偿结案
ensureColumn('complaints', 'member_id', "member_id INTEGER")
// 动态调度：排班/申请来源（manual/auto/dispatch；staff/dispatch）
ensureColumn('staff_schedules', 'source', "source TEXT NOT NULL DEFAULT 'manual'")
ensureColumn('shift_requests', 'source', "source TEXT NOT NULL DEFAULT 'staff'")
// 领队组团：source='group' 的预约单关联团行程明细 id（款项走团账，该预约 amount 恒为 0）
ensureColumn('reservations', 'group_item_id', "group_item_id INTEGER")

// ---------- 事务 ----------
// 多步写入（库存/订单/现金/流水/日志）必须原子提交：任一步失败整体回滚，不留半完成状态。
// 嵌套调用并入外层事务（node:sqlite 单连接同步执行，靠深度计数避免嵌套 BEGIN 报错）。
let txDepth = 0
function tx(fn) {
  if (txDepth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  txDepth++
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 连接已回滚时忽略 */ }
    throw e
  } finally {
    txDepth--
  }
}

const now = () => new Date().toISOString()

// ---------- 种子数据 ----------
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k)
  return r ? r.value : d
}
const setSetting = (k, v) => {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v))
}

function seed() {
  const c = db.prepare('SELECT COUNT(*) n FROM zones').get().n
  if (c > 0) return

  // 初始经营参数
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('ticket', 120)
  setSetting('reputation', 70)
  setSetting('cash', 200000)
  setSetting('guestBase', 600)
  setSetting('wordOfMouth', 0)   // 投诉补救口碑 -10 ~ +10，回流影响客流与满意度

  const iz = db.prepare('INSERT INTO zones(name,theme,unlocked,capacity,cleanliness,scenery,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
  const zones = [
    ['奇幻山谷', '奇幻', 1, 300, 85, 70, 1, 1],
    ['冒险岛', '冒险', 1, 260, 70, 65, 3, 1],
    ['未来世界', '未来', 0, 220, 60, 55, 1, 3],
    ['水上乐园', '水上', 0, 250, 75, 60, 3, 3],
    ['儿童王国', '儿童', 1, 180, 90, 75, 1, 2],
    ['美食广场', '美食', 1, 150, 85, 60, 3, 2]
  ]
  zones.forEach(z => iz.run(...z))
  const zoneMap = { 奇幻山谷: 1, 冒险岛: 2, 未来世界: 3, 水上乐园: 4, 儿童王国: 5, 美食广场: 6 }

  const ir = db.prepare('INSERT INTO rides(name,type,zone_id,status,capacity,cycle_min,build_cost,run_cost,thrill,attr,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const rides = [
    ['极速飞车', '过山车', 2, 'operating', 32, 6, 60000, 260, 92, 88, 60, 2, 2],
    ['旋转木马', '旋转木马', 5, 'operating', 40, 4, 20000, 70, 15, 75, 20, 2, 3],
    ['摩天轮', '摩天轮', 1, 'operating', 24, 12, 45000, 150, 45, 85, 45, 1, 3],
    ['跳楼机', '跳楼机', 2, 'operating', 20, 8, 35000, 130, 88, 80, 55, 3, 2],
    ['碰碰车', '碰碰车', 5, 'operating', 12, 5, 26000, 95, 60, 82, 35, 3, 3],
    ['海盗船', '海盗船', 2, 'operating', 30, 7, 38000, 140, 78, 84, 50, 4, 1],
    ['激流勇进', '水上漂流', 2, 'operating', 28, 9, 42000, 160, 82, 86, 55, 4, 2]
  ]
  rides.forEach(r => ir.run(...r))

  const iv = db.prepare('INSERT INTO vendors(name,type,zone_id,rent,margin,price,pos_row,pos_col) VALUES(?,?,?,?,?,?,?,?)')
  const vendors = [
    ['爆米花小屋', '餐饮', 1, 900, 0.65, 28, 1, 4],
    ['纪念品旗舰店', '纪念品', 1, 1200, 0.7, 55, 1, 5],
    ['冰爽柠檬饮', '饮品', 5, 600, 0.72, 18, 2, 4],
    ['热狗快餐厅', '餐饮', 6, 1000, 0.62, 32, 4, 3],
    ['玩具总动员', '纪念品', 5, 900, 0.68, 45, 4, 4]
  ]
  vendors.forEach(v => iv.run(...v))

  const is = db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,assigned_ride_id) VALUES(?,?,?,?,?,?,?)')
  const staff = [
    ['张伟', '保安', 1, 320, 1, 85, null],
    ['李娜', '保洁', 1, 300, 1, 88, null],
    ['王强', '维修', 2, 380, 2, 78, 1],
    ['赵敏', '维修', 2, 360, 1, 80, 2],
    ['陈杰', '安保', 3, 320, 1, 82, null],
    ['刘洋', '保洁', 3, 300, 1, 79, null],
    ['孙莉', '会员专员', 1, 340, 2, 90, null],
    ['周涛', '会员专员', 1, 340, 1, 84, null],
    ['林岚', '运营主管', 1, 420, 2, 86, null]
  ]
  staff.forEach(s => is.run(...s))

  // 启动期财务记录（昨日）
  const nf = new Date().toISOString()
  const parseFinance = `INSERT OR IGNORE INTO settings(key,value) VALUES('seed_finance','1')`
  const f = db.prepare('INSERT INTO finance(tick,day,label,amount,detail) VALUES(?,?,?,?,?)')
  const pre = db.prepare('SELECT COUNT(*) n FROM finance').get().n
  if (pre === 0) {
    f.run(0, 0, '门票', 72000, '昨日门票收入')
    f.run(0, 0, '游乐', 48000, '昨日游乐设施收入')
    f.run(0, 0, '餐饮', 18000, '昨日餐饮收入')
    f.run(0, 0, '纪念品', 15000, '昨日纪念品收入')
    f.run(0, 0, '工资', -26000, '昨日工资支出')
    f.run(0, 0, '维护', -9000, '昨日设施维护')
  }

  // ---------- 会员与权益中心：卡种 / 积分商品 / 全局参数 / 示例会员 ----------
  const setIf = (k, v) => {
    if (!getSetting(k)) setSetting(k, String(v))
  }
  setIf('memberEnabled', 1)                // 会员体系开关（运营可停用）
  setIf('pointRate', 1)                    // 每 ¥10 实付 = 1 积分（再乘会员卡倍率）
  setIf('pointsComp', 300)                 // 投诉积分补偿档：结案赠送积分
  setIf('voucherFace', 30)                 // 消费券面额（¥）
  setIf('benefitValidDays', 30)            // 兑换/赠送券类权益有效期（游戏日）

  const ic = db.prepare(`INSERT OR IGNORE INTO card_products
      (tier,name,price,valid_days,point_mul,discount_entry,discount_ride,discount_vendor,give_ticket,give_voucher,give_fastpass,bonus_points,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const cards = [
    ['silver', '银卡', 299, 30, 1.2, 0.95, 0.95, 0.98, 0, 1, 0, 50, 1],
    ['gold', '金卡', 699, 60, 1.5, 0.9, 0.9, 0.95, 1, 2, 1, 150, 2],
    ['diamond', '钻石卡', 1299, 90, 2, 0.85, 0.85, 0.9, 2, 4, 2, 300, 3]
  ]
  cards.forEach(c => ic.run(...c))

  const ib = db.prepare(`INSERT OR IGNORE INTO benefit_products(code,name,kind,points_cost,amount,qty,sort)
      VALUES (?,?,?,?,?,?,?)`)
  const benefits = [
    ['balance', '储值 ¥30', 'balance', 500, 30, 1, 1],
    ['voucher', '消费券 ¥30', 'voucher', 300, 30, 1, 2],
    ['ticket', '免票券 ×1', 'ticket', 800, 0, 1, 3],
    ['fastpass', '快速通行券 ×1', 'fastpass', 200, 0, 1, 4]
  ]
  benefits.forEach(b => ib.run(...b))

  // ---------- 排班与工时结算：班次模板（含跨日夜班，用于跨日结算） ----------
  const ish = db.prepare(`INSERT OR IGNORE INTO shift_templates
      (code,name,start_hour,end_hour,cross_day,standard_hours,color,sort)
      VALUES (?,?,?,?,?,?,?,?)`)
  const shifts = [
    ['morning', '早班', 9, 14, 0, 5, '#66a6ff', 1],
    ['mid', '中班', 12, 17, 0, 5, '#6dd5a0', 2],
    ['evening', '晚班', 14, 18, 0, 4, '#a78bfa', 3],
    ['night', '夜班', 17, 9, 1, 6, '#ff9e64', 4]   // 跨日夜班：当日 17:00 至次日 09:00
  ]
  shifts.forEach(s => ish.run(...s))
  setIf('scheduleAutoFill', 1)            // 自动补位开关（引擎按需求为未来三天补齐缺口）
  setIf('scheduleMode', 'dynamic')        // dynamic 动态调度（按客流/工单/投诉）；auto 全员基础补位
  setIf('otRateMul', 1.5)                 // 加班时薪倍率
  setIf('dispatchGuardFlow', 500)         // 每名保安班段可承载的预约预测客流
  setIf('dispatchCleanFlow', 700)         // 每名保洁班段可承载的预约预测客流
  setIf('dispatchNightGuardsPerZone', 0)  // 夜勤保安区域配比（0=不强制）
  setIf('groupDepositRate', 0.3)          // 团队订金比例（运营确认时锁定名额并收取）
  setIf('groupEnabled', 1)                // 领队组团模块开关

  // 示例会员（新库首日建立；含一名金卡会员便于演示等级与权益流转）
  if (db.prepare('SELECT COUNT(*) n FROM members').get().n === 0) {
    const im = db.prepare(`INSERT INTO members(code,name,phone,card_tier,status,points,total_points,balance,card_expire_day,join_day,owner_staff_id,created_tick,last_active_tick)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const demo = [
      ['HY0001', '王小雨', '13800000001', 'gold', 'active', 420, 1180, 120, 45, 1, 7, 0, 0],
      ['HY0002', '李大壮', '13800000002', 'silver', 'active', 80, 260, 0, 20, 1, 8, 0, 0],
      ['HY0003', '陈小星', '', 'none', 'active', 15, 15, 0, 0, 1, null, 0, 0]
    ]
    demo.forEach(m => im.run(...m))

    // 示例购卡订单 + 开卡权益（与卡种配置一致，随卡有效期）
    const imo = db.prepare(`INSERT INTO member_orders(code,member_id,type,tier,price,staff_id,day,tick,note)
      VALUES(?,?,?,?,?,?,?,0,?)`)
    const iben = db.prepare(`INSERT INTO member_benefits(member_id,kind,source,ref_id,amount,status,expire_day,created_tick,created_day)
      VALUES(?,?,?,?,?,'unused',?,0,1)`)
    const ipl = db.prepare(`INSERT INTO member_point_logs(member_id,change,balance_after,source,ref_type,ref_id,day,tick,note)
      VALUES(?,?,?,?,?,?,1,0,?)`)
    const iml = db.prepare(`INSERT INTO member_logs(member_id,tick,day,hour,action,note,staff_id) VALUES(?,0,1,9,?,?,?)`)
    // 金卡（会员1）：¥699，60 天到第 60 天（示例设到期日 45），1 免票券 + 2 消费券 + 1 FP，150 开卡分
    let oid = Number(imo.run('HK0001', 1, 'new', 'gold', 699, 7, 1, '购买金卡').lastInsertRowid)
    iben.run(1, 'ticket', 'card', oid, 0, 45)
    iben.run(1, 'voucher', 'card', oid, 30, 45)
    iben.run(1, 'voucher', 'card', oid, 30, 45)
    iben.run(1, 'fastpass', 'card', oid, 0, 45)
    ipl.run(1, 150, 150, 'card', 'order', oid, '购买金卡赠送积分')
    iml.run(1, 'card', '购买金卡，赠免票券×1、消费券×2、快速通行券×1、150 积分', 7)
    // 银卡（会员2）：¥299，1 消费券，50 开卡分，到期日 20
    oid = Number(imo.run('HK0002', 2, 'new', 'silver', 299, 8, 1, '购买银卡').lastInsertRowid)
    iben.run(2, 'voucher', 'card', oid, 30, 20)
    ipl.run(2, 50, 50, 'card', 'order', oid, '购买银卡赠送积分')
    iml.run(2, 'card', '购买银卡，赠消费券×1、50 积分', 8)
    iml.run(3, 'register', '前台注册会员', null)
    iml.run(1, 'register', '前台注册会员', 7)
    iml.run(2, 'register', '前台注册会员', 8)
  }
}
seed()

// ---------- 老库兼容：幂等补齐排班模块基础数据（班次模板 / 运营主管 / 模块参数） ----------
function ensureScheduleBaseData() {
  const hasShifts = db.prepare('SELECT COUNT(*) n FROM shift_templates').get().n
  if (!hasShifts) {
    const ish = db.prepare(`INSERT INTO shift_templates
        (code,name,start_hour,end_hour,cross_day,standard_hours,color,sort)
        VALUES (?,?,?,?,?,?,?,?)`)
    ;[
      ['morning', '早班', 9, 14, 0, 5, '#66a6ff', 1],
      ['mid', '中班', 12, 17, 0, 5, '#6dd5a0', 2],
      ['evening', '晚班', 14, 18, 0, 4, '#a78bfa', 3],
      ['night', '夜班', 17, 9, 1, 6, '#ff9e64', 4]
    ].forEach(s => ish.run(...s))
  }
  if (!db.prepare("SELECT COUNT(*) n FROM staff WHERE role='运营主管'").get().n) {
    db.prepare('INSERT INTO staff(name,role,zone_id,wage,skill,morale,active) VALUES(?,?,?,?,?,?,?)')
      .run('林岚', '运营主管', 1, 420, 2, 80, 1)
  }
  for (const [k, v] of [
    ['scheduleAutoFill', 1],       // 自动补位总开关
    ['scheduleMode', 'dynamic'],   // auto=全员基础补位；dynamic=按客流/工单/投诉需求动态调度
    ['otRateMul', 1.5],
    // 动态调度参数：每个保安/保洁可承载的预约预测客流（人/班段）；夜班每个开放区域保安数
    ['dispatchGuardFlow', 500],
    ['dispatchCleanFlow', 700],
    ['dispatchNightGuardsPerZone', 0],  // 0=夜班不强制（按需动态补）；>0 时每 N 个区域至少 1 名夜勤保安
    ['groupDepositRate', 0.3],          // 团队订金比例
    ['groupEnabled', 1]                 // 领队组团模块开关
  ]) {
    if (!getSetting(k)) setSetting(k, String(v))
  }
}
ensureScheduleBaseData()

export default db
export { now, getSetting, setSetting, tx }