import { memo, startTransition, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Clock3,
  Gauge,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Shield,
  Sparkles,
  StopCircle,
  Wifi,
  XCircle,
} from 'lucide-react'
import {
  fetchDemoState,
  prepareDemoSession,
  resetDemoRun,
  spawnDemoUsers,
  startDemoRun,
  stopDemoRun,
  subscribeDemoStream,
} from './api'
import type { DemoStreamStatus } from './api'
import type { DemoState, DemoStreamEvent, DemoUser, DemoUserStatus, StrategyName, UploadResult } from './types'
import './App.css'

const strategies: Array<{ label: string; value: StrategyName; short: string; tone: 'sky' | 'rose' | 'violet' }> = [
  { label: 'No Optimization', value: 'no_optimization', short: 'Best-effort only', tone: 'rose' },
  { label: 'Standard GBR', value: 'standard_gbr', short: 'Static protection', tone: 'sky' },
  { label: 'Dynamic QoS', value: 'dynamic_qos', short: 'Adaptive prioritization', tone: 'violet' },
]

type PendingAction = 'prepare' | 'run' | 'spawn' | 'stop' | 'reset' | 'refresh'
type PendingActions = Record<PendingAction, boolean>

const initialPendingState: PendingActions = {
  prepare: false,
  run: false,
  spawn: false,
  stop: false,
  reset: false,
  refresh: false,
}

function App() {
  const liveState = useDemoLiveState()

  return (
    <div className="page-shell">
      <motion.div className="page-frame" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
        <SceneHeader state={liveState.state} loading={liveState.loading} streamStatus={liveState.streamStatus} />

        <div className="page-grid">
          <PresenterRail
            draftStrategy={liveState.draftStrategy}
            appliedStrategy={liveState.state?.strategy}
            state={liveState.state}
            loading={liveState.loading}
            pending={liveState.pending}
            streamStatus={liveState.streamStatus}
            error={liveState.error}
            onDraftStrategyChange={liveState.setDraftStrategy}
            onPrepare={liveState.prepareSession}
            onRun={liveState.startRun}
            onSpawn={liveState.spawnUsers}
            onStop={liveState.stopRun}
            onReset={liveState.resetRun}
            onRefresh={liveState.refreshState}
          />

          <main className="storyboard">
            <HeroPanel state={liveState.state} streamStatus={liveState.streamStatus} />
            <DeviceBoard
              state={liveState.state}
              resultByID={liveState.resultByID}
              latencyHistoryByID={liveState.latencyHistoryByID}
              completionTicks={liveState.completionTicks}
            />
          </main>
        </div>
      </motion.div>
    </div>
  )
}

