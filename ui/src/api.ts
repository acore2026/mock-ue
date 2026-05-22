import type { DemoRuntimeMode, DemoState, DemoStreamEvent, StrategyName } from './types'

async function decodeResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed with ${response.status}`)
  }
  return (await response.json()) as T
}

export async function fetchDemoState(): Promise<DemoState | null> {
  const response = await fetch('/v1/demo/state')
  if (response.status === 404) {
    return null
  }
  return decodeResponse<DemoState>(response)
}

export async function prepareDemoSession(strategy: StrategyName, runtimeMode: DemoRuntimeMode = 'real'): Promise<DemoState> {
  const response = await fetch('/v1/demo/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ strategy, runtime_mode: runtimeMode }),
  })
  return decodeResponse<DemoState>(response)
}

async function postDemoAction(path: string): Promise<DemoState> {
  const response = await fetch(path, {
    method: 'POST',
  })
  return decodeResponse<DemoState>(response)
}

export function startDemoRun() {
  return postDemoAction('/v1/demo/run/start')
}

export function spawnDemoUsers() {
  return postDemoAction('/v1/demo/run/spawn')
}

export function stopDemoRun() {
  return postDemoAction('/v1/demo/run/stop')
}

export function resetDemoRun() {
  return postDemoAction('/v1/demo/run/reset')
}

export type DemoStreamStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed'

export function subscribeDemoStream(
  onEvent: (event: DemoStreamEvent) => void,
  onStatus: (status: DemoStreamStatus) => void,
) {
  let socket: WebSocket | null = null
  let events: EventSource | null = null
  let stopped = false
  let reconnectTimer: number | null = null
  let reconnectDelay = 500
  let opened = false

  function emitEvent(data: string) {
    try {
      onEvent(JSON.parse(data) as DemoStreamEvent)
    } catch {
      // Ignore malformed stream frames; the next snapshot will recover state.
    }
  }

  function streamURL() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/v1/demo/stream`
  }

  function eventsURL() {
    return '/v1/demo/events'
  }

  function connectSSE() {
    if (stopped || events) {
      return
    }
    onStatus(opened ? 'reconnecting' : 'connecting')
    events = new EventSource(eventsURL())

    events.onopen = () => {
      opened = true
      reconnectDelay = 500
      onStatus('connected')
    }

    events.onmessage = (message) => {
      emitEvent(message.data)
    }

    events.onerror = () => {
      if (!stopped) {
        onStatus(opened ? 'reconnecting' : 'connecting')
      }
    }
  }

  function connect() {
    if (stopped) {
      return
    }
    onStatus(reconnectDelay === 500 ? 'connecting' : 'reconnecting')
    try {
      socket = new WebSocket(streamURL())
    } catch {
      connectSSE()
      return
    }

    socket.onopen = () => {
      opened = true
      reconnectDelay = 500
      onStatus('connected')
    }

    socket.onmessage = (message) => {
      emitEvent(message.data)
    }

    socket.onclose = () => {
      socket = null
      if (stopped) {
        onStatus('closed')
        return
      }
      if (!opened) {
        connectSSE()
        return
      }
      onStatus('reconnecting')
      reconnectTimer = window.setTimeout(connect, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 1.6, 5000)
    }

    socket.onerror = () => {
      socket?.close()
    }
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
    }
    socket?.close()
    events?.close()
  }
}
