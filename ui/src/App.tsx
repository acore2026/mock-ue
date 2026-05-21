import { memo, startTransition, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Box, Card, CardContent, Chip, Typography } from '@mui/material'
import {
  Activity,
  AlertTriangle,
  Camera,
  Gauge,
  ImageUp,
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
  Line,
  LineChart,
  ReferenceArea,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DemoStreamStatus } from './api'
import type { DemoState, DemoStreamEvent, DemoUser, DemoUserStatus, StrategyName, UploadResult } from './types'
import scenario3HeroImage from './assets/scenario3-robot-street-view.webp'
import './App.css'

const strategies: Array<{ label: string; value: StrategyName; short: string; tone: 'blue' | 'orange' | 'purple' }> = [
  { label: 'No Optimization', value: 'no_optimization', short: 'All public', tone: 'orange' },
  { label: 'Standard GBR', value: 'standard_gbr', short: 'Static reservation', tone: 'blue' },
  { label: 'Dynamic QoS', value: 'dynamic_qos', short: 'Temporary grants', tone: 'purple' },
]

const filterOptions = ['all', 'uploading', 'temporary', 'healthy', 'delayed', 'degraded'] as const
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
type OutcomeSummary = {
  activeUsers: number
  completedUsers: number
  good: number
  delayed: number
  high: number
  failed: number
  goodPct: number
  degradedPct: number
  highPct: number
  failedPct: number
}
type OutcomeHeatmapPoint = {
  id: string
  label: string
  status: string
  tone: string
  value: number
  x: number
  y: number
}
type BoxPlotStats = {
  min: number
  q1: number
  median: number
  q3: number
  max: number
}
type LatencyBoxPoint = {
  active: number
  failedCount: number
  max: number
  median: number
  min: number
  q1: number
  q3: number
}
type EChartsInstance = ReturnType<typeof import('echarts/core')['init']>
type LiveResultState = {
  resultByID: Record<string, UploadResult>
  latencyHistoryByID: Record<string, number[]>
}
type DeviceCardView = {
  user: DemoUser
  label: string
  online: boolean
  displayStatus: DemoUserStatus
  displayLatencyMS: number
  treatmentClass: string
  outcome: { label: string; tone: string }
  latencyText: string
  accessibleLabel: string
  latencyHistory: number[]
}

const initialPendingState: PendingActions = {
  mode: false,
  run: false,
  stop: false,
  reset: false,
  refresh: false,
}

function emptyLiveResultState(): LiveResultState {
  return { resultByID: {}, latencyHistoryByID: {} }
}

function sameUploadResult(left: UploadResult | undefined, right: UploadResult) {
  return Boolean(
    left &&
    left.attempt === right.attempt &&
    left.success === right.success &&
    left.latency_ms === right.latency_ms &&
    left.phase_ms === right.phase_ms &&
    left.at === right.at,
  )
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
          resultByID={liveState.resultByID}
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
  const [liveResults, setLiveResults] = useState<LiveResultState>(() => emptyLiveResultState())
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
    setLiveResults(emptyLiveResultState())
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
        setLiveResults((current) => {
          let nextResultByID = current.resultByID
          let nextLatencyHistoryByID = current.latencyHistoryByID
          let changed = false

          for (const item of items) {
            if (!sameUploadResult(nextResultByID[item.id], item)) {
              if (nextResultByID === current.resultByID) {
                nextResultByID = { ...current.resultByID }
              }
              nextResultByID[item.id] = item
              changed = true
            }
          }

          for (const item of freshItems) {
            if (nextLatencyHistoryByID === current.latencyHistoryByID) {
              nextLatencyHistoryByID = { ...current.latencyHistoryByID }
            }
            const history = nextLatencyHistoryByID[item.id] ? [...nextLatencyHistoryByID[item.id]] : []
            history.push(item.latency_ms)
            nextLatencyHistoryByID[item.id] = history.slice(-36)
            changed = true
          }

          return changed ? { resultByID: nextResultByID, latencyHistoryByID: nextLatencyHistoryByID } : current
        })

        const currentState = stateRef.current
        if (currentState && freshItems.length > 0) {
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
    latencyHistoryByID: liveResults.latencyHistoryByID,
    loading,
    pending,
    resultByID: liveResults.resultByID,
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
      <AnalyticsColumn state={state} historyPoints={historyPoints} resultByID={resultByID} />
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
  resultByID,
  pending,
  pendingStrategy,
  onModeSelect,
}: {
  state: DemoState | null
  historyPoints: HistoryPoint[]
  resultByID: Record<string, UploadResult>
  pending: boolean
  pendingStrategy: StrategyName | null
  onModeSelect: (strategy: StrategyName) => Promise<void>
}) {
  const activeStrategy = state?.strategy ?? null
  const liveOutcome = useMemo(() => liveOutcomeSummary(state, resultByID), [resultByID, state])
  const activeUsers = liveOutcome.activeUsers
  const latestPoint = historyPoints.at(-1)
  const outcomeHistoryPoints = useMemo(() => mergeLiveOutcomePoint(historyPoints, liveOutcome), [historyPoints, liveOutcome])

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
          liveOutcome,
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
                <MetricInline label="Delayed" value={comparison.delayed} tone="orange" />
                <MetricInline label="Degraded" value={comparison.degraded} tone="red" />
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
      <MeasuredChart>
        {({ width, height }) => (
          <AreaChart width={width} height={height} data={chartPoints} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <XAxis dataKey="active" type="number" domain={[0, maxActive]} hide />
            <YAxis domain={[0, 100]} hide />
            <Area type="monotone" dataKey="goodPct" stackId="outcome" stroke="none" fill="#86d993" isAnimationActive={false} />
            <Area type="monotone" dataKey="degradedPct" stackId="outcome" stroke="none" fill="#fbd38d" isAnimationActive={false} />
            <Area type="monotone" dataKey="highPct" stackId="outcome" stroke="none" fill="#fca5a5" isAnimationActive={false} />
          </AreaChart>
        )}
      </MeasuredChart>
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
    liveOutcome: OutcomeSummary
  },
) {
  const guide = strategyGuide(strategy)
  if (context.isActive && context.state && context.activeUsers > 0) {
    const liveReady = context.liveOutcome.completedUsers > 0
    return {
      good: `${liveReady ? context.liveOutcome.goodPct : guide.good}%`,
      p50: context.latestPoint ? formatLatency(context.latestPoint.p50) : '--',
      delayed: `${liveReady ? context.liveOutcome.degradedPct : guide.delayed}%`,
      degraded: `${liveReady ? context.liveOutcome.highPct : guide.degraded}%`,
      outcomeHistory: context.outcomeHistoryPoints.length ? context.outcomeHistoryPoints : guide.outcomeHistory,
    }
  }
  return {
    good: `${guide.good}%`,
    p50: `${guide.p50} ms`,
    delayed: `${guide.delayed}%`,
    degraded: `${guide.degraded}%`,
    outcomeHistory: guide.outcomeHistory,
  }
}

