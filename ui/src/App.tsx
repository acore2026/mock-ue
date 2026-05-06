import { memo, startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Gauge,
  Smartphone,
  Play,
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
  startDemoRun,
  stopDemoRun,
  subscribeDemoStream,
} from './api'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
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

type PendingAction = 'mode' | 'run' | 'stop' | 'reset' | 'refresh'
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
  prioritized: number
  temporary: number
  capacity: number
  latencies: number[]
}

const initialPendingState: PendingActions = {
  mode: false,
  run: false,
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
          state={liveState.state}
          loading={liveState.loading}
          pending={liveState.pending}
          onRun={liveState.startRun}
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

        <StrategyComparison
          state={liveState.state}
          historyPoints={liveState.historyPoints}
          pending={liveState.pending.mode}
          pendingStrategy={liveState.pendingStrategy}
          onModeSelect={liveState.switchMode}
        />
        <KpiStrip state={liveState.state} historyPoints={liveState.historyPoints} />
        <DashboardBody
          state={liveState.state}
          historyPoints={liveState.historyPoints}
          resultByID={liveState.resultByID}
          latencyHistoryByID={liveState.latencyHistoryByID}
        />
      </motion.div>
    </div>
  )
}

function useDemoLiveState() {
  const [state, setState] = useState<DemoState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [streamStatus, setStreamStatus] = useState<DemoStreamStatus>('connecting')
  const [pending, setPending] = useState<PendingActions>(initialPendingState)
  const [pendingStrategy, setPendingStrategy] = useState<StrategyName | null>(null)
  const [resultByID, setResultByID] = useState<Record<string, UploadResult>>({})
  const [latencyHistoryByID, setLatencyHistoryByID] = useState<Record<string, number[]>>({})
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([])
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
    recordedAttemptsRef.current = {}
    setResultByID({})
    setLatencyHistoryByID({})
    setHistoryPoints([])
  }

  function applyState(nextState: DemoState | null) {
    if (!nextState) {
      setState(null)
      resetSandboxState()
      return
    }

    setState(nextState)

    if (nextState.running || nextState.counters.active_users > 0) {
      setHistoryPoints((current) => [...current, makeHistoryPoint(nextState, current.length)].slice(-90))
    }

    if (!nextState.running && nextState.counters.active_users === 0) {
      resetSandboxState()
    }
  }

  async function switchMode(strategy: StrategyName) {
    if (pending.mode || (state?.strategy === strategy && state.running)) {
      return
    }

    setActionPending('mode', true)
    setPendingStrategy(strategy)
    setError(null)
    resetSandboxState()

    try {
      const preparedState = await prepareDemoSession(strategy)
      applyState(preparedState)
      const startedState = await startDemoRun()
      applyState(startedState)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch demo mode')
    } finally {
      setPendingStrategy(null)
      setActionPending('mode', false)
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
    error,
    historyPoints,
    latencyHistoryByID,
    loading,
    pending,
    resultByID,
    state,
    streamStatus,
    pendingStrategy,
    switchMode,
    startRun: () => runAction('run', startDemoRun, 'Failed to start demo run'),
    stopRun: () => runAction('stop', stopDemoRun, 'Failed to stop demo run'),
    resetRun: () => runAction('reset', resetDemoRun, 'Failed to reset demo run'),
    refreshState: () => loadState(),
  }
}

