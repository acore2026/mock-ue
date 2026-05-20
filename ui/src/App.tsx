import { memo, startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  AlertTriangle,
  CircleDot,
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
  Cell,
  Pie,
  PieChart,
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

const filterOptions = ['all', 'uploading', 'prioritized', 'public', 'online'] as const
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
  failedPct: number
  goodCount: number
  degradedCount: number
  highCount: number
  failedCount: number
  prioritized: number
  temporary: number
  capacity: number
  latencies: number[]
}
type OutcomeHistoryPoint = Pick<HistoryPoint, 'active' | 'goodPct' | 'degradedPct' | 'highPct' | 'failedPct'>
type BoxPlotStats = {
  min: number
  q1: number
  median: number
  q3: number
  max: number
}
type BoxPlotPoint = HistoryPoint & { box: BoxPlotStats }

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
  const stateRef = useRef<DemoState | null>(null)

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
      stateRef.current = null
      setState(null)
      resetSandboxState()
      return
    }

    stateRef.current = nextState
    setState(nextState)

    if (nextState.running || nextState.counters.active_users > 0 || nextState.users.length > 0) {
      setHistoryPoints((current) => appendHistoryPoint(current, makeHistoryPoint(nextState, current.length)))
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

        const currentState = stateRef.current
        if (currentState) {
          setHistoryPoints((current) => {
            const point = makeHistoryPointFromResults(currentState, items, current.length)
            return point ? appendHistoryPoint(current, point) : current
          })
        }
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
          <HeaderIndicators state={state} />
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

function HeaderIndicators({ state }: { state: DemoState | null }) {
  const onlineUsers = state?.users.filter(isUserOnline).length ?? 0
  const plannedUsers = state?.users.length ?? 0
  const throughput = state ? formatMbps(state.bandwidth.total_rate_mbps) : '--'

  return (
    <div className="header-indicators" aria-label="Run summary">
      <span>
        <span className="indicator-dot is-online" />
        Online UEs
        <strong>{state ? `${onlineUsers}/${plannedUsers}` : '--'}</strong>
      </span>
      <span>
        <span className="indicator-dot is-throughput" />
        Throughput
        <strong>{throughput}</strong>
      </span>
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
  const outcomeHistoryPoints = compactOutcomeHistory(historyPoints)

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
          outcomeHistoryPoints,
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
              <StrategyOutcomeMiniChart tone={scenario.tone} points={comparison.outcomeHistory} />

              <div className="comparison-metrics">
                <MetricInline label="Healthy" value={comparison.good} tone="green" />
                <MetricInline label="P50 Latency" value={comparison.p50} tone="purple" />
                <MetricInline label="Critical" value={comparison.critical} tone="critical" />
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

function StrategyOutcomeMiniChart({
  tone,
  points,
}: {
  tone: 'blue' | 'orange' | 'purple'
  points: OutcomeHistoryPoint[]
}) {
  const chartPoints = prepareOutcomeChartPoints(points)
  const maxActive = Math.max(...chartPoints.map((point) => point.active), 1)

  return (
    <div className={`strategy-outcome-mini tone-${tone}`} aria-hidden="true">
      <svg viewBox="0 0 180 42" preserveAspectRatio="none" focusable="false">
        <path d={outcomeBandPath(chartPoints, maxActive, 0, (point) => point.goodPct)} fill="#86d993" />
        <path d={outcomeBandPath(chartPoints, maxActive, (point) => point.goodPct, (point) => point.goodPct + point.degradedPct)} fill="#fbd38d" />
        <path d={outcomeBandPath(chartPoints, maxActive, (point) => point.goodPct + point.degradedPct, (point) => point.goodPct + point.degradedPct + point.highPct)} fill="#fdba74" />
        <path d={outcomeBandPath(chartPoints, maxActive, (point) => point.goodPct + point.degradedPct + point.highPct, (point) => point.goodPct + point.degradedPct + point.highPct + point.failedPct)} fill="#dc2626" />
      </svg>
    </div>
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
    outcomeHistoryPoints: OutcomeHistoryPoint[]
    state: DemoState | null
    activeUsers: number
  },
) {
  const guide = strategyGuide(strategy)
  if (context.isActive && context.state && context.activeUsers > 0) {
    return {
      good: `${goodLatencyPercent(context.state)}%`,
      p50: context.latestPoint ? formatLatency(context.latestPoint.p50) : '--',
      critical: `${criticalPercent(context.state)}%`,
      failed: `${failedPercent(context.state)}%`,
      outcomeHistory: context.outcomeHistoryPoints.length ? context.outcomeHistoryPoints : guide.outcomeHistory,
    }
  }
  return {
    good: `${guide.good}%`,
    p50: `${guide.p50} ms`,
    critical: `${guide.critical}%`,
    failed: `${guide.failed}%`,
    outcomeHistory: guide.outcomeHistory,
  }
}

function strategyGuide(strategy: StrategyName) {
  switch (strategy) {
    case 'standard_gbr':
      return {
        good: 60,
        p50: 145,
        critical: 25,
        failed: 0,
        outcomeHistory: outcomeGuide([
          [0, 100, 0, 0, 0],
          [5, 100, 0, 0, 0],
          [10, 100, 0, 0, 0],
          [15, 100, 0, 0, 0],
          [20, 100, 0, 0, 0],
          [25, 92, 8, 0, 0],
          [30, 86, 14, 0, 0],
          [35, 78, 16, 6, 0],
          [40, 72, 16, 12, 0],
          [45, 66, 16, 18, 0],
          [50, 60, 15, 25, 0],
        ]),
      }
    case 'dynamic_qos':
      return {
        good: 100,
        p50: 70,
        critical: 0,
        failed: 0,
        outcomeHistory: outcomeGuide([
          [0, 100, 0, 0, 0],
          [5, 100, 0, 0, 0],
          [10, 100, 0, 0, 0],
          [15, 100, 0, 0, 0],
          [20, 100, 0, 0, 0],
          [25, 100, 0, 0, 0],
          [30, 100, 0, 0, 0],
          [35, 100, 0, 0, 0],
          [40, 100, 0, 0, 0],
          [45, 100, 0, 0, 0],
          [50, 100, 0, 0, 0],
        ]),
      }
    default:
      return {
        good: 40,
        p50: 245,
        critical: 40,
        failed: 0,
        outcomeHistory: outcomeGuide([
          [0, 100, 0, 0, 0],
          [5, 100, 0, 0, 0],
          [10, 100, 0, 0, 0],
          [15, 88, 12, 0, 0],
          [20, 70, 30, 0, 0],
          [25, 58, 34, 8, 0],
          [30, 46, 36, 18, 0],
          [35, 38, 32, 30, 0],
          [40, 32, 28, 40, 0],
          [45, 28, 22, 50, 0],
          [50, 24, 16, 60, 0],
        ]),
      }
  }
}

function outcomeGuide(points: Array<[number, number, number, number, number]>): OutcomeHistoryPoint[] {
  return points.map(([active, goodPct, degradedPct, highPct, failedPct]) => ({ active, goodPct, degradedPct, highPct, failedPct }))
}

function prepareOutcomeChartPoints(points: OutcomeHistoryPoint[]) {
  const sorted = [...points].sort((left, right) => left.active - right.active)
  if (sorted.length === 0) {
    return outcomeGuide([
      [0, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
    ])
  }
  if (sorted.length === 1) {
    const only = sorted[0]
    return only.active === 0 ? [only, { ...only, active: 1 }] : [{ ...only, active: 0 }, only]
  }
  return sorted
}

function outcomeBandPath(
  points: OutcomeHistoryPoint[],
  maxActive: number,
  lowerValue: number | ((point: OutcomeHistoryPoint) => number),
  upperValue: (point: OutcomeHistoryPoint) => number,
) {
  const top = 3
  const bottom = 39
  const height = bottom - top
  const x = (point: OutcomeHistoryPoint) => ((point.active / maxActive) * 180).toFixed(2)
  const y = (value: number) => (bottom - (clampPercent(value) / 100) * height).toFixed(2)
  const lower = (point: OutcomeHistoryPoint) => (typeof lowerValue === 'number' ? lowerValue : lowerValue(point))
  const upperPoints = points.map((point) => `${x(point)} ${y(upperValue(point))}`)
  const lowerPoints = [...points].reverse().map((point) => `${x(point)} ${y(lower(point))}`)

  return `M ${upperPoints.join(' L ')} L ${lowerPoints.join(' L ')} Z`
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, value))
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
  const high = state?.counters.high_users ?? 0
  const failed = state?.counters.failed_users ?? 0
  const treatments = state ? treatmentCounts(state.users) : { public: 0, reserved: 0, temporary: 0 }
  const activeUsers = state?.counters.active_users ?? 0
  const outcomeData = [
    { name: 'Healthy', value: good, color: '#22a34a' },
    { name: 'Degraded', value: delayed, color: '#f59e0b' },
    { name: 'Critical', value: high, color: '#f97316' },
    { name: 'Failed', value: failed, color: '#dc2626' },
  ]
  const treatmentTotal = treatments.public + treatments.temporary + treatments.reserved
  const treatmentPct = (value: number) => (treatmentTotal > 0 ? Math.round((value / treatmentTotal) * 100) : 0)
  const chartPoints = compactHistoryByActive(historyPoints)
  const chartMaxUsers = Math.max(state?.users.length ?? 0, ...chartPoints.map((point) => point.active), 1)

  return (
    <section className="analytics-column" aria-label="Simulation analytics">
      <Panel title="Latency Distribution">
        <div className="chart-shell trend-shell">
          <div className="chart-legend">
            <span className="legend-item box">P25-P75</span>
            <span className="legend-item purple">Median</span>
            <span className="legend-item red">Failed</span>
          </div>
          <div className="empty-chart">
            <div className="line-chart-wrap">
              {chartPoints.length ? (
                <MeasuredChart>
                  {({ width, height }) => <LatencyBoxPlotChart width={width} height={height} points={chartPoints} maxUsers={chartMaxUsers} />}
                </MeasuredChart>
              ) : (
                <ChartEmpty label="Distribution appears when the run starts" />
              )}
            </div>
            <div className="threshold-stack">
              <span>Critical (&gt;300ms)</span>
              <span>Degraded (150-300ms)</span>
              <span>Healthy (&lt;=150ms)</span>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Upload Outcome Distribution">
        <div className="outcome-layout">
          <div className="area-chart-wrap">
            {chartPoints.length ? (
              <MeasuredChart>
                {({ width, height }) => (
                  <AreaChart width={width} height={height} data={chartPoints} margin={{ top: 6, right: 6, bottom: 0, left: -24 }}>
                    <XAxis dataKey="active" type="number" domain={[0, chartMaxUsers]} ticks={activeAxisTicks(chartMaxUsers)} tickFormatter={formatActiveAxis} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ border: '1px solid #dce3ef', borderRadius: 8, fontSize: 12 }} formatter={(value, name) => [`${Number(value).toFixed(0)}%`, name]} labelFormatter={(value) => formatActiveLabel(Number(value))} />
                    <Area type="monotone" dataKey="goodPct" name="Healthy" stackId="1" stroke="#22a34a" fill="#86d993" isAnimationActive={false} />
                    <Area type="monotone" dataKey="degradedPct" name="Degraded" stackId="1" stroke="#f59e0b" fill="#fbd38d" isAnimationActive={false} />
                    <Area type="monotone" dataKey="highPct" name="Critical" stackId="1" stroke="#f97316" fill="#fdba74" isAnimationActive={false} />
                    <Area type="monotone" dataKey="failedPct" name="Failed" stackId="1" stroke="#dc2626" fill="#fca5a5" isAnimationActive={false} />
                  </AreaChart>
                )}
              </MeasuredChart>
            ) : (
              <ChartEmpty label="Outcome history is empty" />
            )}
          </div>
          <div className="donut-chart-wrap">
            {activeUsers > 0 ? (
              <>
                <MeasuredChart>
                  {({ width, height }) => {
                    const outerRadius = Math.max(22, Math.min(width, height) / 2 - 4)
                    const innerRadius = Math.max(12, outerRadius - 14)
                    return (
                      <PieChart width={width} height={height}>
                        <Pie data={outcomeData} dataKey="value" nameKey="name" innerRadius={innerRadius} outerRadius={outerRadius} paddingAngle={1} stroke="none" isAnimationActive={false}>
                          {outcomeData.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    )
                  }}
                </MeasuredChart>
                <span>{state ? goodLatencyPercent(state) : 0}%</span>
              </>
            ) : (
              <span>--</span>
            )}
          </div>
          <div className="outcome-list">
            <OutcomeRow label="Healthy" value={good} tone="green" />
            <OutcomeRow label="Degraded" value={delayed} tone="orange" />
            <OutcomeRow label="Critical" value={high} tone="critical" />
            <OutcomeRow label="Failed" value={failed} tone="red" />
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
  const users = useMemo(() => state?.users ?? [], [state])
  const deferredResultByID = useDeferredValue(resultByID)
  const deferredLatencyHistoryByID = useDeferredValue(latencyHistoryByID)
  const onlineCount = state?.users.filter(isUserOnline).length ?? 0
  const uploadingCount = users.filter((user) => user.active && (user.uploading || user.running)).length
  const scenario3Hero = heroUserForScenario3(state, deferredResultByID)
  const filterCounts = useMemo(() => boardFilterCounts(users), [users])
  const visibleUsers = useMemo(
    () => sortUsers(filterUsers(users, filter), sortMode, deferredResultByID),
    [users, deferredResultByID, filter, sortMode],
  )

  return (
    <section className="panel activity-board">
      <div className="panel-title-row">
        <div className="ai-monitor-title">
          <h2>AI Upload UE Monitor</h2>
          <span>{onlineCount} online · {uploadingCount} uploading · target AI response &lt;100 ms</span>
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

      <Scenario3HeroCard
        state={state}
        hero={scenario3Hero}
        latestResult={scenario3Hero ? deferredResultByID[scenario3Hero.client_id] : undefined}
      />

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
                runActive={state.running}
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
  runActive,
}: {
  user: DemoUser
  latestResult?: UploadResult
  latencyHistory: number[]
  index: number
  runActive: boolean
}) {
  const online = isUserOnline(user)
  const displayStatus = latestResult ? classifyResultStatus(latestResult) : online && user.status === 'planned' ? 'idle' : user.status
  const displayLatencyMS = latestResult?.latency_ms ?? user.last_latency_ms ?? 0
  const badge = qosBadgeMeta(user)
  const treatmentClass = user.treatment === 'reserved' || user.treatment === 'temporary_grant' ? 'treatment-reserved' : 'treatment-public'
  const uploadProgressActive = runActive && latestResult?.success === true
  const uploadProgressSeed = `${user.client_id}:${latestResult?.attempt ?? user.attempts}:${latestResult?.at ?? user.last_seen ?? ''}`
  const uploadProgressPhase = hashToUnit(`${uploadProgressSeed}:phase`)
  const uploadProgressDuration = 1
  const label = ueShortLabel(user)
  const outcome = aiOutcomeForStatus(displayStatus, user.uploading)
  const latencyText = displayLatencyMS > 0 ? formatLatency(displayLatencyMS) : online ? 'Waiting' : '--'
  const accessibleLabel = `${label}, ${outcome.label}, ${latencyText}, ${badge.label}`

  return (
    <motion.article
      className={`ue-card status-${displayStatus} ${treatmentClass} ${online && !user.active ? 'is-online-idle' : ''} ${online ? '' : 'is-offline'}`}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + (index % 12) * 0.015 }}
    >
      <div className="ue-card-top">
        <div className="ue-card-id">
          <span className="ue-status-dot" />
          <div className="ue-card-name">
            <strong>{label}</strong>
          </div>
        </div>
        <span className={`ue-treatment-badge treatment-${badge.tone}`}>{badge.short}</span>
      </div>

      <div className="ue-card-body">
        <div
          className={`ue-health-indicator ${uploadProgressActive ? 'is-upload-progress' : ''}`}
          style={
            {
              '--ring': uploadProgressActive ? 0.82 : ringPathLength(displayStatus),
              '--ring-color': uploadProgressActive ? '#0ea5e9' : statusColor(displayStatus),
              '--upload-cycle-duration': `${uploadProgressDuration.toFixed(3)}s`,
              '--upload-cycle-delay': `-${(uploadProgressPhase * uploadProgressDuration).toFixed(3)}s`,
            } as CSSProperties
          }
          role={uploadProgressActive ? 'progressbar' : undefined}
          aria-label={uploadProgressActive ? `${label} upload progress` : undefined}
          aria-valuetext={uploadProgressActive ? 'Cycling after successful upload' : undefined}
          aria-hidden={uploadProgressActive ? undefined : true}
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
          <strong>{latencyText}</strong>
        </div>
      </div>

      <SparkBars samples={latencyHistory} />
    </motion.article>
  )
})