function strategyGuide(strategy: StrategyName) {
  switch (strategy) {
    case 'standard_gbr':
      return {
        good: 60,
        p50: 145,
        delayed: 15,
        degraded: 25,
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
        delayed: 0,
        degraded: 0,
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
        delayed: 16,
        degraded: 60,
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

function latencyBarData(samples: number[], barCount: number) {
  const displaySamples = samples.slice(-barCount)
  return Array.from({ length: barCount }, (_, index) => {
    const value = displaySamples[index - (barCount - displaySamples.length)] ?? 0
    return {
      index,
      latency: clampChartLatency(value),
    }
  })
}

function latencyBarHeight(latency: number, chartHeight: number) {
  if (latency <= 0) {
    return 1
  }
  return Math.max(2, Math.round((Math.min(latency, LATENCY_BAR_MAX_MS) / LATENCY_BAR_MAX_MS) * chartHeight))
}

function AnalyticsColumn({
  state,
  historyPoints,
  resultByID,
}: {
  state: DemoState | null
  historyPoints: HistoryPoint[]
  resultByID: Record<string, UploadResult>
}) {
  const outcome = useMemo(() => liveOutcomeSummary(state, resultByID), [resultByID, state])
  const good = outcome.good
  const delayed = outcome.delayed
  const degraded = outcome.high + outcome.failed
  const treatments = state ? treatmentCounts(state.users) : { public: 0, reserved: 0, temporary: 0 }
  const activeUsers = outcome.activeUsers
  const treatmentTotal = treatments.public + treatments.temporary + treatments.reserved
  const treatmentPct = (value: number) => (treatmentTotal > 0 ? Math.round((value / treatmentTotal) * 100) : 0)
  const chartPoints = compactHistoryByActive(historyPoints)
  const outcomeChartPoints = mergeLiveOutcomePoint(chartPoints, outcome)
  const chartMaxUsers = Math.max(state?.users.length ?? 0, ...outcomeChartPoints.map((point) => point.active), 1)
  const chartsReady = Boolean(state?.running && chartPoints.length)
  const outcomeChartsReady = Boolean(state?.running && outcomeChartPoints.length)

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
              {chartsReady ? (
                <MeasuredChart>
                  {({ width, height }) => <LatencyBoxPlotChart width={width} height={height} points={chartPoints} />}
                </MeasuredChart>
              ) : (
                <ChartEmpty label="Standby until live latency data arrives" />
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Upload Outcome Distribution">
        <div className="outcome-layout">
          <div className="area-chart-wrap">
            {outcomeChartsReady ? (
              <MeasuredChart>
                {({ width, height }) => (
                  <AreaChart width={width} height={height} data={outcomeChartPoints} margin={{ top: 6, right: 6, bottom: 0, left: -24 }}>
                    <XAxis dataKey="active" type="number" domain={[0, chartMaxUsers]} ticks={activeAxisTicks(chartMaxUsers)} tickFormatter={formatActiveAxis} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(value) => `${value}%`} tick={{ fontSize: 10, fill: '#667085' }} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ border: '1px solid #dce3ef', borderRadius: 8, fontSize: 12 }} formatter={(value, name) => [`${Number(value).toFixed(0)}%`, name]} labelFormatter={(value) => formatActiveLabel(Number(value))} />
                    <Area type="monotone" dataKey="goodPct" name="Healthy" stackId="1" stroke="#22a34a" fill="#86d993" isAnimationActive={false} />
                    <Area type="monotone" dataKey="degradedPct" name="Delayed" stackId="1" stroke="#f59e0b" fill="#fbd38d" isAnimationActive={false} />
                    <Area type="monotone" dataKey="highPct" name="Degraded" stackId="1" stroke="#ef4444" fill="#fca5a5" isAnimationActive={false} />
                  </AreaChart>
                )}
              </MeasuredChart>
            ) : (
              <ChartEmpty label="Standby until live outcome data arrives" />
            )}
          </div>
          <OutcomeHeatmap state={state} resultByID={resultByID} />
          <div className="outcome-list">
            <OutcomeRow label="Healthy" value={good} tone="green" />
            <OutcomeRow label="Delayed" value={delayed} tone="yellow" />
            <OutcomeRow label="Degraded" value={degraded} tone="red" />
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
  const throttledLatencyHistoryByID = useThrottledValue(latencyHistoryByID, LATENCY_BARS_UPDATE_MS)
  const deferredLatencyHistoryByID = useDeferredValue(throttledLatencyHistoryByID)
  const scenarioHero = heroUserForStrategy(state, deferredResultByID)
  const heroUsers = useMemo(() => (scenarioHero ? [scenarioHero] : []), [scenarioHero])
  const heroIDs = useMemo(() => new Set(heroUsers.map((user) => user.client_id)), [heroUsers])
  const crowdUsers = useMemo(() => users.filter((user) => !heroIDs.has(user.client_id)), [users, heroIDs])
  const crowdCards = useMemo(
    () => crowdUsers.map((user) => makeDeviceCardView(user, deferredResultByID[user.client_id], deferredLatencyHistoryByID[user.client_id] ?? [])),
    [crowdUsers, deferredLatencyHistoryByID, deferredResultByID],
  )
  const filterCounts = useMemo(() => boardFilterCounts(crowdCards), [crowdCards])
  const visibleUsers = useMemo(
    () => sortDeviceCards(filterDeviceCards(crowdCards, filter), sortMode),
    [crowdCards, filter, sortMode],
  )
  return (
    <section className="panel activity-board ue-monitor-root">
      <div className="ue-monitor-top">
        <div className="ue-monitor-title">
          <h2>UE MONITOR</h2>
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

      <div className={`ue-monitor-body ${heroUsers.length ? 'has-hero' : 'no-hero'}`}>
        {heroUsers.length ? (
          <div className="ue-hero-column" aria-label="Hero UE cards">
            {heroUsers.map((hero) => (
              <ScenarioHeroCard
                key={hero.client_id}
                state={state}
                hero={hero}
                latestResult={deferredResultByID[hero.client_id]}
                latencyHistory={deferredLatencyHistoryByID[hero.client_id] ?? []}
              />
            ))}
          </div>
        ) : null}

        <div className="ue-crowd-board">
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
                {visibleUsers.map((card) => (
                  <DeviceCard
                    key={card.user.client_id}
                    card={card}
                  />
                ))}
              </div>
            ) : (
              <div className="board-empty">No other UEs match {labelForFilter(filter)}</div>
            )
          ) : (
            <div className="board-empty">No session prepared</div>
          )}
        </div>
      </div>
    </section>
  )
})

const DeviceCard = memo(function DeviceCard({
  card,
}: {
  card: DeviceCardView
}) {
  return (
    <article
      className={`ue-card status-${card.displayStatus} ${card.treatmentClass} ${card.online && !card.user.active ? 'is-online-idle' : ''} ${card.online ? '' : 'is-offline'}`}
      aria-label={card.accessibleLabel}
      title={card.accessibleLabel}
    >
      <div className="ue-card-top">
        <div className="ue-card-id">
          <span className="ue-status-dot" />
          <div className="ue-card-name">
            <strong>{card.label}</strong>
          </div>
        </div>
        <div className="ue-card-badges">
          <span className="ue-dynamic-qos-badge" aria-label="Dynamic QoS">
            <Sparkles size={14} aria-hidden="true" />
          </span>
        </div>
      </div>

      <div className="ue-card-body">
        <div className="ue-card-metrics">
          <strong>{card.latencyText}</strong>
        </div>
      </div>

      <CrowdLatencyStrip className={`crowd-latency-bars tone-${card.outcome.tone}`} samples={card.latencyHistory} />
    </article>
  )
}, areDeviceCardsEqual)