function DashboardHeader({
  state,
  loading,
  pending,
  onRun,
  onStop,
  onReset,
  onRefresh,
}: {
  state: DemoState | null
  loading: boolean
  pending: PendingActions
  onRun: () => Promise<void>
  onStop: () => Promise<void>
  onReset: () => Promise<void>
  onRefresh: () => Promise<void>
}) {
  const controlsLocked = pending.mode || pending.run || pending.stop || pending.reset

  return (
    <header className="dashboard-header">
      <div className="brand-lockup">
        <div className="brand-icon">
          <Radio size={18} />
        </div>
        <div className="brand-line">
          <h1>QoS Uplink Strategy Monitor</h1>
        </div>
      </div>

      <div className="header-controls" aria-label="Dashboard controls">
        <div className="action-row">
          <ActionButton label="Start" pendingLabel="Starting" onClick={onRun} disabled={!state || Boolean(state.running) || controlsLocked} pending={pending.run} icon={<Play size={14} />} primary />
          <ActionButton label="Stop" pendingLabel="Stopping" onClick={onStop} disabled={!state?.running || controlsLocked} pending={pending.stop} icon={<StopCircle size={14} />} danger />
          <ActionButton label="Reset" pendingLabel="Resetting" onClick={onReset} disabled={!state || controlsLocked} pending={pending.reset} icon={<RotateCcw size={14} />} />
          <ActionButton label={loading ? 'Syncing' : 'Refresh'} pendingLabel="Refreshing" onClick={onRefresh} disabled={pending.refresh || pending.mode} pending={pending.refresh} icon={<RefreshCcw size={14} />} iconOnly />
        </div>
      </div>
    </header>
  )
}

function KpiStrip({
  state,
  historyPoints,
}: {
  state: DemoState | null
  historyPoints: HistoryPoint[]
}) {
  const activeUsers = state?.counters.active_users ?? 0
  const latestPoint = historyPoints.at(-1)
  const goodPercent = state ? goodLatencyPercent(state) : null
  const p50 = state ? p50Latency(state) ?? latestPoint?.p50 ?? null : null
  const prioritized = state ? prioritizedCount(state) : 0
  const temporary = state?.counters.temporary_grants ?? 0
  const reserved = state?.counters.protected_users ?? 0
  const activeSeries = historyPoints.map((point) => point.active)
  const goodSeries = historyPoints.map((point) => point.goodPct)
  const p50Series = historyPoints.map((point) => point.p50)
  const prioritizedSeries = historyPoints.map((point) => point.prioritized)
  const temporarySeries = historyPoints.map((point) => point.temporary)
  const capacitySeries = historyPoints.map((point) => point.capacity)

  return (
    <section className="kpi-strip" aria-label="Run summary metrics">
      <MetricCard
        icon={<Activity size={18} />}
        label="Active UEs"
        value={state ? activeUsers : '--'}
        detail={state ? `${activeUsers} active / ${state.users.length} total` : 'No session'}
        tone="blue"
        visual={<MetricMiniBars samples={activeSeries} tone="blue" />}
      />
      <MetricCard
        icon={<CheckCircle2 size={18} />}
        label="Good Latency"
        value={goodPercent === null ? '--' : `${goodPercent}%`}
        detail={state ? `${state.counters.good_users} UEs <=150ms` : 'Good <=150ms'}
        tone="green"
        visual={<MetricMiniBars samples={goodSeries} tone="green" />}
      />
      <MetricCard
        icon={<Gauge size={18} />}
        label="P50 Upload Latency"
        value={formatLatency(p50)}
        detail="Rolling median"
        tone="purple"
        visual={<MetricMiniBars samples={p50Series} tone="purple" />}
      />
      <MetricCard
        icon={<Shield size={18} />}
        label="Prioritized UEs"
        value={state ? prioritized : '--'}
        detail={state ? `${reserved} Reserved / ${temporary} Temp` : 'Reserved / Temp'}
        tone="purple"
        visual={<MetricMiniBars samples={prioritizedSeries} tone="purple" />}
      />
      <MetricCard
        icon={<Sparkles size={18} />}
        label="Temporary Grants"
        value={state ? temporary : '--'}
        detail="Dynamic allocation"
        tone="orange"
        visual={<MetricMiniBars samples={temporarySeries} tone="orange" />}
      />
      <MetricCard
        icon={<Radio size={18} />}
        label="Shared Capacity"
        value={state ? formatMbps(state.bandwidth.total_rate_mbps) : '--'}
        detail="Uplink (Shared)"
        tone="blue"
        visual={<MetricMiniBars samples={capacitySeries} tone="blue" />}
      />
    </section>
  )
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  tone,
  visual,
}: {
  icon: ReactNode
  label: string
  value: ReactNode
  detail: string
  tone: string
  visual?: ReactNode
}) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div className="metric-main">
        <div className="metric-icon">{icon}</div>
        <div className="metric-copy">
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{detail}</small>
        </div>
      </div>
      {visual ? <div className="metric-visual">{visual}</div> : null}
    </article>
  )
}