function useDemoLiveState() {
  const [draftStrategy, setDraftStrategy] = useState<StrategyName>('no_optimization')
  const [state, setState] = useState<DemoState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [streamStatus, setStreamStatus] = useState<DemoStreamStatus>('connecting')
  const [pending, setPending] = useState<PendingActions>(initialPendingState)
  const [completionTicks, setCompletionTicks] = useState<Record<string, number>>({})
  const [resultByID, setResultByID] = useState<Record<string, UploadResult>>({})
  const [latencyHistoryByID, setLatencyHistoryByID] = useState<Record<string, number[]>>({})
  const animationTimersRef = useRef<number[]>([])
  const recordedAttemptsRef = useRef<Record<string, number>>({})

  function setActionPending(action: PendingAction, value: boolean) {
    setPending((current) => {
      if (current[action] === value) {
        return current
      }
      return { ...current, [action]: value }
    })
  }

  function resetSandboxState() {
    for (const timerID of animationTimersRef.current) {
      window.clearTimeout(timerID)
    }
    animationTimersRef.current = []
    recordedAttemptsRef.current = {}
    setCompletionTicks({})
    setResultByID({})
    setLatencyHistoryByID({})
  }

  function applyState(nextState: DemoState | null) {
    if (!nextState) {
      setState(null)
      setDraftStrategy('no_optimization')
      resetSandboxState()
      return
    }

    const appliedStrategy = state?.strategy
    setState(nextState)
    setDraftStrategy((currentDraft) => {
      if (!appliedStrategy || currentDraft === appliedStrategy) {
        return nextState.strategy
      }
      return currentDraft
    })

    if (!nextState.running && nextState.counters.active_users === 0) {
      resetSandboxState()
    }
  }

  async function loadState(options?: { silent?: boolean }) {
    const trackRefresh = !options?.silent
    if (trackRefresh) {
      setLoading(true)
      setActionPending('refresh', true)
    }
    setError(null)
    try {
      const nextState = await fetchDemoState()
      applyState(nextState)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load demo state')
    } finally {
      if (trackRefresh) {
        setLoading(false)
        setActionPending('refresh', false)
      }
    }
  }

  async function runAction(actionName: PendingAction, action: () => Promise<DemoState>, fallback: string) {
    setActionPending(actionName, true)
    setError(null)
    try {
      const nextState = await action()
      applyState(nextState)
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
    } finally {
      setActionPending(actionName, false)
    }
  }

  const loadInitialState = useEffectEvent(() => {
    void loadState()
  })

  useEffect(() => {
    loadInitialState()
  }, [])

  const onStreamEvent = useEffectEvent((event: DemoStreamEvent) => {
    handleStreamEvent(event)
  })

  useEffect(() => subscribeDemoStream(onStreamEvent, setStreamStatus), [])

  useEffect(() => {
    return () => {
      for (const timerID of animationTimersRef.current) {
        window.clearTimeout(timerID)
      }
    }
  }, [])

  function handleStreamEvent(event: DemoStreamEvent) {
    if (event.type === 'error') {
      if (event.message === 'missing_demo_session') {
        startTransition(() => {
          applyState(null)
          setLoading(false)
        })
      }
      return
    }

    if (event.type === 'result_batch' && event.results?.items.length) {
      const items = event.results.items
      const freshItems = items.filter((item) => item.attempt > (recordedAttemptsRef.current[item.id] ?? 0))
      for (const item of freshItems) {
        recordedAttemptsRef.current[item.id] = item.attempt
      }

      startTransition(() => {
        setResultByID((current) => {
          const next = { ...current }
          for (const item of items) {
            next[item.id] = item
          }
          return next
        })

        setLatencyHistoryByID((current) => {
          const next = { ...current }
          for (const item of freshItems) {
            const history = next[item.id] ? [...next[item.id]] : []
            history.push(item.latency_ms)
            next[item.id] = history
          }
          return next
        })
      })

      for (const item of freshItems) {
        const timerID = window.setTimeout(() => {
          setCompletionTicks((current) => ({
            ...current,
            [item.id]: (current[item.id] ?? 0) + 1,
          }))
        }, sporadicAnimationDelay(item))
        animationTimersRef.current.push(timerID)
      }
    }

    if (event.state) {
      const nextState = event.state
      startTransition(() => {
        applyState(nextState)
        setLoading(false)
        setError(null)
      })
    }
  }

  return {
    completionTicks,
    draftStrategy,
    error,
    latencyHistoryByID,
    loading,
    pending,
    resultByID,
    state,
    streamStatus,
    setDraftStrategy,
    prepareSession: () =>
      runAction('prepare', () => prepareDemoSession(draftStrategy), 'Failed to prepare demo session'),
    startRun: () => runAction('run', startDemoRun, 'Failed to start demo run'),
    spawnUsers: () => runAction('spawn', spawnDemoUsers, 'Failed to add users'),
    stopRun: () => runAction('stop', stopDemoRun, 'Failed to stop demo run'),
    resetRun: () => runAction('reset', resetDemoRun, 'Failed to reset demo run'),
    refreshState: () => loadState(),
  }
}