function areDeviceCardsEqual(previous: { card: DeviceCardView }, next: { card: DeviceCardView }) {
  return (
    previous.card.user.client_id === next.card.user.client_id &&
    previous.card.user.active === next.card.user.active &&
    previous.card.online === next.card.online &&
    previous.card.displayStatus === next.card.displayStatus &&
    previous.card.displayLatencyMS === next.card.displayLatencyMS &&
    previous.card.treatmentClass === next.card.treatmentClass &&
    previous.card.outcome.tone === next.card.outcome.tone &&
    previous.card.latencyText === next.card.latencyText &&
    previous.card.latencyHistory === next.card.latencyHistory
  )
}

function ScenarioHeroCard({
  state,
  hero,
  latestResult,
  latencyHistory,
}: {
  state: DemoState | null
  hero: DemoUser | null
  latestResult?: UploadResult
  latencyHistory: number[]
}) {
  if (!state) {
    return null
  }

  if (!hero) {
    return (
      <div className="scenario3-hero-empty">
        <strong>No matching hero UE for this scenario yet.</strong>
        <span>Start traffic or wait for the next AI upload result.</span>
      </div>
    )
  }

  const uploadDelay = latestResult?.latency_ms ?? hero.last_latency_ms ?? 0
  const displayStatus = latestResult ? classifyResultStatus(latestResult) : hero.uploading ? 'running' : hero.status
  const outcome = aiOutcomeForStatus(displayStatus, hero.uploading)
  const recognized = recognitionLabelForUser(hero)
  const latencyText = uploadDelay > 0 ? formatLatency(uploadDelay) : 'Waiting'
  const targetMet = latestResult?.success === true && uploadDelay > 0 && uploadDelay < 100
  const heroProfile = heroProfileForStrategy(state.strategy)
  const resultLabel = latestResult?.success ? `${recognized} recognized` : 'Waiting for result'
  const e2eDelayText = uploadDelay > 0 ? formatLatency(e2eDelayForUploadDelay(uploadDelay, hero.index + hero.attempts)) : '--'

  return (
    <Card className={`scenario3-hero-card outcome-${outcome.tone}`} variant="outlined">
      <CardContent className="scenario3-hero-content">
        <div className="scenario3-hero-head">
          <Box className="scenario3-title-wrap">
            <div className="scenario3-hero-title-row">
              <span className="scenario3-hero-dot" aria-hidden="true" />
              <Typography className="scenario3-hero-title" component="h3">
                {ueShortLabel(hero)}
              </Typography>
            </div>
            <Typography className="scenario3-identity-line" component="span">
              {hero.client_ip} · IMSI {imsiForUser(hero)}
            </Typography>
            <div className="scenario3-pdu-line" aria-label="PDU session details">
              <span>PDU-SESSION 1</span>
              <span>DNN ai-vision</span>
              <span>S-NSSAI 1/010203</span>
            </div>
          </Box>
          <div className="scenario3-chip-row">
            <Chip className={`scenario3-chip tone-${outcome.tone}`} size="small" label={outcome.label} />
            <Chip className="scenario3-chip tone-grant" size="small" icon={heroProfile.dynamic ? <Sparkles size={12} aria-hidden="true" /> : undefined} label={heroProfile.chip} />
          </div>
        </div>

        <Box className={`scenario3-latency-section tone-${heroLatencyTone(uploadDelay)}`} aria-label="Image upload latency section">
          <div className="scenario3-latency-block">
            <span><ImageUp size={13} aria-hidden="true" /> IMAGE UPLOAD LATENCY</span>
            <strong>{latencyText}</strong>
            <em>{targetMet ? 'Target met' : 'Target <100 ms'}</em>
          </div>
          <div className="scenario3-latency-details">
            <span>{deviceTypeForUser(hero)}</span>
            <strong>AI image recognition · {formatUploadFrequency(state.scenario.interval_ms)}</strong>
          </div>
          <div className="scenario3-latency-spark" aria-hidden="true">
            <LatencyBarsStrip className={`hero-latency-bars tone-${heroLatencyTone(uploadDelay)}`} samples={latencyHistory} barCount={12} />
          </div>
        </Box>

        <ScenarioHeroPanels
          key={`${state.strategy}:${state.running ? 'running' : 'idle'}`}
          baselineBandwidthMbps={state.bandwidth.public_rate_mbps}
          frequency={formatUploadFrequency(state.scenario.interval_ms)}
          intentSeed={hero.index + hero.attempts}
          latencyText={latencyText}
          running={Boolean(state.running)}
          strategy={state.strategy}
          targetMet={targetMet}
        />

        <Box className="scenario3-latest-image">
          <div className="scenario3-image-caption">
            <span>Latest Image</span>
            <strong>{resultLabel}</strong>
          </div>
          <Box component="img" src={scenario3HeroImage} alt="" aria-hidden="true" />
          <div className="scenario3-e2e-delay">
            <span>E2E delay</span>
            <strong>{e2eDelayText}</strong>
          </div>
        </Box>
      </CardContent>
    </Card>
  )
}

const ScenarioHeroPanels = memo(function ScenarioHeroPanels({
  baselineBandwidthMbps,
  frequency,
  intentSeed,
  latencyText,
  running,
  strategy,
  targetMet,
}: {
  baselineBandwidthMbps: number
  frequency: string
  intentSeed: number
  latencyText: string
  running: boolean
  strategy: StrategyName
  targetMet: boolean
}) {
  const chartClock = useQosCycleClock(running, BANDWIDTH_UPDATE_MS)
  const profileClock = useQosProfileClock(running)
  const dynamic = strategy === 'dynamic_qos'

  return (
    <>
      <Scenario3TrafficChart
        baselineBandwidthMbps={baselineBandwidthMbps}
        highlightPeak={dynamic}
        running={running}
        qosStarted={dynamic ? chartClock.hasRun : running}
        nowMS={chartClock.nowMS}
        cycleAnchorMS={chartClock.cycleAnchorMS}
      />

      <Box className={`scenario3-feature-grid ${dynamic ? '' : 'is-qos-only'}`}>
        {dynamic ? (
          <Scenario3IntentPanel
            latencyText={latencyText}
            targetMet={targetMet}
            frequency={frequency}
            sizeBytes={intentSizeBytes(intentSeed, profileClock.cycleIndex)}
          />
        ) : null}
        <ScenarioQoSPanel
          active={dynamic ? profileClock.qosActive : false}
          dynamic={dynamic}
          lastUpdated={formatTimeOfDay(profileClock.nowMS)}
          strategy={strategy}
        />
      </Box>
    </>
  )
})

function Scenario3IntentPanel({
  latencyText,
  targetMet,
  frequency,
  sizeBytes,
}: {
  latencyText: string
  targetMet: boolean
  frequency: string
  sizeBytes: number
}) {
  return (
    <section className="scenario3-feature-card scenario3-intent-card">
      <div className="scenario3-feature-heading">
        <span><Camera size={13} aria-hidden="true" /> Latest Intent</span>
        <strong>Stream</strong>
      </div>
      <div className="scenario3-feature-focus">
        <span>Requested target</span>
        <strong>&lt;100 ms</strong>
        {!targetMet ? <em>Current {latencyText}</em> : null}
      </div>
      <dl className="scenario3-feature-metrics">
        <div>
          <dt>Type</dt>
          <dd>Image</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{sizeBytes} byte</dd>
        </div>
        <div>
          <dt>Frequency</dt>
          <dd>{frequency.replace(' image/s', '/s').replace(' images/s', '/s')}</dd>
        </div>
        <div>
          <dt>Expected In</dt>
          <dd>50 ms</dd>
        </div>
        <div>
          <dt>Required</dt>
          <dd>&lt;100 ms</dd>
        </div>
        <div className="scenario3-usage-metric">
          <dt>Usage</dt>
          <dd>Realtime visual recognition</dd>
        </div>
      </dl>
    </section>
  )
}