function MetricMiniBars({ samples, tone }: { samples: number[]; tone: string }) {
  const displaySamples = samples.slice(-18)
  const max = Math.max(...displaySamples, 1)

  return (
    <div className={`metric-mini-bars tone-${tone}`} aria-hidden="true">
      {Array.from({ length: 18 }).map((_, index) => {
        const value = displaySamples[index - (18 - displaySamples.length)] ?? 0
        const height = value > 0 ? Math.max(12, Math.round((value / max) * 100)) : 6
        return <span key={index} style={{ height: `${height}%` }} />
      })}
    </div>
  )
}

function DashboardBody({
  state,
  historyPoints,
  resultByID,
  latencyHistoryByID,
}: {
  state: DemoState | null
  historyPoints: HistoryPoint[]
  resultByID: Record<string, UploadResult>
  latencyHistoryByID: Record<string, number[]>
}) {
  return (
    <main className="dashboard-body">
      <AnalyticsColumn state={state} historyPoints={historyPoints} />
      <DeviceBoard
        state={state}
        resultByID={resultByID}
        latencyHistoryByID={latencyHistoryByID}
      />
    </main>
  )
}

function StrategyComparison({
  state,
  historyPoints,
  pending,
  pendingStrategy,
  onModeSelect,
}: {
  state: DemoState | null
  historyPoints: HistoryPoint[]
  pending: boolean
  pendingStrategy: StrategyName | null
  onModeSelect: (strategy: StrategyName) => Promise<void>
}) {
  const activeStrategy = state?.strategy ?? null
  const activeUsers = state?.counters.active_users ?? 0
  const latestPoint = historyPoints.at(-1)

  return (
    <section className="strategy-comparison" aria-label="Mode selection" role="radiogroup">
      {strategies.map((strategy) => {
        const scenario = scenarioStyle(strategy.value)
        const isApplied = strategy.value === activeStrategy
        const isSwitching = pending && pendingStrategy === strategy.value
        const isSelected = isApplied || isSwitching
        const comparison = strategyComparisonMetrics(strategy.value, {
          isActive: isApplied,
          latestPoint,
          state,
          activeUsers,
        })
        return (
          <button
            key={strategy.value}
            className={`comparison-card tone-${scenario.tone} ${isSelected ? 'is-active' : ''} ${isSwitching ? 'is-switching' : ''}`}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={`Switch to ${strategy.label}`}
            disabled={pending}
            onClick={() => void onModeSelect(strategy.value)}
          >
            <div className="comparison-head">
              <span className="comparison-radio" aria-hidden="true" />
              <div className="comparison-icon">{scenario.icon}</div>
              <h3>{strategy.label}</h3>
              {isSwitching ? <span className="active-badge">Switching</span> : isApplied ? <span className="active-badge">Active</span> : null}
            </div>

            <div className="comparison-body">
              <StrategyMiniTrend tone={scenario.tone} points={comparison.trend} />

              <div className="comparison-metrics">
                <MetricInline label="Good" value={comparison.good} tone="green" />
                <MetricInline label="P50 Latency" value={comparison.p50} tone="purple" />
                <MetricInline label="Failed" value={comparison.failed} tone="red" />
              </div>
            </div>

            <p className="comparison-note">
              <span />
              {scenario.expectation}
            </p>
          </button>
        )
      })}
    </section>
  )
}

function StrategyMiniTrend({
  tone,
  points,
}: {
  tone: 'blue' | 'orange' | 'purple'
  points: number[]
}) {
  const pathA = sparkPath(points)
  const pathB = sparkPath(points.map((value, index) => Math.max(0, value - 10 - index * 1.5)))

  return (
    <svg className={`strategy-mini-trend tone-${tone}`} viewBox="0 0 180 38" preserveAspectRatio="none" aria-hidden="true">
      <path className="trend-fill" d={`${pathA} L 180 38 L 0 38 Z`} />
      <path className="trend-line-primary" d={pathA} />
      <path className="trend-line-secondary" d={pathB} />
    </svg>
  )
}