function SceneHeader({
  state,
  loading,
  streamStatus,
}: {
  state: DemoState | null
  loading: boolean
  streamStatus: DemoStreamStatus
}) {
  const scenario = state ? scenarioStyle(state.strategy) : scenarioStyle('no_optimization')
  const liveLabel = state?.running ? 'Live demonstration' : loading ? 'Syncing backend' : 'Prepared view'

  return (
    <header className="scene-header panel panel-glass">
      <div>
        <span className="kicker">QoS simulation demo</span>
        <h1>Real-time uplink experience under three policy models</h1>
        <p>
          Same backend simulation, softer presentation. The page now reads like a presenter surface instead of an ops console.
        </p>
      </div>

      <div className="scene-header-chips">
        <StatusChip icon={<Radio size={15} />} label={liveLabel} tone={state?.running ? 'good' : 'neutral'} />
        <StatusChip
          icon={<Wifi size={15} />}
          label={streamStatus === 'connected' ? 'WebSocket connected' : `WebSocket ${streamStatus}`}
          tone={streamStatus === 'connected' ? 'good' : 'warn'}
        />
        <StatusChip icon={scenario.icon} label={state ? labelForStrategy(state.strategy) : 'No Optimization'} tone={scenario.tone} />
      </div>
    </header>
  )
}