function ScenarioQoSPanel({
  active,
  dynamic,
  lastUpdated,
  strategy,
}: {
  active: boolean
  dynamic: boolean
  lastUpdated: string
  strategy: StrategyName
}) {
  const profile = heroProfileForStrategy(strategy)
  return (
    <section className={`scenario3-feature-card scenario3-qos-panel ${active ? 'is-active' : 'is-standby'}`}>
      <div className="scenario3-feature-heading">
        <span><Gauge size={13} aria-hidden="true" /> QoS Parameter</span>
        <strong>{profile.heading}</strong>
      </div>
      <div className="scenario3-qos-state">
        {dynamic ? <Sparkles size={12} aria-hidden="true" /> : <Gauge size={12} aria-hidden="true" />}
        <span>{profile.qosName}</span>
        {dynamic ? (
          <strong className="scenario3-qos-switch">
            <span className={active ? '' : 'is-visible'}>Baseline</span>
            <span className={active ? 'is-visible' : ''}>Active</span>
          </strong>
        ) : (
          <strong>{profile.state}</strong>
        )}
      </div>
      <dl className="scenario3-feature-metrics scenario3-qos-metrics">
        <div>
          <dt>GBR / MBR</dt>
          <dd>{dynamic ? (active ? '2 Mbps / 5 Mbps' : 'N/A') : profile.gbr}</dd>
        </div>
        <div>
          <dt>Latency Class</dt>
          <dd>{dynamic ? (active ? '6QI 82 / PDB 100 ms' : '6QI 9 / PDB 300 ms') : profile.latencyClass}</dd>
        </div>
        <div>
          <dt>Flow Mapping</dt>
          <dd>{dynamic ? (active ? 'QFI 8' : 'QFI 5') : profile.flow}</dd>
        </div>
        <div>
          <dt>Scheduling</dt>
          <dd>{dynamic ? (active ? 'High' : 'Baseline') : profile.scheduling}</dd>
        </div>
        <div>
          <dt>Last Updated</dt>
          <dd>{lastUpdated}</dd>
        </div>
      </dl>
    </section>
  )
}

function Scenario3TrafficChart({
  baselineBandwidthMbps,
  highlightPeak,
  running,
  qosStarted,
  nowMS,
  cycleAnchorMS,
}: {
  baselineBandwidthMbps: number
  highlightPeak: boolean
  running: boolean
  qosStarted: boolean
  nowMS: number
  cycleAnchorMS: number
}) {
  const baselineBandwidth = baselineUploadBandwidth(baselineBandwidthMbps)
  const standby = !running || !qosStarted
  const series = useMemo(() => liveBandwidthSeries(nowMS, baselineBandwidth, !standby, cycleAnchorMS), [baselineBandwidth, cycleAnchorMS, nowMS, standby])
  const hasSamples = series.length >= 2
  const latestWindow = useMemo(() => bandwidthWindowStats(series, baselineBandwidth), [baselineBandwidth, series])
  const peakColumns = useMemo(() => bandwidthPeakColumns(series, cycleAnchorMS), [cycleAnchorMS, series])
  const burstActive = !standby && latestWindow.ulPeak > 6

  if (standby || !hasSamples) {
    return (
      <div className="scenario3-hero-graph is-standby" aria-label="Hero UE uplink and downlink bandwidth standby">
        <span className="scenario3-chart-standby">{standby ? 'Bandwidth standby' : 'Collecting bandwidth'}</span>
        <span className="scenario3-bandwidth-tag">
          <strong>UL --</strong>
          <em>DL --</em>
        </span>
      </div>
    )
  }

  return (
    <div className={`scenario3-hero-graph ${burstActive ? 'is-bursting' : ''}`} aria-label="Hero UE uplink and downlink bandwidth">
      <div className="scenario3-bandwidth-chart" aria-hidden="true">
        <MeasuredChart>
          {({ width, height }) => (
            <LineChart width={width} height={height} data={series} margin={{ top: 10, right: 7, bottom: 6, left: 7 }}>
              <CartesianGrid horizontal={false} stroke="rgba(148, 163, 184, 0.2)" />
              <XAxis dataKey="timestamp" type="number" domain={['dataMin', 'dataMax']} hide />
              <YAxis yAxisId="ul" domain={[0, 10]} hide />
              <YAxis yAxisId="dl" domain={[0, 2]} orientation="right" hide />
              {highlightPeak
                ? peakColumns.map((column) => (
                  <ReferenceArea
                    key={`${column.x1}-${column.x2}`}
                    yAxisId="ul"
                    x1={column.x1}
                    x2={column.x2}
                    fill="rgba(109, 40, 217, 0.3)"
                    stroke="none"
                    ifOverflow="hidden"
                  />
                ))
                : null}
              <Line yAxisId="dl" type="monotone" dataKey="dl" stroke="#0f766e" strokeWidth={1.7} strokeDasharray="4 5" dot={false} isAnimationActive={false} />
              <Line yAxisId="ul" type="monotone" dataKey="ul" stroke="#2563eb" strokeWidth={2.6} dot={false} isAnimationActive={false} />
            </LineChart>
          )}
        </MeasuredChart>
      </div>
      {burstActive ? <span key={latestWindow.endTimestamp} className="scenario3-upload-pulse" aria-hidden="true" /> : null}
      <span className="scenario3-bandwidth-tag">
        <strong>UL {latestWindow.ulPeak.toFixed(1)} Mbps</strong>
        <em>DL {latestWindow.dlPeak.toFixed(1)} Mbps</em>
      </span>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel analytics-panel">
      <div className="panel-title-row">
        <div>
          <h2>{title}</h2>
        </div>
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

function OutcomeHeatmap({
  state,
  resultByID,
}: {
  state: DemoState | null
  resultByID: Record<string, UploadResult>
}) {
  const cells = useMemo(() => {
    const users = state?.users ?? []
    return users.slice(0, 50).map((user, index) => {
      const status = displayStatusForUser(user, resultByID[user.client_id])
      const outcome = outcomeHeatmapStatus(user, status)
      return {
        id: user.client_id,
        label: ueShortLabel(user),
        status: outcome.label,
        tone: outcome.tone,
        value: outcome.value,
        x: index % 10,
        y: Math.floor(index / 10),
      }
    })
  }, [resultByID, state])

  if (!cells.length) {
    return <div className="outcome-heatmap is-empty">--</div>
  }

  return (
    <div className="outcome-heatmap" aria-label="UE outcome heatmap">
      <MeasuredChart>
        {({ width, height }) => <OutcomeHeatmapChart width={width} height={height} points={cells} />}
      </MeasuredChart>
    </div>
  )
}

function OutcomeHeatmapChart({
  width,
  height,
  points,
}: {
  width: number
  height: number
  points: OutcomeHeatmapPoint[]
}) {
  const chartRef = useRef<EChartsInstance | null>(null)
  const chartNodeRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ]).then(([echarts, charts, components, renderers]) => {
      if (cancelled || !chartNodeRef.current) {
        return
      }
      echarts.use([
        charts.HeatmapChart,
        components.GridComponent,
        components.TitleComponent,
        components.TooltipComponent,
        components.VisualMapComponent,
        renderers.CanvasRenderer,
      ])
      chartRef.current = echarts.init(chartNodeRef.current, null, { renderer: 'canvas' })
      setReady(true)
    })

    return () => {
      cancelled = true
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!ready || !chart) {
      return
    }
    chart.resize({ width, height })
    chart.setOption(makeOutcomeHeatmapOption(points), true)
  }, [height, points, ready, width])

  return <div className="outcome-heatmap-canvas" ref={chartNodeRef} />
}

