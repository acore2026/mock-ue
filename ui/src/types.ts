export type StrategyName =
  | 'no_optimization'
  | 'standard_gbr'
  | 'dynamic_qos'

export type DemoRuntimeMode = 'real' | 'playback'

export type DemoUserStatus =
  | 'planned'
  | 'idle'
  | 'running'
  | 'good'
  | 'delayed'
  | 'high'
  | 'failed'

export type DemoTreatment = 'public' | 'reserved' | 'temporary_grant'

export interface DemoCounters {
  planned_users: number
  active_users: number
  protected_users: number
  temporary_grants: number
  good_users: number
  delayed_users: number
  high_users: number
  failed_users: number
  idle_users: number
}

export interface DemoBandwidth {
  total_rate_mbps: number
  public_rate_mbps: number
  optimized_rate_mbps: number
}

export interface DemoScenario {
  strategy: StrategyName
  clients: number
  upload_bytes: number
  interval_ms: number
  duration_s: number
  total_rate_mbps: number
}

export interface DemoUser {
  client_id: string
  client_ip: string
  index: number
  status: DemoUserStatus
  treatment: DemoTreatment
  online?: boolean
  active: boolean
  running: boolean
  uploading?: boolean
  upload_started_at?: string
  attempts: number
  last_latency_ms?: number
  last_seen?: string
}

export interface DemoState {
  strategy: StrategyName
  runtime_mode: DemoRuntimeMode
  running: boolean
  prepared_at: string
  initial_users: number
  ramp_per_second: number
  bandwidth: DemoBandwidth
  counters: DemoCounters
  scenario: DemoScenario
  users: DemoUser[]
}

export interface UploadResult {
  id: string
  attempt: number
  success: boolean
  latency_ms: number
  phase_ms: number
  at: string
}

export interface ResultBatch {
  items: UploadResult[]
  ts: number
}

export type DemoStreamEventType =
  | 'snapshot'
  | 'result_batch'
  | 'heartbeat'
  | 'error'

export interface DemoStreamEvent {
  type: DemoStreamEventType
  at: string
  state?: DemoState
  results?: ResultBatch
  message?: string
}