function MetricInline({ label, value, tone }: { label: string; value: ReactNode; tone: string }) {
  return (
    <div className={`metric-inline tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function strategyComparisonMetrics(
  strategy: StrategyName,
  context: {
    isActive: boolean
    latestPoint?: HistoryPoint
    state: DemoState | null
    activeUsers: number
  },
) {
  const guide = strategyGuide(strategy)
  if (context.isActive && context.state && context.activeUsers > 0) {
    return {
      good: `${goodLatencyPercent(context.state)}%`,
      p50: context.latestPoint ? formatLatency(context.latestPoint.p50) : '--',
      failed: `${failedPercent(context.state)}%`,
      trend: context.latestPoint?.latencies.length ? normalizeTrend(context.latestPoint.latencies) : guide.trend,
    }
  }
  return {
    good: `${guide.good}%`,
    p50: `${guide.p50} ms`,
    failed: `${guide.failed}%`,
    trend: guide.trend,
  }
}

function strategyGuide(strategy: StrategyName) {
  switch (strategy) {
    case 'standard_gbr':
      return {
        good: 52,
        p50: 158,
        failed: 12,
        trend: [34, 39, 44, 47, 50, 51, 54, 55, 57, 60, 61, 65],
      }
    case 'dynamic_qos':
      return {
        good: 68,
        p50: 132,
        failed: 10,
        trend: [44, 48, 53, 55, 58, 61, 63, 64, 67, 69, 71, 74],
      }
    default:
      return {
        good: 28,
        p50: 245,
        failed: 24,
        trend: [52, 57, 61, 64, 69, 72, 76, 82, 88, 95, 104, 112],
      }
  }
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
  const activeUsers = state?.counters.active_users ?? 0
  const outcomeData = [
    { name: 'Good', value: good, color: '#22a34a' },
    { name: 'Delayed', value: delayed, color: '#f59e0b' },
    { name: 'High', value: failed, color: '#ef4444' },
  ]
  const treatmentTotal = treatments.public + treatments.temporary + treatments.reserved
  const treatmentPct = (value: number) => (treatmentTotal > 0 ? Math.round((value / treatmentTotal) * 100) : 0)
  const chartMaxUsers = Math.max(state?.counters.planned_users ?? 0, ...historyPoints.map((point) => point.active), 1)
  const congestionPoint = historyPoints.find((point) => point.degradedPct + point.highPct > 0)?.tick ?? null

  return (
    <section className="analytics-column" aria-label="Simulation analytics">
      <Panel title="Load & Latency Trend">
        <div className="chart-shell trend-shell">
          <div className="chart-legend">
            <span className="legend-item blue">Active UEs</span>
            <span className="legend-item purple">P50 latency</span>
          </div>
          <div className="empty-chart">
            <div className="line-chart-wrap">
              {historyPoints.length ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <ComposedChart data={historyPoints} margin={{ top: 8, right: 10, bottom: 4, left: -18 }}>
                    <CartesianGrid stroke="#e5edf7" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="tick" tickFormatter={formatTickLabel} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis yAxisId="users" dataKey="active" type="number" domain={[0, chartMaxUsers]} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis yAxisId="latency" orientation="right" type="number" domain={[0, 320]} ticks={[0, 150, 300]} tickFormatter={formatLatencyAxis} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ border: '1px solid #dce3ef', borderRadius: 8, fontSize: 12 }} formatter={formatTrendTooltip} labelFormatter={(value) => formatTickLabel(Number(value))} />
                    <ReferenceArea yAxisId="latency" y1={0} y2={150} fill="#22a34a" fillOpacity={0.08} />
                    <ReferenceArea yAxisId="latency" y1={150} y2={300} fill="#f59e0b" fillOpacity={0.1} />
                    <ReferenceArea yAxisId="latency" y1={300} y2={320} fill="#ef4444" fillOpacity={0.08} />
                    <ReferenceLine yAxisId="latency" y={150} stroke="#22a34a" strokeDasharray="4 4" strokeOpacity={0.5} />
                    <ReferenceLine yAxisId="latency" y={300} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.45} />
                    {congestionPoint ? <ReferenceLine x={congestionPoint} stroke="#0f172a" strokeDasharray="3 5" strokeOpacity={0.45} label={{ value: 'Contention', position: 'insideTop', fill: '#475467', fontSize: 10 }} /> : null}
                    <Line yAxisId="users" type="monotone" dataKey="active" name="Active UEs" stroke="#2563eb" strokeWidth={2.7} dot={false} isAnimationActive={false} />
                    <Line yAxisId="latency" type="monotone" dataKey="p50" name="P50 latency" stroke="#7c3aed" strokeWidth={2.3} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <ChartEmpty label="Trend appears when the run starts" />
              )}
            </div>
            <div className="threshold-stack">
              <span>High (&gt;300ms)</span>
              <span>Degraded (150-300ms)</span>
              <span>Good (&lt;=150ms)</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Upload Outcome Distribution">
        <div className="outcome-layout">
          <div className="area-chart-wrap">
            {historyPoints.length ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                <AreaChart data={historyPoints} margin={{ top: 6, right: 6, bottom: 0, left: -24 }}>
                  <XAxis dataKey="tick" tickFormatter={formatTickLabel} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ border: '1px solid #dce3ef', borderRadius: 8, fontSize: 12 }} formatter={(value, name) => [`${Number(value).toFixed(0)}%`, name]} labelFormatter={(value) => formatTickLabel(Number(value))} />
                  <Area type="monotone" dataKey="goodPct" name="Good" stackId="1" stroke="#22a34a" fill="#86d993" isAnimationActive={false} />
                  <Area type="monotone" dataKey="degradedPct" name="Degraded" stackId="1" stroke="#f59e0b" fill="#fbd38d" isAnimationActive={false} />
                  <Area type="monotone" dataKey="highPct" name="High" stackId="1" stroke="#ef4444" fill="#fca5a5" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <ChartEmpty label="Outcome history is empty" />
            )}
          </div>
          <div className="donut-chart-wrap">
            {activeUsers > 0 ? (
              <>
                <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
                  <PieChart>
                    <Pie data={outcomeData} dataKey="value" nameKey="name" innerRadius={23} outerRadius={36} paddingAngle={1} stroke="none" isAnimationActive={false}>
                      {outcomeData.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <span>{state ? goodLatencyPercent(state) : 0}%</span>
              </>
            ) : (
              <span>--</span>
            )}
          </div>
          <div className="outcome-list">
            <OutcomeRow label="Good" value={good} tone="green" />
            <OutcomeRow label="Degraded" value={delayed} tone="orange" />
            <OutcomeRow label="High" value={failed} tone="red" />
          </div>
        </div>
      </Panel>

      <Panel title="Treatment Allocation">
        <div className="allocation-bar" aria-label="Treatment allocation">
          <span className="public" style={{ flexGrow: treatments.public || 0.0001 }}>Public ({treatmentPct(treatments.public)}%)</span>
          <span className="temporary" style={{ flexGrow: treatments.temporary || 0.0001 }}>Temporary ({treatmentPct(treatments.temporary)}%)</span>
          <span className="reserved" style={{ flexGrow: treatments.reserved || 0.0001 }}>Reserved ({treatmentPct(treatments.reserved)}%)</span>
        </div>
        <div className="allocation-labels">
          <strong>{treatments.public} public</strong>
          <strong>{treatments.temporary} temp</strong>
          <strong>{treatments.reserved} reserved</strong>
          <strong>Total Active UEs: {activeUsers}</strong>
        </div>
      </Panel>
    </section>
  )
}

const DeviceBoard = memo(function DeviceBoard({
  state,
  resultByID,
  latencyHistoryByID,
}: {
  state: DemoState | null
  resultByID: Record<string, UploadResult>
  latencyHistoryByID: Record<string, number[]>
}) {
  const [filter, setFilter] = useState<BoardFilter>('all')
  const [sortMode, setSortMode] = useState<BoardSort>('ue')
  const deferredUsers = useDeferredValue(state?.users ?? [])
  const deferredResultByID = useDeferredValue(resultByID)
  const deferredLatencyHistoryByID = useDeferredValue(latencyHistoryByID)
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
  index,
}: {
  user: DemoUser
  latestResult?: UploadResult
  latencyHistory: number[]
  index: number
}) {
  const displayStatus = latestResult ? classifyResultStatus(latestResult) : user.status
  const displayLatencyMS = latestResult?.latency_ms ?? user.last_latency_ms ?? 0
  const treatment = treatmentMeta(user)

  return (
    <motion.article
      className={`ue-card status-${displayStatus} treatment-${user.treatment} ${user.active ? '' : 'is-waiting'}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + (index % 12) * 0.015 }}
    >
      <div className="ue-card-top">
        <div className="ue-card-id">
          <span className="ue-status-dot" />
          <Smartphone className="ue-phone-icon" size={13} />
          <div className="ue-card-name">
            <strong>{ueLabel(user)}</strong>
            <span>{user.client_ip}</span>
          </div>
        </div>
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
              className="ring-value"
              cx="22"
              cy="22"
              r="17.5"
              pathLength="1"
              strokeLinecap="round"
            />
          </svg>
          <span className="dot-core" />
        </div>
        <div className="ue-card-metrics">
          <strong>{user.active ? formatLatency(displayLatencyMS) : 'Waiting'}</strong>
          <span className={`ue-treatment-badge treatment-${user.treatment}`} title={treatment.label}>
            {treatment.icon}
            <span>{treatment.short}</span>
          </span>
        </div>
      </div>

      <SparkBars samples={latencyHistory} />
    </motion.article>
  )
})

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel analytics-panel">
      <div className="panel-title-row">
        <div>
          <h2>{title}</h2>
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
      return 'UE'
    case 'status':
      return 'Status'
  }
}