const CrowdLatencyStrip = memo(function CrowdLatencyStrip({
  className,
  samples,
}: {
  className: string
  samples: number[]
}) {
  return <LatencyBarsStrip className={className} samples={samples} barCount={8} />
})

const LatencyBarsStrip = memo(function LatencyBarsStrip({
  barCount,
  className,
  samples,
}: {
  barCount: number
  className: string
  samples: number[]
}) {
  const bars = useMemo(() => latencyBarData(samples, barCount), [barCount, samples])
  const hasData = samples.some((value) => value > 0)
  const chartWidth = barCount * 8
  const chartHeight = 20
  const barWidth = 5
  const targetY = Math.round(chartHeight - (LATENCY_BAR_TARGET_MS / LATENCY_BAR_MAX_MS) * chartHeight)

  return (
    <svg
      className={`latency-bars-chart ${className} ${hasData ? 'has-data' : 'is-standby'}`}
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line className="latency-bars-target" x1="0" x2={chartWidth} y1={targetY} y2={targetY} />
      {bars.map((bar, index) => {
        const height = latencyBarHeight(bar.latency, chartHeight)
        const x = index * 8 + 1.5
        const y = chartHeight - height
        return <rect key={bar.index} x={x} y={y} width={barWidth} height={height} rx="1.3" />
      })}
    </svg>
  )
})

