import type { DemoState, DemoStreamEvent, StrategyName } from './types'

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

export async function prepareDemoSession(strategy: StrategyName): Promise<DemoState> {
  const response = await fetch('/v1/demo/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ strategy }),
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
  let stopped = false
  let reconnectTimer: number | null = null
  let reconnectDelay = 500

  function streamURL() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/v1/demo/stream`
  }

  function connect() {
    if (stopped) {
      return
    }
    onStatus(reconnectDelay === 500 ? 'connecting' : 'reconnecting')
    socket = new WebSocket(streamURL())

    socket.onopen = () => {
      reconnectDelay = 500
      onStatus('connected')
    }

    socket.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data) as DemoStreamEvent)
      } catch {
        // Ignore malformed stream frames; the next snapshot will recover state.
      }
    }

    socket.onclose = () => {
      socket = null
      if (stopped) {
        onStatus('closed')
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
  }
}