function ueLabel(user: DemoUser) {
  return `imsi-20893-${String(user.index).padStart(3, '0')}`
}

function treatmentMeta(user: DemoUser): { short: string; label: string; icon: ReactNode } {
  if (!user.active) {
    return { short: 'WAIT', label: 'Waiting', icon: null }
  }
  if (user.treatment === 'temporary_grant') {
    return { short: 'TEMP', label: 'Temporary grant', icon: <Sparkles size={10} /> }
  }
  if (user.treatment === 'reserved') {
    return { short: 'GBR', label: 'Reserved GBR', icon: <Shield size={10} /> }
  }
  return { short: 'PUB', label: 'Public best effort', icon: null }
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

function formatTickLabel(value: number) {
  if (!Number.isFinite(value)) {
    return ''
  }
  return `T+${value}`
}

function formatTrendTooltip(value: unknown, name: unknown): [ReactNode, string] {
  const numeric = Number(value)
  const label = String(name)
  if (!Number.isFinite(numeric)) {
    return [String(value), label]
  }
  if (label === 'Active UEs') {
    return [numeric.toFixed(0), label]
  }
  return [formatLatency(numeric), label]
}

function sparkPath(values: number[]) {
  const safeValues = values.length > 1 ? values : [0, 0]
  const max = Math.max(...safeValues, 1)
  const min = Math.min(...safeValues, 0)
  const range = Math.max(max - min, 1)
  return safeValues
    .map((value, index) => {
      const x = (index / (safeValues.length - 1)) * 180
      const y = 34 - ((value - min) / range) * 28
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

function normalizeTrend(values: number[]) {
  const samples = values.slice(-12)
  return samples.length > 1 ? samples : [0, 0]
}

function goodLatencyPercent(state: DemoState) {
  return state.counters.active_users > 0 ? Math.round((state.counters.good_users / state.counters.active_users) * 100) : 0
}

function failedPercent(state: DemoState) {
  return state.counters.active_users > 0 ? Math.round((state.counters.failed_users / state.counters.active_users) * 100) : 0
}

function prioritizedCount(state: DemoState) {
  return state.counters.protected_users + state.counters.temporary_grants
}

function p50Latency(state: DemoState) {
  const latencies = state.users
    .filter((user) => user.active)
    .map((user) => user.last_latency_ms ?? 0)
    .filter((value) => value > 0)
  return percentile(latencies, 0.5)
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
    prioritized: prioritizedCount(state),
    temporary: state.counters.temporary_grants,
    capacity: state.bandwidth.total_rate_mbps,
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