function LatencyBoxPlotChart({
  width,
  height,
  points,
}: {
  width: number
  height: number
  points: HistoryPoint[]
}) {
  const chartRef = useRef<EChartsInstance | null>(null)
  const chartNodeRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const chartPoints = useMemo(() => latencyBoxPoints(points), [points])

  useEffect(() => {
    let cancelled = false

    Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
    ]).then(([echarts, charts, components, renderers]) => {
      if (cancelled || !chartNodeRef.current) {
        return
      }
      echarts.use([
        charts.BoxplotChart,
        charts.ScatterChart,
        components.GridComponent,
        components.MarkAreaComponent,
        components.TooltipComponent,
        renderers.CanvasRenderer,
      ])
      chartRef.current = echarts.init(chartNodeRef.current, null, { renderer: 'canvas' })
      setReady(true)
    })

    return () => {
      cancelled = true
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!ready || !chart) {
      return
    }
    chart.resize({ width, height })
    chart.setOption(makeLatencyBoxOption(chartPoints), true)
  }, [chartPoints, height, ready, width])

  return (
    <div className="latency-echarts-frame" style={{ width, height }}>
      <div className="latency-echarts" ref={chartNodeRef} />
      {!chartPoints.length ? <ChartEmpty label="Standby until live latency data arrives" /> : null}
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
    case 'temporary':
      return 'Temporary Grant'
    case 'healthy':
      return 'Healthy'
    case 'delayed':
      return 'Delayed'
    case 'degraded':
      return 'Degraded'
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

function aiOutcomeForStatus(status: DemoUserStatus, uploading?: boolean) {
  if (uploading && status === 'running') {
    return { label: 'Uploading', tone: 'running' }
  }
  switch (status) {
    case 'good':
      return { label: 'Healthy', tone: 'healthy' }
    case 'delayed':
      return { label: 'Delayed', tone: 'degraded' }
    case 'high':
      return { label: 'Degraded', tone: 'critical' }
    case 'failed':
      return { label: 'Degraded', tone: 'failed' }
    case 'running':
      return { label: 'Uploading', tone: 'running' }
    case 'idle':
    case 'planned':
    default:
      return { label: 'Waiting', tone: 'waiting' }
  }
}

function outcomeHeatmapStatus(user: DemoUser, status: DemoUserStatus) {
  if (!user.active && !user.uploading && !user.running) {
    return { label: 'Idle', tone: 'idle', value: 0 }
  }
  if (status === 'good') {
    return { label: 'Healthy', tone: 'healthy', value: 1 }
  }
  if (status === 'delayed') {
    return { label: 'Delayed', tone: 'degraded', value: 2 }
  }
  if (status === 'high' || status === 'failed') {
    return { label: 'Degraded', tone: 'critical', value: 3 }
  }
  return { label: 'Waiting', tone: 'waiting', value: 0 }
}

function heroUserForStrategy(state: DemoState | null, resultByID: Record<string, UploadResult>) {
  if (!state) {
    return null
  }
  if (state.strategy !== 'dynamic_qos') {
    return state.users.find((user) => user.index === 1) ?? state.users[0] ?? null
  }
  const activeUsers = state.users.filter((user) => user.active)
  return (
    state.users.find((user) => user.index === 1 && (user.active || isUserOnline(user))) ??
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

function heroProfileForStrategy(strategy: StrategyName) {
  switch (strategy) {
    case 'standard_gbr':
      return {
        chip: 'Non-GBR',
        dynamic: false,
        flow: 'QFI 5',
        gbr: 'N/A',
        heading: 'Non-GBR',
        latencyClass: '6QI 9 / PDB 300 ms',
        qosName: 'Non-GBR treatment',
        scheduling: 'Baseline',
        state: 'Baseline',
      }
    case 'dynamic_qos':
      return {
        chip: 'Dynamic QoS',
        dynamic: true,
        flow: 'QFI 5',
        gbr: 'N/A',
        heading: 'Grant',
        latencyClass: '6QI 9 / PDB 300 ms',
        qosName: 'Dynamic QoS',
        scheduling: 'Baseline',
        state: 'Baseline',
      }
    case 'no_optimization':
    default:
      return {
        chip: 'Public QoS',
        dynamic: false,
        flow: 'QFI 5',
        gbr: 'N/A',
        heading: 'Public',
        latencyClass: '6QI 9 / PDB 300 ms',
        qosName: 'Baseline',
        scheduling: 'Baseline',
        state: 'Baseline',
      }
  }
}

function imsiForUser(user: DemoUser) {
  return `310260${String(810000000 + user.index).padStart(9, '0')}`
}

function intentSizeBytes(seed: number, tick: number) {
  const wave = Math.sin((tick + seed * 13) * 1.714)
  const normalized = (wave + 1) / 2
  return Math.round(1000 + normalized * 4000)
}

function e2eDelayForUploadDelay(uploadDelayMS: number, seed: number) {
  const processingDelayMS = 20 + Math.abs(seed * 7) % 11
  return uploadDelayMS + processingDelayMS
}

function formatTimeOfDay(timestampMS: number) {
  return new Date(timestampMS).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function heroLatencyTone(latencyMS: number) {
  if (!Number.isFinite(latencyMS) || latencyMS <= 0) {
    return 'waiting'
  }
  if (latencyMS < 100) {
    return 'healthy'
  }
  if (latencyMS < 300) {
    return 'degraded'
  }
  return 'critical'
}

function baselineUploadBandwidth(publicRateMbps: number) {
  if (!Number.isFinite(publicRateMbps) || publicRateMbps <= 0) {
    return 0.8
  }
  return Math.max(0.5, Math.min(1, publicRateMbps * 8))
}

type BandwidthSample = {
  timestamp: number
  ul: number
  dl: number
}

const BANDWIDTH_SAMPLE_MS = 150
const BANDWIDTH_SAMPLE_COUNT = 40
const BANDWIDTH_UPDATE_MS = 700
const LATENCY_BARS_UPDATE_MS = 1000
const LATENCY_BAR_TARGET_MS = 100
const LATENCY_BAR_MAX_MS = 150
const QOS_CYCLE_MS = 1000
const QOS_ACTIVE_MS = 500
const QOS_PROFILE_SWITCH_MS = 700
const UPLOAD_PEAK_OFFSET_MS = 100
const UPLOAD_DURATION_MS = 220
const DL_RESPONSE_DELAY_MS = 140
const DL_RESPONSE_DURATION_MS = 280

function baselineBandwidthSample(baselineMbps: number): BandwidthSample {
  return { timestamp: 0, ul: Number(baselineMbps.toFixed(2)), dl: 0.3 }
}

function liveBandwidthSeries(nowMS: number, baselineMbps: number, running: boolean, cycleAnchorMS: number) {
  if (!running) {
    return []
  }

  const elapsedMS = Math.max(0, nowMS - cycleAnchorMS)
  const availableSamples = Math.floor(elapsedMS / BANDWIDTH_SAMPLE_MS) + 1
  const sampleCount = Math.min(BANDWIDTH_SAMPLE_COUNT, availableSamples)
  const firstSampleIndex = availableSamples - sampleCount

  return Array.from({ length: sampleCount }, (_, index) => {
    const timestamp = cycleAnchorMS + (firstSampleIndex + index) * BANDWIDTH_SAMPLE_MS
    return makeBandwidthSample(timestamp, baselineMbps, true, cycleAnchorMS)
  })
}

function bandwidthWindowStats(series: BandwidthSample[], baselineMbps: number) {
  const fallback = baselineBandwidthSample(baselineMbps)
  const windowSamples = series.slice(-1)
  const samples = windowSamples.length > 0 ? windowSamples : [fallback]
  return {
    ulPeak: Math.max(...samples.map((sample) => sample.ul)),
    dlPeak: Math.max(...samples.map((sample) => sample.dl)),
    endTimestamp: samples[samples.length - 1]?.timestamp ?? fallback.timestamp,
  }
}

function bandwidthPeakColumns(series: BandwidthSample[], cycleAnchorMS: number) {
  if (series.length < 2) {
    return []
  }

  const firstTimestamp = series[0].timestamp
  const lastTimestamp = series[series.length - 1].timestamp
  const halfDuration = UPLOAD_DURATION_MS / 2
  const firstCycle = Math.floor((firstTimestamp - cycleAnchorMS - UPLOAD_PEAK_OFFSET_MS - halfDuration) / QOS_CYCLE_MS) - 1
  const lastCycle = Math.ceil((lastTimestamp - cycleAnchorMS - UPLOAD_PEAK_OFFSET_MS + halfDuration) / QOS_CYCLE_MS) + 1
  const columns: Array<{ x1: number; x2: number }> = []

  for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
    const peakCenter = cycleAnchorMS + cycle * QOS_CYCLE_MS + UPLOAD_PEAK_OFFSET_MS
    const x1 = Math.max(firstTimestamp, peakCenter - halfDuration)
    const x2 = Math.min(lastTimestamp, peakCenter + halfDuration)
    if (x2 > x1) {
      columns.push({ x1, x2 })
    }
  }

  return columns
}

function makeBandwidthSample(timestamp: number, baselineMbps: number, running: boolean, cycleAnchorMS: number): BandwidthSample {
  if (!running) {
    return { timestamp, ul: Number(baselineMbps.toFixed(2)), dl: 0.3 }
  }

  const phaseMS = positiveModulo(timestamp - cycleAnchorMS, QOS_CYCLE_MS)
  const ul = baselineMbps + (10 - baselineMbps) * uploadPulse(phaseMS)
  const dl = 0.3 + 1.3 * downlinkPulse(phaseMS)
  return {
    timestamp,
    ul: Number(ul.toFixed(2)),
    dl: Number(dl.toFixed(2)),
  }
}

function uploadPulse(phaseMS: number) {
  return centeredPulse(phaseMS, UPLOAD_PEAK_OFFSET_MS, UPLOAD_DURATION_MS)
}

function downlinkPulse(phaseMS: number) {
  return centeredPulse(phaseMS, UPLOAD_PEAK_OFFSET_MS + DL_RESPONSE_DELAY_MS, DL_RESPONSE_DURATION_MS)
}

function centeredPulse(phaseMS: number, peakOffsetMS: number, durationMS: number) {
  const distance = Math.abs(phaseMS - peakOffsetMS)
  const halfDuration = durationMS / 2
  if (distance > halfDuration) {
    return 0
  }
  return Math.cos((distance / halfDuration) * (Math.PI / 2))
}

function positiveModulo(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus
}

function useQosCycleClock(running: boolean, updateMS: number) {
  const [clock, setClock] = useState(() => {
    const nowMS = Date.now()
    return { nowMS, cycleAnchorMS: nowMS, hasRun: false }
  })

  useEffect(() => {
    if (!running) {
      return
    }

    function updateClock() {
      const nowMS = Date.now()
      setClock((current) => ({
        nowMS,
        cycleAnchorMS: current.hasRun ? current.cycleAnchorMS : nowMS,
        hasRun: true,
      }))
    }

    updateClock()
    const timer = window.setInterval(updateClock, updateMS)
    return () => window.clearInterval(timer)
  }, [running, updateMS])

  const phaseMS = positiveModulo(clock.nowMS - clock.cycleAnchorMS, QOS_CYCLE_MS)

  return {
    nowMS: clock.nowMS,
    cycleAnchorMS: clock.cycleAnchorMS,
    hasRun: clock.hasRun,
    phaseMS,
    cycleIndex: Math.floor((clock.nowMS - clock.cycleAnchorMS) / QOS_CYCLE_MS),
    qosActive: running && clock.hasRun && phaseMS < QOS_ACTIVE_MS,
  }
}

function useQosProfileClock(running: boolean) {
  const [clock, setClock] = useState(() => {
    const nowMS = Date.now()
    return { nowMS, cycleAnchorMS: nowMS, hasRun: false, switchIndex: 0 }
  })

  useEffect(() => {
    if (!running) {
      return
    }

    const cycleAnchorMS = Date.now()
    let timer: number | undefined

    function updateAtBoundary() {
      const nowMS = Date.now()
      const elapsedMS = Math.max(0, nowMS - cycleAnchorMS)
      const switchIndex = Math.floor(elapsedMS / QOS_PROFILE_SWITCH_MS)
      const delayMS = Math.max(32, QOS_PROFILE_SWITCH_MS - (elapsedMS % QOS_PROFILE_SWITCH_MS) + 4)

      setClock({ nowMS, cycleAnchorMS, hasRun: true, switchIndex })
      timer = window.setTimeout(updateAtBoundary, delayMS)
    }

    updateAtBoundary()
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer)
      }
    }
  }, [running])

  return {
    nowMS: clock.nowMS,
    cycleIndex: Math.floor((clock.nowMS - clock.cycleAnchorMS) / QOS_CYCLE_MS),
    qosActive: running && clock.hasRun && clock.switchIndex % 2 === 0,
  }
}