const PresenterRail = memo(function PresenterRail({
  draftStrategy,
  appliedStrategy,
  state,
  loading,
  pending,
  streamStatus,
  error,
  onDraftStrategyChange,
  onPrepare,
  onRun,
  onSpawn,
  onStop,
  onReset,
  onRefresh,
}: {
  draftStrategy: StrategyName
  appliedStrategy?: StrategyName
  state: DemoState | null
  loading: boolean
  pending: PendingActions
  streamStatus: DemoStreamStatus
  error: string | null
  onDraftStrategyChange: (value: StrategyName) => void
  onPrepare: () => Promise<void>
  onRun: () => Promise<void>
  onSpawn: () => Promise<void>
  onStop: () => Promise<void>
  onReset: () => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const hasDraft = Boolean(appliedStrategy && draftStrategy !== appliedStrategy)
  const activeUsers = state?.counters.active_users ?? 0
  const failedUsers = state?.counters.failed_users ?? 0

  return (
    <aside className="presenter-rail">
      <PanelMotion delay={0.05}>
        <section className="panel presenter-card card-blue">
          <div className="panel-head">
            <span className="panel-index">1</span>
            <div>
              <h2>Presenter Controls</h2>
              <p>Select the scenario and steer the run without leaving the main screen.</p>
            </div>
          </div>

          <label className="field-label" htmlFor="strategy-select">
            Strategy
          </label>
          <select
            id="strategy-select"
            className="soft-select"
            value={draftStrategy}
            onChange={(event) => onDraftStrategyChange(event.target.value as StrategyName)}
          >
            {strategies.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <div className="inline-meta">
            <span>{hasDraft ? `Next prepare: ${labelForStrategy(draftStrategy)}` : 'Aligned with current session'}</span>
            <span>{streamStatus === 'connected' ? 'WS live' : `WS ${streamStatus}`}</span>
          </div>

          <div className="action-grid">
            <ActionButton label="Prepare" pendingLabel="Preparing..." onClick={onPrepare} disabled={pending.prepare} />
            <ActionButton
              label="Run"
              pendingLabel="Starting..."
              onClick={onRun}
              disabled={!state || Boolean(state.running) || pending.run}
              icon={<Play size={15} />}
              primary
            />
            <ActionButton
              label="Add 5"
              pendingLabel="Adding..."
              onClick={onSpawn}
              disabled={!state?.running || pending.spawn}
              icon={<Plus size={15} />}
            />
            <ActionButton
              label="Stop"
              pendingLabel="Stopping..."
              onClick={onStop}
              disabled={!state?.running || pending.stop}
              icon={<StopCircle size={15} />}
            />
            <ActionButton
              label="Reset"
              pendingLabel="Resetting..."
              onClick={onReset}
              disabled={!state || pending.reset}
              icon={<RotateCcw size={15} />}
            />
            <ActionButton
              label={loading ? 'Syncing...' : 'Refresh'}
              pendingLabel="Refreshing..."
              onClick={onRefresh}
              disabled={pending.refresh}
              icon={<RefreshCcw size={15} />}
            />
          </div>
        </section>
      </PanelMotion>

      <PanelMotion delay={0.12}>
        <section className="panel presenter-card card-violet">
          <div className="panel-head">
            <span className="panel-index">2</span>
            <div>
              <h2>Live Run Summary</h2>
              <p>The summary stays compact and presenter-friendly while still showing real backend state.</p>
            </div>
          </div>

          <div className="metric-pairs">
            <MetricPair label="Online devices" value={activeUsers} />
            <MetricPair label="Failed uploads" value={failedUsers} tone={failedUsers > 0 ? 'error' : 'neutral'} />
            <MetricPair label="Upload size" value={state ? formatBytes(state.scenario.upload_bytes) : '--'} />
            <MetricPair label="Interval" value={state ? `${state.scenario.interval_ms} ms` : '--'} />
          </div>
        </section>
      </PanelMotion>

      <PanelMotion delay={0.19}>
        <section className="panel presenter-card card-rose">
          <div className="panel-head">
            <span className="panel-index">3</span>
            <div>
              <h2>Run Health</h2>
              <p>Errors and degraded conditions stay visible without pulling focus from the main story.</p>
            </div>
          </div>

          <div className="status-column">
            <StatusChip icon={<Activity size={15} />} label={state?.running ? 'Run active' : 'Run idle'} tone={state?.running ? 'good' : 'neutral'} />
            <StatusChip icon={<Gauge size={15} />} label={state ? `${formatMbps(state.bandwidth.total_rate_mbps)} total budget` : 'No budget loaded'} tone="sky" />
            <StatusChip icon={<Shield size={15} />} label={state ? `${state.counters.protected_users} protected users` : 'No protected users yet'} tone="violet" />
          </div>

          <AnimatePresence>
            {error ? (
              <motion.div
                className="error-banner"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
              >
                <AlertTriangle size={16} />
                <span>{error}</span>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>
      </PanelMotion>
    </aside>
  )
})

function HeroPanel({ state, streamStatus }: { state: DemoState | null; streamStatus: DemoStreamStatus }) {
  const strategy = state?.strategy ?? 'no_optimization'
  const current = scenarioStyle(strategy)

  return (
    <PanelMotion delay={0.1}>
      <section className="panel hero-panel">
        <div className="hero-lead">
          <div>
            <span className="kicker">Current scene</span>
            <h2>{labelForStrategy(strategy)}</h2>
            <p>{current.description}</p>
          </div>

          <div className="hero-badge">
            <div className={`hero-badge-icon tone-${current.tone}`}>{current.icon}</div>
            <div>
              <strong>{state?.running ? 'Simulation live' : 'Ready to present'}</strong>
              <span>{streamStatus === 'connected' ? 'Live state is flowing from the backend' : 'Waiting on the live stream'}</span>
            </div>
          </div>
        </div>

        <div className="hero-scenarios">
          {strategies.map((item, index) => {
            const scenario = scenarioStyle(item.value)
            const active = item.value === strategy
            return (
              <motion.div
                key={item.value}
                className={`scenario-card tone-${scenario.tone} ${active ? 'is-active' : ''}`}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 + index * 0.06 }}
              >
                <div className="scenario-card-head">
                  <span className="scenario-step">{index + 1}</span>
                  <span className="scenario-card-icon">{scenario.icon}</span>
                </div>
                <strong>{item.label}</strong>
                <p>{scenario.caption}</p>
                <div className="scenario-meta">{scenario.expectation}</div>
              </motion.div>
            )
          })}
        </div>

        {state ? (
          <div className="hero-stats">
            <HeroStat label="Good" value={state.counters.good_users} tone="good" icon={<CheckCircle2 size={16} />} />
            <HeroStat label="Delayed" value={state.counters.delayed_users} tone="warn" icon={<Clock3 size={16} />} />
            <HeroStat label="Failed" value={state.counters.failed_users} tone="error" icon={<XCircle size={16} />} />
            <HeroStat label="Dynamic grants" value={state.counters.temporary_grants} tone="violet" icon={<Sparkles size={16} />} />
          </div>
        ) : null}
      </section>
    </PanelMotion>
  )
}

const DeviceBoard = memo(function DeviceBoard({
  state,
  resultByID,
  latencyHistoryByID,
  completionTicks,
}: {
  state: DemoState | null
  resultByID: Record<string, UploadResult>
  latencyHistoryByID: Record<string, number[]>
  completionTicks: Record<string, number>
}) {
  const deferredUsers = useDeferredValue(state?.users ?? [])
  const deferredResultByID = useDeferredValue(resultByID)
  const deferredLatencyHistoryByID = useDeferredValue(latencyHistoryByID)
  const deferredCompletionTicks = useDeferredValue(completionTicks)
  const activeUsers = deferredUsers.filter((user) => user.active)
  const plannedUsers = deferredUsers.length - activeUsers.length

  return (
    <PanelMotion delay={0.16}>
      <section className="panel board-panel">
        <div className="board-header">
          <div>
            <span className="kicker">Live device board</span>
            <h2>UE experience view</h2>
            <p>Real devices, real session state, real latency outcomes. Just presented with less visual noise.</p>
          </div>

          <div className="scene-header-chips">
            <StatusChip icon={<CircleDot size={15} />} label={`${activeUsers.length} online`} tone="sky" />
            <StatusChip icon={<Clock3 size={15} />} label={`${plannedUsers} waiting`} tone="neutral" />
          </div>
        </div>

        {state ? (
          <>
            {plannedUsers > 0 ? (
              <div className="planned-strip">
                <div>
                  <span className="kicker">Pending attach</span>
                  <strong>{plannedUsers} devices are not connected yet</strong>
                </div>
                <span>Cards appear as soon as the PDU session comes up.</span>
              </div>
            ) : null}

            <div className="device-grid">
              {activeUsers.map((user, index) => (
                <DeviceCard
                  key={user.client_id}
                  user={user}
                  latestResult={deferredResultByID[user.client_id]}
                  latencyHistory={deferredLatencyHistoryByID[user.client_id] ?? []}
                  completionTick={deferredCompletionTicks[user.client_id] ?? 0}
                  index={index}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="board-empty">Awaiting real backend state</div>
        )}
      </section>
    </PanelMotion>
  )
})

const DeviceCard = memo(function DeviceCard({
  user,
  latestResult,
  latencyHistory,
  completionTick,
  index,
}: {
  user: DemoUser
  latestResult?: UploadResult
  latencyHistory: number[]
  completionTick: number
  index: number
}) {
  const displayStatus = latestResult ? classifyResultStatus(latestResult) : user.status
  const displayLatencyMS = latestResult?.latency_ms ?? user.last_latency_ms ?? 0
  const p50 = percentile(latencyHistory, 0.5)
  const p99 = percentile(latencyHistory, 0.99)

  return (
    <motion.article
      className={`device-card status-${displayStatus} ${completionTick > 0 ? 'is-complete' : ''}`}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 + (index % 8) * 0.03 }}
    >
      <div className="device-card-head">
        <div>
          <span className="kicker">Device</span>
          <h3>{labelForDevice(user)}</h3>
        </div>

        <div
          className="ue-health-indicator"
          style={
            {
              '--ring': ringPathLength(displayStatus),
              '--ring-color': statusColor(displayStatus),
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <svg className="progress-ring" viewBox="0 0 44 44">
            <circle className="ring-track" cx="22" cy="22" r="17.5" pathLength="1" />
            <circle
              key={`${user.client_id}-${completionTick}`}
              className="ring-value"
              cx="22"
              cy="22"
              r="17.5"
              pathLength="1"
              strokeLinecap="round"
            />
          </svg>
          <span key={`flash-${user.client_id}-${completionTick}`} className="completion-flash" />
          <span className="dot-core" />
        </div>
      </div>

      <div className="device-session">
        <span>PDU Session</span>
        <strong>{pduSessionStatus(user)}</strong>
      </div>

      <div className="latency-strip">
        <LatencyCell label="Last" value={displayLatencyMS} />
        <LatencyCell label="P50" value={p50} />
        <LatencyCell label="P99" value={p99} />
      </div>
    </motion.article>
  )
})

function ActionButton({
  label,
  pendingLabel,
  onClick,
  disabled,
  icon,
  primary = false,
}: {
  label: string
  pendingLabel: string
  onClick: () => Promise<void>
  disabled: boolean
  icon?: ReactNode
  primary?: boolean
}) {
  const busy = disabled && pendingLabel !== label

  return (
    <button className={`soft-button ${primary ? 'is-primary' : ''}`} type="button" onClick={() => void onClick()} disabled={disabled}>
      <span className="button-icon">{busy ? <RefreshCcw size={15} className="spin" /> : icon}</span>
      <span>{busy ? pendingLabel : label}</span>
    </button>
  )
}

function HeroStat({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: ReactNode }) {
  return (
    <div className={`hero-stat tone-${tone}`}>
      <span className="hero-stat-icon">{icon}</span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  )
}

function StatusChip({ icon, label, tone }: { icon: ReactNode; label: string; tone: string }) {
  return (
    <div className={`status-chip tone-${tone}`}>
      <span>{icon}</span>
      <span>{label}</span>
    </div>
  )
}

function MetricPair({ label, value, tone = 'neutral' }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={`metric-pair tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function LatencyCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="latency-cell">
      <span>{label}</span>
      <strong>{formatLatency(value)}</strong>
    </div>
  )
}

function PanelMotion({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay }}>
      {children}
    </motion.div>
  )
}

function labelForStrategy(strategy: StrategyName) {
  return strategies.find((item) => item.value === strategy)?.label ?? strategy
}

function labelForDevice(user: DemoUser) {
  return `Phone ${String(user.index).padStart(2, '0')}`
}

function pduSessionStatus(user: DemoUser) {
  return user.active ? 'PDU Session Established' : 'Not connected'
}

function formatBytes(value: number) {
  return `${(value / 1024).toFixed(0)} KiB`
}

function formatMbps(value: number) {
  return `${value.toFixed(1)} Mbps`
}

function formatLatency(value: number | null) {
  if (value === null || value <= 0) {
    return '--'
  }
  return `${value.toFixed(0)} ms`
}

function percentile(samples: number[], fraction: number) {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function classifyResultStatus(result: UploadResult): DemoUserStatus {
  if (!result.success) {
    return 'failed'
  }
  if (result.latency_ms < 100) {
    return 'good'
  }
  if (result.latency_ms <= 200) {
    return 'delayed'
  }
  return 'failed'
}

function ringPathLength(status: DemoUserStatus) {
  switch (status) {
    case 'good':
      return 0.86
    case 'delayed':
      return 0.62
    case 'failed':
      return 0.92
    case 'running':
      return 0.72
    case 'idle':
      return 0.34
    default:
      return 0.08
  }
}

function statusColor(status: DemoUserStatus) {
  switch (status) {
    case 'good':
      return '#4f7c4d'
    case 'delayed':
      return '#c7821e'
    case 'failed':
      return '#d85d5d'
    case 'running':
      return '#6677d6'
    case 'idle':
      return '#8e94a3'
    default:
      return '#b9becc'
  }
}

function sporadicAnimationDelay(result: UploadResult) {
  const batchWindowMS = 1000
  const minDelayMS = 40
  const maxDelayMS = 940
  const seed = `${result.id}:${result.attempt}:${result.at}:${result.phase_ms}`
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const normalized = ((hash >>> 0) % batchWindowMS) / batchWindowMS
  return Math.round(minDelayMS + normalized * (maxDelayMS - minDelayMS))
}

function scenarioStyle(strategy: StrategyName) {
  switch (strategy) {
    case 'standard_gbr':
      return {
        tone: 'sky',
        icon: <Shield size={16} />,
        description: 'Static reservation keeps an admitted set stable, but later devices degrade once the protected pool is committed.',
        caption: 'Early devices stay protected while capacity remains pinned to their sessions.',
        expectation: 'About 30 users should remain good.',
      }
    case 'dynamic_qos':
      return {
        tone: 'violet',
        icon: <Sparkles size={16} />,
        description: 'Prioritized treatment is granted only while uploads are active, then immediately released for reuse across the population.',
        caption: 'Adaptive scheduling reuses the same total budget more efficiently.',
        expectation: 'All 50 users should stay in the good range.',
      }
    default:
      return {
        tone: 'rose',
        icon: <Activity size={16} />,
        description: 'All devices compete on the public path. Queueing builds quickly and visible degradation spreads across the population.',
        caption: 'The shared unmanaged lane deteriorates first under contention.',
        expectation: 'Only about 10 users stay reliably good.',
      }
  }
}

export default App