function Scenario3HeroCard({
  state,
  hero,
  latestResult,
}: {
  state: DemoState | null
  hero: DemoUser | null
  latestResult?: UploadResult
}) {
  if (!state) {
    return null
  }

  if (state.strategy !== 'dynamic_qos') {
    return (
      <div className="scenario3-hero-empty">
        <strong>Scenario 3 hero card is next for Dynamic QoS.</strong>
        <span>Crowd UE tiles remain live for this mode.</span>
      </div>
    )
  }

  if (!hero) {
    return (
      <div className="scenario3-hero-empty">
        <strong>No matching hero UE for this scenario yet.</strong>
        <span>Start traffic or wait for the next AI upload result.</span>
      </div>
    )
  }

  const latency = latestResult?.latency_ms ?? hero.last_latency_ms ?? 0
  const displayStatus = latestResult ? classifyResultStatus(latestResult) : hero.uploading ? 'running' : hero.status
  const outcome = aiOutcomeForStatus(displayStatus, hero.uploading)
  const beforeLatency = scenario3BeforeLatency(latency)
  const improvement = latency > 0 ? Math.max(0, beforeLatency - latency) : 0
  const grantActive = state.running && (hero.uploading || hero.treatment === 'temporary_grant')
  const recognized = recognitionLabelForUser(hero)
  const latencyText = latency > 0 ? formatLatency(latency) : 'Waiting'
  const targetMet = latestResult?.success === true && latency > 0 && latency < 100

  return (
    <article className={`scenario3-hero-card outcome-${outcome.tone}`}>
      <div className="scenario3-hero-main">
        <header className="scenario3-hero-head">
          <div>
            <span className="scenario3-eyebrow">Intent-assisted QoS</span>
            <h3>{ueShortLabel(hero)} · {deviceTypeForUser(hero)}</h3>
            <p>AI image recognition uplink · 1 image/s · target &lt;100 ms</p>
          </div>
          <span className={`scenario3-status-pill tone-${outcome.tone}`}>
            {grantActive ? 'Intent QoS active' : outcome.label}
          </span>
        </header>

        <div className="scenario3-latency-block">
          <span>AI response latency</span>
          <strong>{latencyText}</strong>
          <em>{outcome.label}</em>
        </div>

        <div className="scenario3-flow" aria-label="Intent to result workflow">
          <span>Intent reported</span>
          <i />
          <span>QoS grant</span>
          <i />
          <span>AI upload</span>
          <i />
          <span>{targetMet ? 'On-time result' : 'Result window'}</span>
        </div>
      </div>

      <div className="scenario3-hero-details">
        <dl>
          <div>
            <dt>Before intent report</dt>
            <dd>{formatLatency(beforeLatency)} · Missed target</dd>
          </div>
          <div>
            <dt>During temporary grant</dt>
            <dd>{latencyText} · {targetMet ? 'On time' : outcome.label}</dd>
          </div>
          <div>
            <dt>Latency improvement</dt>
            <dd>{improvement > 0 ? `-${formatLatency(improvement)}` : '--'}</dd>
          </div>
          <div>
            <dt>Temporary QoS grant</dt>
            <dd>Low-latency flow · 2 Mbps GBR · PDB 100 ms</dd>
          </div>
          <div>
            <dt>Last AI result</dt>
            <dd>{latestResult?.success ? `${recognized} recognized · success` : 'Waiting for successful result'}</dd>
          </div>
        </dl>
        <aside>
          The UE reports an upcoming AI image upload before the burst starts. The network applies an elevated QoS grant only for this short service window.
        </aside>
      </div>
    </article>
  )
}

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