function useThrottledValue<T>(value: T, intervalMS: number) {
  const latestRef = useRef(value)
  const [throttled, setThrottled] = useState(value)

  useEffect(() => {
    latestRef.current = value
  }, [value])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setThrottled((current) => (Object.is(current, latestRef.current) ? current : latestRef.current))
    }, intervalMS)
    return () => window.clearInterval(timer)
  }, [intervalMS])

  return throttled
}

function formatUploadFrequency(intervalMS: number) {
  if (intervalMS <= 0) {
    return 'continuous'
  }
  const uploadsPerSecond = 1000 / intervalMS
  return uploadsPerSecond === 1 ? '1 image/s' : `${uploadsPerSecond.toFixed(1)} images/s`
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

function latencyBoxPoints(points: HistoryPoint[]): LatencyBoxPoint[] {
  return points
    .map((point) => {
      const box = boxPlotStats(point.latencies)
      if (!box) {
        return null
      }
      return {
        active: point.active,
        failedCount: point.failedCount,
        max: box.max,
        median: box.median,
        min: box.min,
        q1: box.q1,
        q3: box.q3,
      }
    })
    .filter((point): point is LatencyBoxPoint => Boolean(point))
}

function makeLatencyBoxOption(points: LatencyBoxPoint[]) {
  const categories = points.map((point) => String(point.active))

  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: { top: 12, right: 86, bottom: 28, left: 36 },
    tooltip: {
      borderColor: '#dce3ef',
      borderRadius: 8,
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      confine: true,
      padding: 8,
      textStyle: { color: '#101828', fontSize: 12 },
      trigger: 'item',
      formatter: (params: unknown) => formatLatencyDistributionTooltip(params),
    },
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: '#dce3ef' } },
      axisLabel: {
        color: '#667085',
        fontSize: 10,
        interval: Math.max(0, Math.ceil(categories.length / 12) - 1),
      },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: 'rgba(220, 226, 236, 0.42)' }, show: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1000,
      interval: 150,
      axisLine: { lineStyle: { color: '#dce3ef' } },
      axisLabel: {
        color: '#667085',
        fontSize: 10,
        formatter: (value: number) => formatLatencyAxis(value),
      },
      axisTick: { show: false },
      position: 'right',
      splitLine: { lineStyle: { color: 'rgba(203, 213, 225, 0.52)', type: [3, 5] } },
    },
    series: [
      {
        name: 'P25-P75',
        type: 'boxplot',
        data: points.map((point) => ({
          active: point.active,
          failedCount: point.failedCount,
          value: [point.min, point.q1, point.median, point.q3, point.max],
        })),
        itemStyle: {
          borderColor: '#1d4ed8',
          borderWidth: 1.5,
          color: {
            type: 'linear' as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: '#bfdbfe' },
              { offset: 1, color: '#eff6ff' },
            ],
          },
          shadowBlur: 7,
          shadowColor: 'rgba(37, 99, 235, 0.16)',
          shadowOffsetY: 2,
        },
        markArea: {
          silent: true,
          data: [
            [
              {
                yAxis: 300,
                itemStyle: { color: 'rgba(255, 237, 213, 0)' },
                label: { color: '#dc2626', fontSize: 10, fontWeight: 700, position: 'insideRight', formatter: 'Degraded\n>300ms' },
              },
              { yAxis: 1000 },
            ],
            [
              {
                yAxis: 150,
                itemStyle: { color: 'rgba(254, 243, 199, 0)' },
                label: { color: '#d97706', fontSize: 10, fontWeight: 700, position: 'insideRight', formatter: 'Delayed\n150-300ms' },
              },
              { yAxis: 300 },
            ],
            [
              {
                yAxis: 0,
                itemStyle: { color: 'rgba(209, 250, 229, 0)' },
                label: { color: '#16a34a', fontSize: 10, fontWeight: 700, position: 'insideRight', formatter: 'Healthy\n<=150ms' },
              },
              { yAxis: 150 },
            ],
          ],
        },
        medianStyle: {
          color: '#7c3aed',
          width: 2,
        },
      },
      {
        name: 'Failed',
        type: 'scatter',
        data: points
          .filter((point) => point.failedCount > 0)
          .map((point) => ({
            active: point.active,
            failedCount: point.failedCount,
            value: [String(point.active), 1000],
          })),
        itemStyle: {
          color: '#dc2626',
          borderColor: '#fff',
          borderWidth: 1.4,
          shadowBlur: 6,
          shadowColor: 'rgba(220, 38, 38, 0.35)',
        },
        symbolSize: 7,
      },
    ],
  }
}

function makeOutcomeHeatmapOption(points: OutcomeHeatmapPoint[]) {
  const xCategories = Array.from({ length: 10 }, (_, index) => String(index + 1))
  const yCategories = Array.from({ length: 5 }, (_, index) => String(index + 1))
  const completed = points.filter((point) => point.value > 0).length
  const healthy = points.filter((point) => point.value === 1).length
  const healthyPct = completed > 0 ? Math.round((healthy / completed) * 100) : 0

  return {
    animation: false,
    backgroundColor: 'transparent',
    title: {
      text: `${healthyPct}% Healthy`,
      left: 2,
      top: 0,
      textStyle: {
        color: '#166534',
        fontSize: 12,
        fontWeight: 750,
      },
    },
    grid: { top: 22, right: 2, bottom: 2, left: 2 },
    tooltip: {
      borderColor: '#dce3ef',
      borderRadius: 8,
      backgroundColor: 'rgba(255, 255, 255, 0.96)',
      confine: true,
      padding: 7,
      textStyle: { color: '#101828', fontSize: 11 },
      formatter: (params: unknown) => formatOutcomeHeatmapTooltip(params),
    },
    xAxis: {
      type: 'category',
      data: xCategories,
      show: false,
    },
    yAxis: {
      type: 'category',
      data: yCategories,
      show: false,
    },
    visualMap: {
      type: 'piecewise',
      show: false,
      dimension: 2,
      pieces: [
        { value: 0, color: '#e5e7eb' },
        { value: 1, color: '#22a34a' },
        { value: 2, color: '#f59e0b' },
        { value: 3, color: '#ef4444' },
      ],
    },
    series: [
      {
        type: 'heatmap',
        data: points.map((point) => [point.x, 4 - point.y, point.value, point.label, point.status]),
        progressive: 0,
        itemStyle: {
          borderColor: '#ffffff',
          borderWidth: 2.5,
          borderRadius: 2,
        },
        emphasis: {
          itemStyle: {
            borderColor: '#101828',
            borderWidth: 1,
          },
        },
      },
    ],
  }
}

function formatOutcomeHeatmapTooltip(params: unknown) {
  const payload = isRecord(params) ? params : {}
  const value = Array.isArray(payload.value) ? payload.value : []
  const label = typeof value[3] === 'string' ? value[3] : 'UE'
  const status = typeof value[4] === 'string' ? value[4] : 'Unknown'
  return `<strong>${label}</strong><br/>${status}`
}

