package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	demoStreamSnapshot    = "snapshot"
	demoStreamUploadBegin = "upload_begin"
	demoStreamUploadEnd   = "upload_end"
	demoStreamResults     = "result_batch"
	demoStreamSample      = "sample"
	demoStreamHeartbeat   = "heartbeat"
	demoStreamError       = "error"

	demoProgressInterval = time.Second
)

type DemoStreamUploadEvent struct {
	ClientID  string        `json:"client_id"`
	Attempt   int           `json:"attempt"`
	Profile   ProfileName   `json:"profile,omitempty"`
	Treatment DemoTreatment `json:"treatment,omitempty"`
	At        time.Time     `json:"at"`
}

type DemoStreamEvent struct {
	Type    string                 `json:"type"`
	At      time.Time              `json:"at"`
	State   *DemoStateResponse     `json:"state,omitempty"`
	Upload  *DemoStreamUploadEvent `json:"upload,omitempty"`
	Results *DemoResultBatch       `json:"results,omitempty"`
	Sample  *ClientSample          `json:"sample,omitempty"`
	Message string                 `json:"message,omitempty"`
}

type DemoClientResult struct {
	ID        string    `json:"id"`
	Attempt   int       `json:"attempt"`
	Success   bool      `json:"success"`
	LatencyMS float64   `json:"latency_ms"`
	PhaseMS   int       `json:"phase_ms"`
	At        time.Time `json:"at"`
}

type DemoResultBatch struct {
	Items []DemoClientResult `json:"items"`
	TS    int64              `json:"ts"`
}

type demoStreamHub struct {
	mu          sync.Mutex
	subscribers map[chan DemoStreamEvent]struct{}
}

func newDemoStreamHub() *demoStreamHub {
	return &demoStreamHub{subscribers: make(map[chan DemoStreamEvent]struct{})}
}

func (h *demoStreamHub) subscribe() chan DemoStreamEvent {
	ch := make(chan DemoStreamEvent, 64)
	h.mu.Lock()
	h.subscribers[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *demoStreamHub) unsubscribe(ch chan DemoStreamEvent) {
	h.mu.Lock()
	if _, ok := h.subscribers[ch]; ok {
		delete(h.subscribers, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *demoStreamHub) broadcast(event DemoStreamEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subscribers {
		select {
		case ch <- event:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- event:
			default:
			}
		}
	}
}

var demoWebsocketUpgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool {
		return true
	},
}

func (m *ScenarioManager) handleDemoStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	conn, err := demoWebsocketUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ch := m.stream.subscribe()
	defer m.stream.unsubscribe(ch)

	m.mu.Lock()
	if m.demo != nil {
		ch <- DemoStreamEvent{
			Type:  demoStreamSnapshot,
			At:    time.Now().UTC(),
			State: ptrTo(m.demoStateLocked()),
		}
	} else {
		ch <- DemoStreamEvent{
			Type:    demoStreamError,
			At:      time.Now().UTC(),
			Message: "missing_demo_session",
		}
	}
	m.mu.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.NextReader(); err != nil {
				return
			}
		}
	}()

	heartbeat := time.NewTicker(5 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case event, ok := <-ch:
			if !ok {
				return
			}
			if err := conn.WriteJSON(event); err != nil {
				return
			}
		case <-heartbeat.C:
			if err := conn.WriteJSON(DemoStreamEvent{Type: demoStreamHeartbeat, At: time.Now().UTC()}); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

func (m *ScenarioManager) broadcastDemoSnapshotLocked() {
	if m.demo == nil {
		return
	}
	m.stream.broadcast(DemoStreamEvent{
		Type:  demoStreamSnapshot,
		At:    time.Now().UTC(),
		State: ptrTo(m.demoStateLocked()),
	})
}

func (m *ScenarioManager) broadcastDemoUploadLocked(eventType string, req DemoUploadEventRequest, profile ProfileName, treatment DemoTreatment) {
	if m.demo == nil {
		return
	}
	m.stream.broadcast(DemoStreamEvent{
		Type: eventType,
		At:   time.Now().UTC(),
		Upload: &DemoStreamUploadEvent{
			ClientID:  req.ClientID,
			Attempt:   req.Attempt,
			Profile:   profile,
			Treatment: treatment,
			At:        time.Now().UTC(),
		},
	})
}

func (m *ScenarioManager) broadcastDemoSampleLocked(sample ClientSample) {
	if m.demo == nil {
		return
	}
	m.demoLast[sample.ClientID] = DemoClientResult{
		ID:        sample.ClientID,
		Attempt:   sample.Attempt,
		Success:   sample.Success,
		LatencyMS: sample.LatencyMS,
		PhaseMS:   int(clientPhaseOffset(sample.ClientID, time.Second).Milliseconds()),
		At:        sample.At,
	}
	m.stream.broadcast(DemoStreamEvent{
		Type:   demoStreamSample,
		At:     time.Now().UTC(),
		Sample: &sample,
	})
}

func ptrTo[T any](value T) *T {
	return &value
}

func (m *ScenarioManager) startDemoProgressLocked() {
	m.stopDemoProgressLocked()
	ctx, cancel := context.WithCancel(context.Background())
	m.demoProg = cancel
	ticker := time.NewTicker(demoProgressInterval)

	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.mu.Lock()
				if m.demo == nil || m.server == nil {
					m.mu.Unlock()
					return
				}
				items := m.demoResultItemsLocked()
				if len(items) > 0 {
					m.broadcastDemoResultsLocked(items)
				}
				m.mu.Unlock()
			}
		}
	}()
}

func (m *ScenarioManager) stopDemoProgressLocked() {
	if m.demoProg != nil {
		m.demoProg()
		m.demoProg = nil
	}
}

func (m *ScenarioManager) demoResultItemsLocked() []DemoClientResult {
	if m.demo == nil {
		return nil
	}
	items := make([]DemoClientResult, 0, len(m.demo.Users))
	for _, user := range m.demo.Users {
		if !user.Active {
			continue
		}
		result, ok := m.demoLast[user.ClientID]
		if !ok {
			continue
		}
		items = append(items, result)
	}
	return items
}

func (m *ScenarioManager) broadcastDemoResultsLocked(items []DemoClientResult) {
	if len(items) == 0 {
		return
	}
	m.stream.broadcast(DemoStreamEvent{
		Type: demoStreamResults,
		At:   time.Now().UTC(),
		Results: &DemoResultBatch{
			Items: items,
			TS:    time.Now().UnixMilli(),
		},
	})
}
