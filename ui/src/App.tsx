import { memo, startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Gauge,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Shield,
  Sparkles,
  StopCircle,
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
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DemoStreamStatus } from './api'
import type { DemoState, DemoStreamEvent, DemoUser, DemoUserStatus, StrategyName, UploadResult } from './types'
import './App.css'

const strategies: Array<{ label: string; value: StrategyName; short: string; tone: 'blue' | 'orange' | 'purple' }> = [
  { label: 'No Optimization', value: 'no_optimization', short: 'All public', tone: 'orange' },
  { label: 'Standard GBR', value: 'standard_gbr', short: 'Static reservation', tone: 'blue' },
  { label: 'Dynamic QoS', value: 'dynamic_qos', short: 'Temporary grants', tone: 'purple' },
]

const filterOptions = ['all', 'uploading', 'prioritized', 'public', 'waiting'] as const
const sortOptions = ['latency', 'ue', 'status'] as const

type PendingAction = 'prepare' | 'run' | 'spawn' | 'stop' | 'reset' | 'refresh'
type PendingActions = Record<PendingAction, boolean>
type BoardFilter = (typeof filterOptions)[number]
type BoardSort = (typeof sortOptions)[number]
type HistoryPoint = {
  tick: number
  active: number
  p50: number
  p99: number
  goodPct: number
  degradedPct: number
  highPct: number
  latencies: number[]
}

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
      <motion.div className="page-frame" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28 }}>
        <DashboardHeader
          draftStrategy={liveState.draftStrategy}
          appliedStrategy={liveState.state?.strategy}
          state={liveState.state}
          loading={liveState.loading}
          pending={liveState.pending}
          streamStatus={liveState.streamStatus}
          onDraftStrategyChange={liveState.setDraftStrategy}
          onPrepare={liveState.prepareSession}
          onRun={liveState.startRun}
          onSpawn={liveState.spawnUsers}
          onStop={liveState.stopRun}
          onReset={liveState.resetRun}
          onRefresh={liveState.refreshState}
        />

        <AnimatePresence>
          {liveState.error ? (
            <motion.div className="error-banner" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
              <AlertTriangle size={15} />
              <span>{liveState.error}</span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <KpiStrip state={liveState.state} streamStatus={liveState.streamStatus} />
        <InsightStrip state={liveState.state} />

        <main className="dashboard-main">
          <AnalyticsColumn state={liveState.state} historyPoints={liveState.historyPoints} />
          <DeviceBoard
            state={liveState.state}
            resultByID={liveState.resultByID}
            latencyHistoryByID={liveState.latencyHistoryByID}
            completionTicks={liveState.completionTicks}
          />
        </main>

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
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([])
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
    setHistoryPoints([])
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

    if (nextState.running || nextState.counters.active_users > 0) {
      setHistoryPoints((current) => [...current, makeHistoryPoint(nextState, current.length)].slice(-90))
    }

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
            next[item.id] = history.slice(-36)
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
    historyPoints,
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

function DashboardHeader({
  draftStrategy,
  appliedStrategy,
  state,
  loading,
  pending,
  streamStatus,
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
  onDraftStrategyChange: (value: StrategyName) => void
  onPrepare: () => Promise<void>
  onRun: () => Promise<void>
  onSpawn: () => Promise<void>
  onStop: () => Promise<void>
  onReset: () => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const activeStrategy = state?.strategy ?? appliedStrategy ?? draftStrategy
  const streamConnected = streamStatus === 'connected'

  return (
    <header className="dashboard-header">
      <div className="brand-lockup">
        <div className="brand-icon">
          <Radio size={18} />
        </div>
        <div className="brand-line">
          <h1>QoS Uplink Strategy Monitor</h1>
          <span>Real-time UE Performance Simulation</span>
        </div>
      </div>

      <div className="header-controls" aria-label="Dashboard controls">
        <span className="control-label">Strategy</span>
        <div className="strategy-toggle" role="group" aria-label="Strategy">
          {strategies.map((item) => (
            <button
              key={item.value}
              className={item.value === draftStrategy ? 'is-selected' : ''}
              type="button"
              onClick={() => onDraftStrategyChange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="action-row">
          <ActionButton label="Prepare" pendingLabel="Preparing" onClick={onPrepare} disabled={pending.prepare} pending={pending.prepare} icon={<RefreshCcw size={14} />} />
          <ActionButton label="Start" pendingLabel="Starting" onClick={onRun} disabled={!state || Boolean(state.running) || pending.run} pending={pending.run} icon={<Play size={14} />} primary />
          <ActionButton label="Add UEs" pendingLabel="Adding" onClick={onSpawn} disabled={!state?.running || pending.spawn} pending={pending.spawn} icon={<Plus size={14} />} />
          <ActionButton label="Stop" pendingLabel="Stopping" onClick={onStop} disabled={!state?.running || pending.stop} pending={pending.stop} icon={<StopCircle size={14} />} danger />
          <ActionButton label="Reset" pendingLabel="Resetting" onClick={onReset} disabled={!state || pending.reset} pending={pending.reset} icon={<RotateCcw size={14} />} />
          <ActionButton label={loading ? 'Syncing' : 'Refresh'} pendingLabel="Refreshing" onClick={onRefresh} disabled={pending.refresh} pending={pending.refresh} icon={<RefreshCcw size={14} />} iconOnly />
        </div>
      </div>

      <div className="run-strip">
        <span className={`live-dot ${streamConnected ? 'is-live' : ''}`} />
        <span>Live Stream {streamConnected ? 'Connected' : streamStatus}</span>
        <span>{streamConnected ? 'Live' : '--'}</span>
        <span>Run State:</span>
        <strong className={state?.running ? 'state-running' : ''}>{state?.running ? 'RUNNING' : state ? 'READY' : 'NO SESSION'}</strong>
        <span>Strategy:</span>
        <strong>{labelForStrategy(activeStrategy)}</strong>
      </div>
    </header>
  )
}

function KpiStrip({
  state,
  streamStatus,
}: {
  state: DemoState | null
  streamStatus: DemoStreamStatus
}) {
  const activeUsers = state?.counters.active_users ?? 0
  const goodPercent = activeUsers > 0 && state ? Math.round((state.counters.good_users / activeUsers) * 100) : null
  const highPercent = activeUsers > 0 && state ? Math.round((state.counters.failed_users / activeUsers) * 100) : null
  const activeStrategy = state?.strategy ?? 'no_optimization'

  return (
    <section className="kpi-strip" aria-label="Run summary metrics">
      <ActiveStrategyCard strategy={activeStrategy} />
      <MetricCard icon={<Activity size={18} />} label="Active UEs" value={state ? activeUsers : '--'} detail={state ? `${state.counters.planned_users} planned` : 'No session'} tone="blue" />
      <MetricCard icon={<CheckCircle2 size={18} />} label="Good Latency" value={goodPercent === null ? '--' : `${goodPercent}%`} detail="Good (<=150ms)" tone="green" />
      <MetricCard icon={<AlertTriangle size={18} />} label="High Latency" value={highPercent === null ? '--' : `${highPercent}%`} detail="High (>300ms)" tone="orange" />
      <MetricCard icon={<Gauge size={18} />} label="Shared Capacity" value={state ? formatMbps(state.bandwidth.total_rate_mbps) : '--'} detail={`Stream ${streamStatus}`} tone="blue" />
    </section>
  )
}

function ActiveStrategyCard({
  strategy,
}: {
  strategy: StrategyName
}) {
  const scenario = scenarioStyle(strategy)

  return (
    <article className={`scenario-summary-card tone-${scenario.tone}`}>
      <div className="comparison-head">
        <div className="comparison-icon">{scenario.icon}</div>
        <div>
          <h3>{labelForStrategy(strategy)}</h3>
          <p>{scenario.short}</p>
        </div>
        <span className="active-badge">Active</span>
      </div>
      <p className="scenario-message">{scenario.expectation}</p>
    </article>
  )
}

function MetricCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: ReactNode; detail: string; tone: string }) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  )
}

function InsightStrip({ state }: { state: DemoState | null }) {
  if (!state) {
    return (
      <section className="insight-strip">
        <strong>No live run yet.</strong>
        <span>Prepare a strategy to show how shared uplink capacity affects UE latency.</span>
      </section>
    )
  }

  const activeUsers = state.counters.active_users
  const goodPercent = activeUsers > 0 ? Math.round((state.counters.good_users / activeUsers) * 100) : 0
  const highPercent = activeUsers > 0 ? Math.round((state.counters.failed_users / activeUsers) * 100) : 0
  const status = state.running ? 'is keeping' : 'is ready for'

  return (
    <section className="insight-strip">
      <strong>{labelForStrategy(state.strategy)}</strong>
      <span>
        {status} {goodPercent}% of {activeUsers} active UEs in Good (&lt;=150ms), with {highPercent}% in High (&gt;300ms).
      </span>
    </section>
  )
}

function AnalyticsColumn({
  state,
  historyPoints,
}: {
  state: DemoState | null
  historyPoints: HistoryPoint[]
}) {
  const good = state?.counters.good_users ?? 0
  const delayed = state?.counters.delayed_users ?? 0
  const failed = state?.counters.failed_users ?? 0
  const treatments = state ? treatmentCounts(state.users) : { public: 0, reserved: 0, temporary: 0 }
  const chartMaxUsers = Math.max(state?.counters.planned_users ?? 0, ...historyPoints.map((point) => point.active), 1)
  const congestionPoint = historyPoints.find((point) => point.degradedPct + point.highPct > 0)?.active ?? null
  const latencyCloud = historyPoints.flatMap((point) =>
    point.latencies.map((latency, index) => ({
      id: `${point.tick}-${index}`,
      active: point.active,
      latency: clampChartLatency(latency),
      rawLatency: latency,
    })),
  )

  return (
    <section className="analytics-column" aria-label="Simulation analytics">
      <Panel title="Load & Latency Trend" meta="Latest run">
        <div className="chart-shell trend-shell">
          <div className="chart-legend">
            <span className="legend-item cloud">UE latency samples</span>
            <span className="legend-item purple">P50 latency</span>
            <span className="legend-item red">P99 latency</span>
          </div>
          <div className="empty-chart">
            <div className="line-chart-wrap">
              {historyPoints.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={historyPoints} margin={{ top: 8, right: 10, bottom: 4, left: -18 }}>
                    <CartesianGrid stroke="#e5edf7" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="active" type="number" name="Active UEs" tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} domain={[0, chartMaxUsers]} />
                    <YAxis dataKey="p99" type="number" domain={[0, 1000]} ticks={[0, 150, 300, 1000]} tickFormatter={formatLatencyAxis} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ border: '1px solid #dce3ef', borderRadius: 8, fontSize: 12 }} formatter={formatChartTooltip} labelFormatter={(value) => `${value} active UEs`} />
                    <ReferenceArea y1={0} y2={150} fill="#22a34a" fillOpacity={0.08} />
                    <ReferenceArea y1={150} y2={300} fill="#f59e0b" fillOpacity={0.1} />
                    <ReferenceArea y1={300} y2={1000} fill="#ef4444" fillOpacity={0.08} />
                    <ReferenceLine y={150} stroke="#22a34a" strokeDasharray="4 4" strokeOpacity={0.5} />
                    <ReferenceLine y={300} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.45} />
                    {congestionPoint ? <ReferenceLine x={congestionPoint} stroke="#0f172a" strokeDasharray="3 5" strokeOpacity={0.45} label={{ value: 'Contention', position: 'insideTop', fill: '#475467', fontSize: 10 }} /> : null}
                    <Scatter data={latencyCloud} dataKey="latency" name="UE latency" fill="#2563eb" fillOpacity={0.22} line={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="p50" name="P50 latency" stroke="#7c3aed" strokeWidth={2.2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="p99" name="P99 latency" stroke="#ef4444" strokeWidth={2.8} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <ChartEmpty label="Trend appears when the run starts" />
              )}
            </div>
            <div className="threshold-stack">
              <span>1000ms+</span>
              <span>High (&gt;300ms)</span>
              <span>Degraded (150-300ms)</span>
              <span>Good (&lt;=150ms)</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Upload Outcome Distribution" meta="Current split">
        <div className="outcome-layout">
          <div className="area-chart-wrap">
            {historyPoints.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={historyPoints} margin={{ top: 6, right: 6, bottom: 0, left: -24 }}>
                  <XAxis dataKey="active" type="number" tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} domain={[0, chartMaxUsers]} />
                  <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ border: '1px solid #dce3ef', borderRadius: 8, fontSize: 12 }} formatter={(value, name) => [`${Number(value).toFixed(0)}%`, name]} labelFormatter={(value) => `${value} active UEs`} />
                  <Area type="monotone" dataKey="goodPct" name="Good" stackId="1" stroke="#22a34a" fill="#86d993" isAnimationActive={false} />
                  <Area type="monotone" dataKey="degradedPct" name="Degraded" stackId="1" stroke="#f59e0b" fill="#fbd38d" isAnimationActive={false} />
                  <Area type="monotone" dataKey="highPct" name="High" stackId="1" stroke="#ef4444" fill="#fca5a5" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ChartEmpty label="Outcome history is empty" />
            )}
          </div>
          <div className="outcome-list">
            <OutcomeRow label="Good" value={good} tone="green" />
            <OutcomeRow label="Degraded" value={delayed} tone="orange" />
            <OutcomeRow label="High" value={failed} tone="red" />
          </div>
        </div>
      </Panel>

      <Panel title="Treatment Allocation" meta="Current">
        <div className="allocation-bar" aria-label="Treatment allocation">
          <span className="public" style={{ flexGrow: treatments.public || 0.0001 }}>Public</span>
          <span className="temporary" style={{ flexGrow: treatments.temporary || 0.0001 }}>Temp</span>
          <span className="reserved" style={{ flexGrow: treatments.reserved || 0.0001 }}>Reserved</span>
        </div>
        <div className="allocation-labels">
          <strong>{treatments.public} public</strong>
          <strong>{treatments.temporary} temp</strong>
          <strong>{treatments.reserved} reserved</strong>
        </div>
      </Panel>
    </section>
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
  const [filter, setFilter] = useState<BoardFilter>('all')
  const [sortMode, setSortMode] = useState<BoardSort>('ue')
  const deferredUsers = useDeferredValue(state?.users ?? [])
  const deferredResultByID = useDeferredValue(resultByID)
  const deferredLatencyHistoryByID = useDeferredValue(latencyHistoryByID)
  const deferredCompletionTicks = useDeferredValue(completionTicks)
  const filterCounts = useMemo(() => boardFilterCounts(deferredUsers), [deferredUsers])
  const visibleUsers = useMemo(
    () => sortUsers(filterUsers(deferredUsers, filter), sortMode, deferredResultByID),
    [deferredUsers, deferredResultByID, filter, sortMode],
  )

  return (
    <section className="panel activity-board">
      <div className="panel-title-row">
        <div>
          <h2>UE Activity Board</h2>
          <p>{state ? `${visibleUsers.length} visible UEs` : 'No prepared session'}</p>
        </div>
        <div className="sort-control">
          <span>Sort By</span>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as BoardSort)}>
            {sortOptions.map((option) => (
              <option key={option} value={option}>
                {labelForSort(option)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="board-tabs" role="tablist" aria-label="UE filters">
        {filterOptions.map((option) => (
          <button key={option} className={filter === option ? 'is-active' : ''} type="button" onClick={() => setFilter(option)}>
            <span>{labelForFilter(option)}</span>
            <strong>{filterCounts[option]}</strong>
          </button>
        ))}
      </div>

      {state ? (
        visibleUsers.length ? (
          <div className="ue-grid">
            {visibleUsers.map((user, index) => (
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
        ) : (
          <div className="board-empty">No UEs match {labelForFilter(filter)}</div>
        )
      ) : (
        <div className="board-empty">No session prepared</div>
      )}
    </section>
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
  const treatment = treatmentLabel(user)

  return (
    <motion.article
      className={`ue-card status-${displayStatus} treatment-${user.treatment} ${user.active ? '' : 'is-waiting'} ${completionTick > 0 ? 'is-complete' : ''}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + (index % 12) * 0.015 }}
    >
      <div className="ue-card-top">
        <div>
          <span className="ue-status-dot" />
          <strong>{ueLabel(user)}</strong>
        </div>
        <span className="treatment-pill">{treatment}</span>
      </div>

      <div className="ue-card-body">
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
        <strong>{user.active ? formatLatency(displayLatencyMS) : 'Waiting'}</strong>
      </div>

      <SparkBars samples={latencyHistory} />
    </motion.article>
  )
})

function Panel({ title, meta, children }: { title: string; meta: string; children: ReactNode }) {
  return (
    <section className="panel analytics-panel">
      <div className="panel-title-row">
        <div>
          <h2>{title}</h2>
          <p>{meta}</p>
        </div>
        <CircleDot size={14} />
      </div>
      {children}
    </section>
  )
}

function ActionButton({
  label,
  pendingLabel,
  onClick,
  disabled,
  pending = false,
  icon,
  primary = false,
  danger = false,
  iconOnly = false,
}: {
  label: string
  pendingLabel: string
  onClick: () => Promise<void>
  disabled: boolean
  pending?: boolean
  icon?: ReactNode
  primary?: boolean
  danger?: boolean
  iconOnly?: boolean
}) {
  return (
    <button
      className={`soft-button ${primary ? 'is-primary' : ''} ${danger ? 'is-danger' : ''} ${iconOnly ? 'is-icon-only' : ''}`}
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      aria-label={label}
      title={iconOnly ? label : undefined}
    >
      <span className="button-icon">{pending ? <RefreshCcw size={14} className="spin" /> : icon}</span>
      {iconOnly ? null : <span>{pending ? pendingLabel : label}</span>}
    </button>
  )
}

function OutcomeRow({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`outcome-row tone-${tone}`}>
      <span>{label}</span>
      <strong>{value} UEs</strong>
    </div>
  )
}

function SparkBars({ samples, tall = false }: { samples: number[]; tall?: boolean }) {
  const displaySamples = samples.slice(-24)
  const max = Math.max(...displaySamples, 1)

  return (
    <div className={`spark-bars ${tall ? 'is-tall' : ''}`} aria-hidden="true">
      {Array.from({ length: 24 }).map((_, index) => {
        const value = displaySamples[index - (24 - displaySamples.length)]
        const height = value ? Math.max(12, Math.round((value / max) * 100)) : 0
        return <span key={index} style={{ height: `${height}%` }} />
      })}
    </div>
  )
}

function ChartEmpty({ label }: { label: string }) {
  return <div className="chart-empty-label">{label}</div>
}

function labelForStrategy(strategy: StrategyName) {
  return strategies.find((item) => item.value === strategy)?.label ?? strategy
}

function labelForFilter(filter: BoardFilter) {
  switch (filter) {
    case 'all':
      return 'All'
    case 'uploading':
      return 'Uploading'
    case 'prioritized':
      return 'Prioritized'
    case 'public':
      return 'Public'
    case 'waiting':
      return 'Waiting'
  }
}

function labelForSort(sortMode: BoardSort) {
  switch (sortMode) {
    case 'latency':
      return 'Latency'
    case 'ue':
      return 'IMSI'
    case 'status':
      return 'Status'
  }
}

function ueLabel(user: DemoUser) {
  return `IMSI ${String(user.index).padStart(5, '0')}`
}

function treatmentLabel(user: DemoUser) {
  if (!user.active) {
    return 'Wait'
  }
  if (user.treatment === 'temporary_grant') {
    return 'Temp'
  }
  if (user.treatment === 'reserved') {
    return 'GBR'
  }
  return 'Public'
}

function formatMbps(value: number) {
  return `${value.toFixed(0)} Mbps`
}

function formatLatency(value: number | null | undefined) {
  if (value === null || value === undefined || value <= 0) {
    return '--'
  }
  if (value >= 900) {
    return '1000ms+'
  }
  return `${value.toFixed(0)} ms`
}

function clampChartLatency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.min(value, 1000)
}

function formatLatencyAxis(value: number) {
  return value >= 1000 ? '1000ms+' : `${value}ms`
}

function formatChartTooltip(value: unknown, name: unknown): [ReactNode, string] {
  const numeric = Number(value)
  return [Number.isFinite(numeric) ? formatLatency(numeric) : String(value), String(name)]
}

function percentile(samples: number[], fraction: number) {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function makeHistoryPoint(state: DemoState, tick: number): HistoryPoint {
  const stateLatencies = state.users
    .filter((user) => user.active)
    .map((user) => user.last_latency_ms ?? 0)
    .filter((value) => value > 0)
  const activeUsers = state.counters.active_users
  const percentOfActive = (value: number) => (activeUsers > 0 ? Math.round((value / activeUsers) * 100) : 0)

  return {
    tick,
    active: activeUsers,
    p50: clampChartLatency(percentile(stateLatencies, 0.5)),
    p99: clampChartLatency(percentile(stateLatencies, 0.99)),
    goodPct: percentOfActive(state.counters.good_users),
    degradedPct: percentOfActive(state.counters.delayed_users),
    highPct: percentOfActive(state.counters.failed_users),
    latencies: stateLatencies,
  }
}

function treatmentCounts(users: DemoUser[]) {
  return users.reduce(
    (counts, user) => {
      if (!user.active) {
        return counts
      }
      if (user.treatment === 'reserved') {
        counts.reserved += 1
      } else if (user.treatment === 'temporary_grant') {
        counts.temporary += 1
      } else {
        counts.public += 1
      }
      return counts
    },
    { public: 0, reserved: 0, temporary: 0 },
  )
}

function filterUsers(users: DemoUser[], filter: BoardFilter) {
  switch (filter) {
    case 'uploading':
      return users.filter((user) => user.active && (user.uploading || user.running))
    case 'prioritized':
      return users.filter((user) => user.active && user.treatment !== 'public')
    case 'public':
      return users.filter((user) => user.active && user.treatment === 'public')
    case 'waiting':
      return users.filter((user) => !user.active)
    case 'all':
    default:
      return users
  }
}

function boardFilterCounts(users: DemoUser[]): Record<BoardFilter, number> {
  return {
    all: users.length,
    uploading: users.filter((user) => user.active && (user.uploading || user.running)).length,
    prioritized: users.filter((user) => user.active && user.treatment !== 'public').length,
    public: users.filter((user) => user.active && user.treatment === 'public').length,
    waiting: users.filter((user) => !user.active).length,
  }
}

function sortUsers(users: DemoUser[], sortMode: BoardSort, resultByID: Record<string, UploadResult>) {
  const next = [...users]
  next.sort((left, right) => {
    let result = 0
    if (sortMode === 'latency') {
      result = latestLatency(right, resultByID) - latestLatency(left, resultByID)
    } else if (sortMode === 'status') {
      result = statusRank(right, resultByID) - statusRank(left, resultByID)
    } else {
      result = left.index - right.index
    }
    return result || left.index - right.index
  })
  return next
}

function latestLatency(user: DemoUser, resultByID: Record<string, UploadResult>) {
  return resultByID[user.client_id]?.latency_ms ?? user.last_latency_ms ?? 0
}

function statusRank(user: DemoUser, resultByID: Record<string, UploadResult>) {
  const status = resultByID[user.client_id] ? classifyResultStatus(resultByID[user.client_id]) : user.status
  switch (status) {
    case 'failed':
      return 5
    case 'delayed':
      return 4
    case 'running':
      return 3
    case 'good':
      return 2
    case 'idle':
      return 1
    case 'planned':
    default:
      return 0
  }
}

function classifyResultStatus(result: UploadResult): DemoUserStatus {
  if (!result.success) {
    return 'failed'
  }
  if (result.latency_ms <= 150) {
    return 'good'
  }
  if (result.latency_ms <= 300) {
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
    case 'planned':
    default:
      return 0.1
  }
}

function statusColor(status: DemoUserStatus) {
  switch (status) {
    case 'good':
      return '#24a148'
    case 'delayed':
      return '#f59e0b'
    case 'failed':
      return '#ef4444'
    case 'running':
      return '#2563eb'
    case 'idle':
    case 'planned':
    default:
      return '#9ca3af'
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
        tone: 'blue' as const,
        short: 'Static reservation',
        icon: <Shield size={16} />,
        expectation: 'Protects reserved UEs while others compete.',
      }
    case 'dynamic_qos':
      return {
        tone: 'purple' as const,
        short: 'Temporary grants',
        icon: <Sparkles size={16} />,
        expectation: 'Reuses priority so more UEs stay in good latency.',
      }
    default:
      return {
        tone: 'orange' as const,
        short: 'All public',
        icon: <Activity size={16} />,
        expectation: 'Degrades quickly under shared contention.',
      }
  }
}

export default App