function formatLatencyDistributionTooltip(params: unknown) {
  const payload = isRecord(params) ? params : {}
  const data = isRecord(payload.data) ? payload.data : {}
  const marker = typeof payload.marker === 'string' ? payload.marker : ''
  const active = typeof data.active === 'number' ? data.active : Number.NaN

  if (payload.seriesType === 'scatter') {
    const failedCount = typeof data.failedCount === 'number' ? data.failedCount : 0
    return `${marker}<strong>${formatActiveLabel(active)}</strong><br/>Failed ${failedCount} UEs`
  }

  const values = Array.isArray(data.value) ? data.value.map((value) => Number(value)) : []
  const [min, q1, median, q3, max] = values
  return [
    `${marker}<strong>${formatActiveLabel(active)}</strong>`,
    `Min ${formatLatency(min)} / P25 ${formatLatency(q1)}`,
    `Median ${formatLatency(median)} / P75 ${formatLatency(q3)}`,
    `Max ${formatLatency(max)}`,
  ].join('<br/>')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object')
}

function compactHistoryByActive(points: HistoryPoint[]) {
  const latestByActive = new Map<number, HistoryPoint>()
  for (const point of points) {
    latestByActive.set(point.active, point)
  }
  return [...latestByActive.values()].sort((left, right) => left.active - right.active)
}

function compactOutcomeHistory(points: HistoryPoint[]): OutcomeHistoryPoint[] {
  return compactHistoryByActive(points).map(({ active, goodPct, degradedPct, highPct, failedPct }) => ({
    active,
    goodPct,
    degradedPct,
    highPct: highPct + failedPct,
    failedPct: 0,
  }))
}

function liveOutcomeSummary(state: DemoState | null, resultByID: Record<string, UploadResult>): OutcomeSummary {
  if (!state) {
    return emptyOutcomeSummary()
  }

  const activeUsers = state.users.filter((user) => user.active || user.uploading || user.running)
  let good = 0
  let delayed = 0
  let high = 0
  let failed = 0

  for (const user of activeUsers) {
    const status = displayStatusForUser(user, resultByID[user.client_id])
    if (status === 'good') {
      good++
    } else if (status === 'delayed') {
      delayed++
    } else if (status === 'high') {
      high++
    } else if (status === 'failed') {
      failed++
    }
  }

  const completedUsers = good + delayed + high + failed
  const percentOfCompleted = (value: number) => (completedUsers > 0 ? Math.round((value / completedUsers) * 100) : 0)

  return {
    activeUsers: activeUsers.length,
    completedUsers,
    good,
    delayed,
    high,
    failed,
    goodPct: percentOfCompleted(good),
    degradedPct: percentOfCompleted(delayed),
    highPct: percentOfCompleted(high + failed),
    failedPct: 0,
  }
}

function emptyOutcomeSummary(): OutcomeSummary {
  return {
    activeUsers: 0,
    completedUsers: 0,
    good: 0,
    delayed: 0,
    high: 0,
    failed: 0,
    goodPct: 0,
    degradedPct: 0,
    highPct: 0,
    failedPct: 0,
  }
}

function mergeLiveOutcomePoint(points: HistoryPoint[], outcome: OutcomeSummary): OutcomeHistoryPoint[] {
  const base = compactOutcomeHistory(points)
  if (outcome.completedUsers <= 0) {
    return base
  }

  const active = Math.max(outcome.activeUsers, outcome.completedUsers)
  const livePoint = {
    active,
    goodPct: outcome.goodPct,
    degradedPct: outcome.degradedPct,
    highPct: outcome.highPct,
    failedPct: outcome.failedPct,
  }

  return [...base.filter((point) => point.active !== active), livePoint].sort((left, right) => left.active - right.active)
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

function makeDeviceCardView(user: DemoUser, latestResult: UploadResult | undefined, latencyHistory: number[]): DeviceCardView {
  const online = isUserOnline(user)
  const displayStatus = displayStatusForUser(user, latestResult)
  const displayLatencyMS = latestResult?.latency_ms ?? user.last_latency_ms ?? 0
  const treatmentClass = user.treatment === 'temporary_grant' ? 'treatment-temporary' : user.treatment === 'reserved' ? 'treatment-reserved' : 'treatment-public'
  const label = ueShortLabel(user)
  const outcome = aiOutcomeForStatus(displayStatus, user.uploading)
  const latencyText = displayLatencyMS > 0 ? formatLatency(displayLatencyMS) : online ? 'Waiting' : '--'

  return {
    user,
    label,
    online,
    displayStatus,
    displayLatencyMS,
    treatmentClass,
    outcome,
    latencyText,
    accessibleLabel: `${label}, ${outcome.label}, ${latencyText}, Dynamic QoS`,
    latencyHistory,
  }
}

function filterDeviceCards(cards: DeviceCardView[], filter: BoardFilter) {
  switch (filter) {
    case 'uploading':
      return cards.filter((card) => card.user.active && (card.user.uploading || card.user.running))
    case 'temporary':
      return cards.filter((card) => card.user.active && card.user.treatment === 'temporary_grant')
    case 'healthy':
      return cards.filter((card) => card.displayStatus === 'good')
    case 'delayed':
      return cards.filter((card) => card.displayStatus === 'delayed')
    case 'degraded':
      return cards.filter((card) => card.displayStatus === 'high' || card.displayStatus === 'failed')
    case 'all':
    default:
      return cards
  }
}

function boardFilterCounts(cards: DeviceCardView[]): Record<BoardFilter, number> {
  return {
    all: cards.length,
    uploading: cards.filter((card) => card.user.active && (card.user.uploading || card.user.running)).length,
    temporary: cards.filter((card) => card.user.active && card.user.treatment === 'temporary_grant').length,
    healthy: cards.filter((card) => card.displayStatus === 'good').length,
    delayed: cards.filter((card) => card.displayStatus === 'delayed').length,
    degraded: cards.filter((card) => card.displayStatus === 'high' || card.displayStatus === 'failed').length,
  }
}

function displayStatusForUser(user: DemoUser, latestResult?: UploadResult): DemoUserStatus {
  if (latestResult) {
    return classifyResultStatus(latestResult)
  }
  if (isUserOnline(user) && user.status === 'planned') {
    return 'idle'
  }
  return user.status
}

function sortDeviceCards(cards: DeviceCardView[], sortMode: BoardSort) {
  const next = [...cards]
  next.sort((left, right) => {
    let result = 0
    if (sortMode === 'latency') {
      result = right.displayLatencyMS - left.displayLatencyMS
    } else if (sortMode === 'status') {
      result = statusRank(right.displayStatus) - statusRank(left.displayStatus)
    } else {
      result = left.user.index - right.user.index
    }
    return result || left.user.index - right.user.index
  })
  return next
}

function statusRank(status: DemoUserStatus) {
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

function scenarioStyle(strategy: StrategyName) {
  switch (strategy) {
    case 'standard_gbr':
      return {
        tone: 'blue' as const,
        short: 'Static reservation',
        icon: <Shield size={16} />,
        expectation: 'Static GBR reservation protects selected flows while non-GBR traffic remains best effort.',
      }
    case 'dynamic_qos':
      return {
        tone: 'purple' as const,
        short: 'Temporary grants',
        icon: <Sparkles size={16} />,
        expectation: 'Intent-assisted QoS grants low-latency treatment only during real-time upload bursts.',
      }
    default:
      return {
        tone: 'orange' as const,
        short: 'All public',
        icon: <Activity size={16} />,
        expectation: 'Best-effort baseline keeps all application traffic on public QoS without prioritization.',
      }
  }
}

export default App