function LatencyBoxPlotChart({
  width,
  height,
  points,
  maxUsers,
}: {
  width: number
  height: number
  points: HistoryPoint[]
  maxUsers: number
}) {
  const [tooltip, setTooltip] = useState<{ left: number; top: number; point: BoxPlotPoint } | null>(null)
  const margin = { top: 10, right: 42, bottom: 26, left: 34 }
  const innerWidth = Math.max(1, width - margin.left - margin.right)
  const innerHeight = Math.max(1, height - margin.top - margin.bottom)
  const plotPoints = points
    .map((point) => {
      const box = boxPlotStats(point.latencies)
      return box ? { ...point, box } : null
    })
    .filter((point): point is BoxPlotPoint => Boolean(point))
  const y = (value: number) => margin.top + (1 - clampChartLatency(value) / 1000) * innerHeight
  const x = (active: number) => margin.left + (active / Math.max(maxUsers, 1)) * innerWidth
  const yTicks = [0, 150, 300, 600, 1000]
  const xTicks = activeAxisTicks(maxUsers)
  const boxWidth = Math.max(10, Math.min(24, (innerWidth / Math.max(plotPoints.length, 1)) * 0.62))

  return (
    <div className="latency-box-plot">
      <svg width={width} height={height} role="img" aria-label="Latency box plot by active UE count">
        <rect className="box-band band-critical" x={margin.left} y={y(1000)} width={innerWidth} height={Math.max(0, y(300) - y(1000))} />
        <rect className="box-band band-degraded" x={margin.left} y={y(300)} width={innerWidth} height={Math.max(0, y(150) - y(300))} />
        <rect className="box-band band-healthy" x={margin.left} y={y(150)} width={innerWidth} height={Math.max(0, y(0) - y(150))} />

        {yTicks.map((tick) => (
          <g key={tick}>
            <line className="box-grid-line" x1={margin.left} x2={margin.left + innerWidth} y1={y(tick)} y2={y(tick)} />
            <text className="box-axis-label y-label" x={margin.left + innerWidth + 8} y={y(tick) + 3}>{formatLatencyAxis(tick)}</text>
          </g>
        ))}

        {xTicks.map((tick) => (
          <g key={tick}>
            <line className="box-x-tick" x1={x(tick)} x2={x(tick)} y1={margin.top + innerHeight} y2={margin.top + innerHeight + 4} />
            <text className="box-axis-label x-label" x={x(tick)} y={margin.top + innerHeight + 17}>{tick}</text>
          </g>
        ))}

        <line className="box-axis-line" x1={margin.left} x2={margin.left + innerWidth} y1={margin.top + innerHeight} y2={margin.top + innerHeight} />
        <line className="box-axis-line" x1={margin.left} x2={margin.left} y1={margin.top} y2={margin.top + innerHeight} />

        {plotPoints.map((point) => {
          const pointX = x(point.active)
          const minY = y(point.box.min)
          const q1Y = y(point.box.q1)
          const medianY = y(point.box.median)
          const q3Y = y(point.box.q3)
          const maxY = y(point.box.max)
          const boxHeight = Math.max(4, q1Y - q3Y)
          const boxTop = q1Y - q3Y < 4 ? medianY - boxHeight / 2 : q3Y
          const boxTone = latencyToneForDistribution(point.box.q3, point.p99)
          return (
            <g
              className={`box-plot-point tone-${boxTone}`}
              key={`${point.tick}-${point.active}`}
              onMouseMove={(event) => {
                const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
                setTooltip({
                  left: rect ? event.clientX - rect.left + 12 : pointX + 12,
                  top: rect ? event.clientY - rect.top + 12 : medianY + 12,
                  point,
                })
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              <line className="box-whisker" x1={pointX} x2={pointX} y1={maxY} y2={minY} />
              <line className="box-cap" x1={pointX - boxWidth * 0.5} x2={pointX + boxWidth * 0.5} y1={minY} y2={minY} />
              <line className="box-cap" x1={pointX - boxWidth * 0.5} x2={pointX + boxWidth * 0.5} y1={maxY} y2={maxY} />
              <rect className="box-iqr" x={pointX - boxWidth / 2} y={boxTop} width={boxWidth} height={boxHeight} rx={2.5} />
              <line className="box-median" x1={pointX - boxWidth / 2} x2={pointX + boxWidth / 2} y1={medianY} y2={medianY} />
              {point.failedCount > 0 ? <circle className="box-failed-dot" cx={pointX + boxWidth * 0.62} cy={y(1000) + 8} r={Math.min(5, 2.5 + point.failedCount / 4)} /> : null}
            </g>
          )
        })}
      </svg>
      {tooltip ? (
        <div className="box-tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
          <strong>{formatActiveLabel(tooltip.point.active)}</strong>
          <span>Min {formatLatency(tooltip.point.box.min)} / P25 {formatLatency(tooltip.point.box.q1)}</span>
          <span>Median {formatLatency(tooltip.point.box.median)} / P75 {formatLatency(tooltip.point.box.q3)}</span>
          <span>Max {formatLatency(tooltip.point.box.max)}</span>
          <em>
            Healthy {tooltip.point.goodCount} / Degraded {tooltip.point.degradedCount} / Critical {tooltip.point.highCount} / Failed {tooltip.point.failedCount}
          </em>
        </div>
      ) : null}
    </div>
  )
}

function ChartEmpty({ label }: { label: string }) {
  return <div className="chart-empty-label">{label}</div>
}

function MeasuredChart({ children }: { children: (size: { width: number; height: number }) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const node = ref.current
    if (!node) {
      return undefined
    }

    const updateSize = () => {
      const rect = node.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }))
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return <div className="measured-chart" ref={ref}>{size.width > 0 && size.height > 0 ? children(size) : null}</div>
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
    case 'online':
      return 'Online'
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

function ueShortLabel(user: DemoUser) {
  return `UE-${String(user.index).padStart(3, '0')}`
}

function deviceTypeForUser(user: DemoUser) {
  const devices = ['Robot Vision Unit', 'Drone Camera', 'AR Inspection Glasses', 'Fixed AI Camera']
  return devices[(user.index - 1) % devices.length]
}

function recognitionLabelForUser(user: DemoUser) {
  const labels = ['pallet', 'safety vest', 'barcode', 'tool case', 'package']
  return labels[(user.index - 1) % labels.length]
}

function qosBadgeMeta(user: DemoUser) {
  if (!isUserOnline(user)) {
    return { short: 'Wait', label: 'Waiting', tone: 'waiting' }
  }
  switch (user.treatment) {
    case 'reserved':
      return { short: 'GBR', label: 'GBR QoS flow', tone: 'reserved' }
    case 'temporary_grant':
      return { short: 'Temp', label: 'Temporary QoS grant', tone: 'temporary' }
    default:
      return { short: 'Non-GBR', label: 'Non-GBR QoS flow', tone: 'public' }
  }
}

function aiOutcomeForStatus(status: DemoUserStatus, uploading?: boolean) {
  if (uploading && status === 'running') {
    return { label: 'Uploading', tone: 'running' }
  }
  switch (status) {
    case 'good':
      return { label: 'Healthy', tone: 'healthy' }
    case 'delayed':
      return { label: 'Degraded', tone: 'degraded' }
    case 'high':
      return { label: 'Critical', tone: 'critical' }
    case 'failed':
      return { label: 'Failed', tone: 'failed' }
    case 'running':
      return { label: 'Uploading', tone: 'running' }
    case 'idle':
    case 'planned':
    default:
      return { label: 'Waiting', tone: 'waiting' }
  }
}

function heroUserForScenario3(state: DemoState | null, resultByID: Record<string, UploadResult>) {
  if (!state || state.strategy !== 'dynamic_qos') {
    return null
  }
  const activeUsers = state.users.filter((user) => user.active)
  return (
    activeUsers.find((user) => {
      const result = resultByID[user.client_id]
      return result?.success === true && result.latency_ms > 0 && result.latency_ms < 100
    }) ??
    activeUsers.find((user) => resultByID[user.client_id]?.success === true) ??
    activeUsers.find((user) => user.uploading) ??
    activeUsers.find((user) => user.running) ??
    null
  )
}

function scenario3BeforeLatency(latencyMS: number) {
  if (latencyMS <= 0) {
    return 172
  }
  return Math.min(280, Math.max(145, latencyMS + 111))
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

function latencyToneForP75(latencyMS: number) {
  if (latencyMS >= 900) {
    return 'failed'
  }
  if (latencyMS <= 150) {
    return 'healthy'
  }
  if (latencyMS <= 300) {
    return 'degraded'
  }
  return 'critical'
}

function latencyToneForDistribution(p75MS: number, p99MS: number) {
  const p75Tone = latencyToneForP75(p75MS)
  if (p75Tone === 'healthy' && p99MS > 150) {
    return 'degraded'
  }
  return p75Tone
}

function formatActiveAxis(value: number) {
  if (!Number.isFinite(value)) {
    return ''
  }
  return value.toFixed(0)
}

function formatActiveLabel(value: number) {
  if (!Number.isFinite(value)) {
    return ''
  }
  return `${value.toFixed(0)} active UEs`
}

function compactHistoryByActive(points: HistoryPoint[]) {
  const latestByActive = new Map<number, HistoryPoint>()
  for (const point of points) {
    latestByActive.set(point.active, point)
  }
  return [...latestByActive.values()].sort((left, right) => left.active - right.active)
}

function compactOutcomeHistory(points: HistoryPoint[]): OutcomeHistoryPoint[] {
  return compactHistoryByActive(points).map(({ active, goodPct, degradedPct, highPct, failedPct }) => ({ active, goodPct, degradedPct, highPct, failedPct }))
}

function goodLatencyPercent(state: DemoState) {
  return state.counters.active_users > 0 ? Math.round((state.counters.good_users / state.counters.active_users) * 100) : 0
}

function criticalPercent(state: DemoState) {
  return state.counters.active_users > 0 ? Math.round((state.counters.high_users / state.counters.active_users) * 100) : 0
}

function failedPercent(state: DemoState) {
  return state.counters.active_users > 0 ? Math.round((state.counters.failed_users / state.counters.active_users) * 100) : 0
}

function prioritizedCount(state: DemoState) {
  return state.counters.protected_users + state.counters.temporary_grants
}

function isUserOnline(user: DemoUser) {
  return user.online ?? user.active
}

function percentile(samples: number[], fraction: number) {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

function boxPlotStats(samples: number[]): BoxPlotStats | null {
  const sorted = samples
    .map(clampChartLatency)
    .filter((value) => value > 0)
    .sort((left, right) => left - right)
  if (sorted.length === 0) {
    return null
  }
  return {
    min: sorted[0],
    q1: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
    max: sorted[sorted.length - 1],
  }
}

function quantileSorted(values: number[], fraction: number) {
  if (values.length === 1) {
    return values[0]
  }
  const position = (values.length - 1) * fraction
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const weight = position - lowerIndex
  return values[lowerIndex] + (values[upperIndex] - values[lowerIndex]) * weight
}

function activeAxisTicks(maxUsers: number) {
  const safeMax = Math.max(1, Math.ceil(maxUsers))
  const step = safeMax <= 50 ? 5 : 10
  const ticks: number[] = []
  for (let value = 0; value <= safeMax; value += step) {
    ticks.push(value)
  }
  if (ticks.at(-1) !== safeMax) {
    ticks.push(safeMax)
  }
  return ticks
}

function appendHistoryPoint(points: HistoryPoint[], point: HistoryPoint) {
  if (!shouldRecordHistoryPoint(point)) {
    return points
  }
  return [...points.filter((existing) => existing.active !== point.active), point].slice(-90)
}

function shouldRecordHistoryPoint(point: HistoryPoint) {
  return point.active === 0 || point.latencies.length >= point.active
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
    highPct: percentOfActive(state.counters.high_users),
    failedPct: percentOfActive(state.counters.failed_users),
    goodCount: state.counters.good_users,
    degradedCount: state.counters.delayed_users,
    highCount: state.counters.high_users,
    failedCount: state.counters.failed_users,
    prioritized: prioritizedCount(state),
    temporary: state.counters.temporary_grants,
    capacity: state.bandwidth.total_rate_mbps,
    latencies: stateLatencies,
  }
}

function makeHistoryPointFromResults(state: DemoState, items: UploadResult[], tick: number): HistoryPoint | null {
  const resultByID = new Map(items.map((item) => [item.id, item]))
  const bucketSize = completedResultBucketSize(state, items.length)
  if (bucketSize <= 0) {
    return null
  }
  const reportingUsers = state.users.filter((user) => resultByID.has(user.client_id)).slice(0, bucketSize)
  const selectedItems = reportingUsers
    .map((user) => resultByID.get(user.client_id))
    .filter((item): item is UploadResult => Boolean(item))
  if (selectedItems.length < bucketSize) {
    return null
  }
  const resultLatencies = selectedItems
    .map((item) => item.latency_ms)
    .filter((value) => value > 0)
  let goodCount = 0
  let degradedCount = 0
  let highCount = 0
  let failedCount = 0

  for (const item of selectedItems) {
    switch (classifyResultStatus(item)) {
      case 'good':
        goodCount++
        break
      case 'delayed':
        degradedCount++
        break
      case 'high':
        highCount++
        break
      case 'failed':
        failedCount++
        break
      default:
        break
    }
  }

  const percentOfActive = (value: number) => Math.round((value / bucketSize) * 100)

  return {
    tick,
    active: bucketSize,
    p50: clampChartLatency(percentile(resultLatencies, 0.5)),
    p99: clampChartLatency(percentile(resultLatencies, 0.99)),
    goodPct: percentOfActive(goodCount),
    degradedPct: percentOfActive(degradedCount),
    highPct: percentOfActive(highCount),
    failedPct: percentOfActive(failedCount),
    goodCount,
    degradedCount,
    highCount,
    failedCount,
    prioritized: prioritizedCount({ ...state, users: reportingUsers }),
    temporary: treatmentCounts(reportingUsers).temporary,
    capacity: state.bandwidth.total_rate_mbps,
    latencies: resultLatencies,
  }
}

function completedResultBucketSize(state: DemoState, resultCount: number) {
  const rampStep = state.ramp_per_second > 0 ? state.ramp_per_second : 5
  const plannedUsers = state.users.length || resultCount
  return Math.min(Math.floor(resultCount / rampStep) * rampStep, plannedUsers)
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
    case 'online':
      return users.filter(isUserOnline)
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
    online: users.filter(isUserOnline).length,
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

function hashToUnit(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4294967295
}

function statusRank(user: DemoUser, resultByID: Record<string, UploadResult>) {
  const status = resultByID[user.client_id] ? classifyResultStatus(resultByID[user.client_id]) : user.status
  switch (status) {
    case 'failed':
      return 6
    case 'high':
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
  return 'high'
}

function ringPathLength(status: DemoUserStatus) {
  switch (status) {
    case 'good':
      return 0.86
    case 'delayed':
      return 0.62
    case 'high':
      return 0.78
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
    case 'high':
      return '#f97316'
    case 'failed':
      return '#dc2626'
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
        expectation: 'Guarantees 20 UEs; later UEs compete.',
      }
    case 'dynamic_qos':
      return {
        tone: 'purple' as const,
        short: 'Temporary grants',
        icon: <Sparkles size={16} />,
        expectation: 'Guarantees all planned UEs with temporary grants.',
      }
    default:
      return {
        tone: 'orange' as const,
        short: 'All public',
        icon: <Activity size={16} />,
        expectation: 'Guarantees 20 UEs, then all public traffic degrades.',
      }
  }
}

export default App
