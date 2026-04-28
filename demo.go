package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	demoPlannedUsers  = 50
	demoInitialUsers  = 10
	demoRampPerSecond = 5
	demoDynamicQoSWarmupGrace = 1500 * time.Millisecond
)

type DemoUserStatus string

const (
	DemoUserStatusPlanned DemoUserStatus = "planned"
	DemoUserStatusIdle    DemoUserStatus = "idle"
	DemoUserStatusRunning DemoUserStatus = "running"
	DemoUserStatusGood    DemoUserStatus = "good"
	DemoUserStatusDelayed DemoUserStatus = "delayed"
	DemoUserStatusFailed  DemoUserStatus = "failed"
)

type DemoTreatment string

const (
	DemoTreatmentPublic         DemoTreatment = "public"
	DemoTreatmentReserved       DemoTreatment = "reserved"
	DemoTreatmentTemporaryGrant DemoTreatment = "temporary_grant"
)

type DemoSessionRequest struct {
	Strategy StrategyName `json:"strategy"`
}

type DemoCounters struct {
	PlannedUsers    int `json:"planned_users"`
	ActiveUsers     int `json:"active_users"`
	ProtectedUsers  int `json:"protected_users"`
	TemporaryGrants int `json:"temporary_grants"`
	GoodUsers       int `json:"good_users"`
	DelayedUsers    int `json:"delayed_users"`
	FailedUsers     int `json:"failed_users"`
	IdleUsers       int `json:"idle_users"`
}

type DemoBandwidth struct {
	TotalRateMbps     float64 `json:"total_rate_mbps"`
	PublicRateMbps    float64 `json:"public_rate_mbps"`
	OptimizedRateMbps float64 `json:"optimized_rate_mbps"`
}

type DemoUser struct {
	ClientID        string         `json:"client_id"`
	ClientIP        string         `json:"client_ip"`
	Index           int            `json:"index"`
	Status          DemoUserStatus `json:"status"`
	Treatment       DemoTreatment  `json:"treatment"`
	Active          bool           `json:"active"`
	Running         bool           `json:"running"`
	Uploading       bool           `json:"uploading"`
	Attempts        int            `json:"attempts"`
	ActivatedAt     *time.Time     `json:"activated_at,omitempty"`
	UploadStartedAt *time.Time     `json:"upload_started_at,omitempty"`
	LastLatencyMS   float64        `json:"last_latency_ms,omitempty"`
	LastSeen        *time.Time     `json:"last_seen,omitempty"`
}

type DemoStateResponse struct {
	Strategy      StrategyName   `json:"strategy"`
	Running       bool           `json:"running"`
	PreparedAt    time.Time      `json:"prepared_at"`
	InitialUsers  int            `json:"initial_users"`
	RampPerSecond int            `json:"ramp_per_second"`
	Bandwidth     DemoBandwidth  `json:"bandwidth"`
	Counters      DemoCounters   `json:"counters"`
	Scenario      ScenarioConfig `json:"scenario"`
	Users         []DemoUser     `json:"users"`
}

type DemoSession struct {
	PreparedAt    time.Time
	Strategy      StrategyName
	InitialUsers  int
	RampPerSecond int
	Config        ScenarioConfig
	Users         []DemoUser
}

type DemoRunSpawnRequest struct {
	Count int `json:"count"`
}

type DemoUploadEventRequest struct {
	ClientID string `json:"client_id"`
	Attempt  int    `json:"attempt"`
}

type DemoUploadEventResponse struct {
	Profile   ProfileName   `json:"profile"`
	Treatment DemoTreatment `json:"treatment"`
}

func (m *ScenarioManager) handleDemoSession(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	var req DemoSessionRequest
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, fmt.Sprintf("invalid demo session payload: %v", err), http.StatusBadRequest)
			return
		}
	}
	if req.Strategy == "" {
		req.Strategy = StrategyNoOptimization
	}
	if !validStrategy(req.Strategy) {
		http.Error(w, fmt.Sprintf("unknown strategy %q", req.Strategy), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.server != nil || m.runtime != nil {
		if err := m.stopLocked(); err != nil {
			http.Error(w, fmt.Sprintf("failed to stop active scenario: %v", err), http.StatusInternalServerError)
			return
		}
	}

	session := newDemoSession(req.Strategy)
	m.metrics.reset(session.Config)
	m.demo = &session
	m.demoLast = make(map[string]DemoClientResult)
	m.broadcastDemoSnapshotLocked()
	writeJSON(w, http.StatusOK, m.demoStateLocked())
}

func (m *ScenarioManager) handleDemoState(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodGet); err != nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.demo == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"status": "missing_demo_session"})
		return
	}
	writeJSON(w, http.StatusOK, m.demoStateLocked())
}

func (m *ScenarioManager) handleDemoRunStart(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.demo == nil {
		http.Error(w, "demo session not prepared", http.StatusConflict)
		return
	}
	if m.server != nil {
		http.Error(w, "demo run already active", http.StatusConflict)
		return
	}

	if err := m.startDemoRunLocked(); err != nil {
		http.Error(w, fmt.Sprintf("demo run failed: %v", err), http.StatusInternalServerError)
		_ = m.stopLocked()
		return
	}
	m.broadcastDemoSnapshotLocked()
	writeJSON(w, http.StatusAccepted, m.demoStateLocked())
}

func (m *ScenarioManager) handleDemoRunSpawn(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	var req DemoRunSpawnRequest
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, fmt.Sprintf("invalid demo spawn payload: %v", err), http.StatusBadRequest)
			return
		}
	}

	count := req.Count
	if count <= 0 {
		count = demoRampPerSecond
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.demo == nil {
		http.Error(w, "demo session not prepared", http.StatusConflict)
		return
	}
	if m.server == nil {
		http.Error(w, "demo run not active", http.StatusConflict)
		return
	}
	if _, err := m.activateDemoUsersLocked(count); err != nil {
		http.Error(w, fmt.Sprintf("demo spawn failed: %v", err), http.StatusInternalServerError)
		return
	}
	m.broadcastDemoSnapshotLocked()
	writeJSON(w, http.StatusOK, m.demoStateLocked())
}

func (m *ScenarioManager) handleDemoRunStop(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.demo == nil {
		http.Error(w, "demo session not prepared", http.StatusConflict)
		return
	}
	if err := m.stopLocked(); err != nil {
		http.Error(w, fmt.Sprintf("failed to stop demo run: %v", err), http.StatusInternalServerError)
		return
	}
	m.broadcastDemoSnapshotLocked()
	writeJSON(w, http.StatusOK, m.demoStateLocked())
}

func (m *ScenarioManager) handleDemoRunReset(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.demo == nil {
		http.Error(w, "demo session not prepared", http.StatusConflict)
		return
	}
	strategy := m.demo.Strategy
	if err := m.stopLocked(); err != nil {
		http.Error(w, fmt.Sprintf("failed to reset demo run: %v", err), http.StatusInternalServerError)
		return
	}
	session := newDemoSession(strategy)
	m.metrics.reset(session.Config)
	m.demo = &session
	m.demoLast = make(map[string]DemoClientResult)
	m.broadcastDemoSnapshotLocked()
	writeJSON(w, http.StatusOK, m.demoStateLocked())
}

func (m *ScenarioManager) handleDemoUploadBegin(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}
	var req DemoUploadEventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid upload begin payload: %v", err), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	profile, treatment, err := m.beginDemoUploadLocked(req.ClientID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	m.broadcastDemoUploadLocked(demoStreamUploadBegin, req, profile, treatment)
	writeJSON(w, http.StatusOK, DemoUploadEventResponse{
		Profile:   profile,
		Treatment: treatment,
	})
}

func (m *ScenarioManager) handleDemoUploadEnd(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}
	var req DemoUploadEventRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid upload end payload: %v", err), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	profile, treatment, err := m.endDemoUploadLocked(req.ClientID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	m.broadcastDemoUploadLocked(demoStreamUploadEnd, req, profile, treatment)
	w.WriteHeader(http.StatusNoContent)
}

func newDemoSession(strategy StrategyName) DemoSession {
	cfg := defaultScenarioConfig()
	cfg.Strategy = strategy
	cfg.Clients = demoPlannedUsers
	cfg.UploadBytes = 8 * 1024
	cfg.TotalRateMbps = cfg.TotalRateMbps / 6
	if strategy == StrategyDynamicQoS {
		cfg.TotalRateMbps = cfg.TotalRateMbps * 3
	}
	cfg.Public.RateMbps = cfg.TotalRateMbps * 0.05
	cfg.Optimized.RateMbps = cfg.TotalRateMbps - cfg.Public.RateMbps

	users := make([]DemoUser, 0, demoPlannedUsers)
	for i := 1; i <= demoPlannedUsers; i++ {
		users = append(users, DemoUser{
			ClientID:  clientName(i),
			ClientIP:  clientIPForIndex(i),
			Index:     i,
			Status:    DemoUserStatusPlanned,
			Treatment: defaultDemoTreatment(strategy, i),
		})
	}

	return DemoSession{
		PreparedAt:    time.Now().UTC(),
		Strategy:      strategy,
		InitialUsers:  demoInitialUsers,
		RampPerSecond: demoRampPerSecond,
		Config:        cfg,
		Users:         users,
	}
}

func newDemoRuntimeConfig(session DemoSession) ScenarioConfig {
	cfg := session.Config
	cfg.Clients = 0
	return cfg
}

func (m *ScenarioManager) startDemoRunLocked() error {
	m.stopDemoRampLocked()
	m.config = newDemoRuntimeConfig(*m.demo)
	m.metrics.reset(m.config)
	if err := m.startDemoCallbackServerLocked(); err != nil {
		return err
	}
	if err := m.setupLocked(); err != nil {
		return err
	}
	if err := m.startLocked(); err != nil {
		return err
	}
	if _, err := m.activateDemoUsersLocked(m.demo.InitialUsers); err != nil {
		return err
	}
	m.startDemoRampLocked()
	m.startDemoProgressLocked()
	return nil
}

func (m *ScenarioManager) startDemoRampLocked() {
	ctx, cancel := context.WithCancel(context.Background())
	m.demoRamp = cancel
	ticker := time.NewTicker(time.Second)

	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.mu.Lock()
				if m.server == nil || m.demo == nil {
					m.mu.Unlock()
					return
				}
				activated, err := m.activateDemoUsersLocked(m.demo.RampPerSecond)
				if err != nil || activated == 0 {
					m.stopDemoRampLocked()
					m.mu.Unlock()
					return
				}
				m.broadcastDemoSnapshotLocked()
				m.mu.Unlock()
			}
		}
	}()
}

func (m *ScenarioManager) activateDemoUsersLocked(count int) (int, error) {
	if m.demo == nil {
		return 0, errors.New("demo session not prepared")
	}

	activated := 0
	for i := range m.demo.Users {
		if activated >= count {
			break
		}
		if m.demo.Users[i].ActivatedAt != nil {
			continue
		}

		profile := demoProfileForUser(m.demo.Strategy, m.demo.Users[i].Index)
		client, err := m.addClientLockedWithIndex(profile, m.demo.Users[i].Index)
		if err != nil {
			return activated, err
		}
		now := time.Now().UTC()
		m.demo.Users[i].ActivatedAt = &now
		m.demo.Users[i].Active = true
		m.demo.Users[i].Running = true
		m.demo.Users[i].Status = DemoUserStatusIdle
		m.demo.Users[i].Treatment = demoEffectiveTreatment(m.demo.Strategy, m.demo.Users[i].Treatment, client.Profile)
		activated++
	}
	return activated, nil
}

func (m *ScenarioManager) demoStateLocked() DemoStateResponse {
	now := time.Now().UTC()
	state := DemoStateResponse{
		Strategy:      m.demo.Strategy,
		Running:       m.server != nil,
		PreparedAt:    m.demo.PreparedAt,
		InitialUsers:  m.demo.InitialUsers,
		RampPerSecond: m.demo.RampPerSecond,
		Bandwidth: DemoBandwidth{
			TotalRateMbps:     m.demo.Config.TotalRateMbps,
			PublicRateMbps:    m.demo.Config.Public.RateMbps,
			OptimizedRateMbps: m.demo.Config.Optimized.RateMbps,
		},
		Scenario: m.demo.Config,
		Users:    make([]DemoUser, 0, len(m.demo.Users)),
	}

	report := m.metrics.report()
	clientReports := make(map[string]ClientReport, len(report.Clients))
	for _, client := range report.Clients {
		clientReports[client.ClientID] = client
	}

	for _, user := range m.demo.Users {
		if user.ActivatedAt != nil {
			user.Active = true
			if !user.Uploading && user.Status == DemoUserStatusPlanned {
				user.Status = DemoUserStatusIdle
			}
		}
		if client, ok := clientReports[user.ClientID]; ok {
			user.Active = user.ActivatedAt != nil
			user.Running = client.Running
			user.Attempts = client.Attempts
			user.LastSeen = client.LastSeen
			user.Treatment = demoEffectiveTreatment(m.demo.Strategy, user.Treatment, client.Profile)
			switch {
			case user.Uploading && user.UploadStartedAt != nil:
				elapsed := now.Sub(*user.UploadStartedAt)
				if m.demo.Strategy == StrategyDynamicQoS && client.LastLatencyMS == 0 && elapsed < demoDynamicQoSWarmupGrace {
					user.LastLatencyMS = 0
					user.Status = DemoUserStatusRunning
				} else {
					user.LastLatencyMS = elapsedMS(*user.UploadStartedAt, now)
					user.Status = classifyDemoUserStatus(user.LastLatencyMS)
				}
			case user.Uploading:
				user.Status = DemoUserStatusRunning
				user.LastLatencyMS = client.LastLatencyMS
			case classifyClientStatus(client) == outcomeGood:
				user.LastLatencyMS = client.LastLatencyMS
				user.Status = DemoUserStatusGood
			case classifyClientStatus(client) == outcomeDelayed:
				user.LastLatencyMS = client.LastLatencyMS
				user.Status = DemoUserStatusDelayed
			case classifyClientStatus(client) == outcomeFailed:
				user.LastLatencyMS = client.LastLatencyMS
				user.Status = DemoUserStatusFailed
			default:
				user.LastLatencyMS = client.LastLatencyMS
				user.Status = DemoUserStatusIdle
			}
		}

		state.Users = append(state.Users, user)
		switch user.Status {
		case DemoUserStatusPlanned:
			state.Counters.PlannedUsers++
		case DemoUserStatusIdle:
			state.Counters.IdleUsers++
			state.Counters.ActiveUsers++
		case DemoUserStatusRunning:
			state.Counters.ActiveUsers++
		case DemoUserStatusGood:
			state.Counters.ActiveUsers++
			state.Counters.GoodUsers++
		case DemoUserStatusDelayed:
			state.Counters.ActiveUsers++
			state.Counters.DelayedUsers++
		case DemoUserStatusFailed:
			state.Counters.ActiveUsers++
			state.Counters.FailedUsers++
		}

		if !user.Active {
			continue
		}
		switch user.Treatment {
		case DemoTreatmentReserved:
			state.Counters.ProtectedUsers++
		case DemoTreatmentTemporaryGrant:
			state.Counters.TemporaryGrants++
		}
	}

	return state
}

func classifyClientStatus(client ClientReport) string {
	switch {
	case client.Attempts == 0:
		return "idle"
	case client.LastLatencyMS == 0 && client.Errors > 0:
		return outcomeFailed
	default:
		return classifyLatency(client.LastLatencyMS)
	}
}

func classifyDemoUserStatus(latencyMS float64) DemoUserStatus {
	switch classifyLatency(latencyMS) {
	case outcomeGood:
		return DemoUserStatusGood
	case outcomeDelayed:
		return DemoUserStatusDelayed
	default:
		return DemoUserStatusFailed
	}
}

func elapsedMS(start, now time.Time) float64 {
	if now.Before(start) {
		return 0
	}
	return float64(now.Sub(start).Microseconds()) / 1000.0
}

func defaultDemoTreatment(strategy StrategyName, index int) DemoTreatment {
	switch strategy {
	case StrategyStandardGBR:
		if index <= 30 {
			return DemoTreatmentReserved
		}
		return DemoTreatmentPublic
	case StrategyDynamicQoS:
		return DemoTreatmentPublic
	default:
		return DemoTreatmentPublic
	}
}

func demoProfileForUser(strategy StrategyName, index int) ProfileName {
	if strategy == StrategyDynamicQoS {
		return ProfileOptimized
	}
	return strategyProfile(strategy, index-1)
}

func demoEffectiveTreatment(strategy StrategyName, current DemoTreatment, profile ProfileName) DemoTreatment {
	if strategy == StrategyDynamicQoS {
		return current
	}
	switch profile {
	case ProfileOptimized:
		if current == DemoTreatmentReserved {
			return DemoTreatmentReserved
		}
		return DemoTreatmentTemporaryGrant
	default:
		return DemoTreatmentPublic
	}
}

func demoUploadAssignment(strategy StrategyName, index int, uploading bool) (ProfileName, DemoTreatment) {
	switch strategy {
	case StrategyStandardGBR:
		if index <= 30 {
			return ProfileOptimized, DemoTreatmentReserved
		}
		return ProfilePublic, DemoTreatmentPublic
	case StrategyDynamicQoS:
		if uploading {
			return ProfileOptimized, DemoTreatmentTemporaryGrant
		}
		return ProfileOptimized, DemoTreatmentPublic
	default:
		return ProfilePublic, DemoTreatmentPublic
	}
}

func (m *ScenarioManager) beginDemoUploadLocked(clientID string) (ProfileName, DemoTreatment, error) {
	if m.demo == nil || m.runtime == nil {
		return ProfilePublic, DemoTreatmentPublic, errors.New("demo runtime not active")
	}
	userIndex := m.demoUserIndexLocked(clientID)
	if userIndex < 0 {
		return ProfilePublic, DemoTreatmentPublic, fmt.Errorf("unknown demo client %q", clientID)
	}
	client, ok := m.clientByIDLocked(clientID)
	if !ok {
		return ProfilePublic, DemoTreatmentPublic, fmt.Errorf("client %q not active", clientID)
	}
	profile, treatment := demoUploadAssignment(m.demo.Strategy, m.demo.Users[userIndex].Index, true)
	if client.Profile != profile {
		if err := m.applyClientProfileLocked(client, profile); err != nil {
			return ProfilePublic, DemoTreatmentPublic, err
		}
		m.metrics.setProfile(clientID, profile)
	}
	m.demo.Users[userIndex].Uploading = true
	now := time.Now().UTC()
	m.demo.Users[userIndex].UploadStartedAt = &now
	m.demo.Users[userIndex].Treatment = treatment
	return profile, treatment, nil
}

func (m *ScenarioManager) endDemoUploadLocked(clientID string) (ProfileName, DemoTreatment, error) {
	if m.demo == nil || m.runtime == nil {
		return ProfilePublic, DemoTreatmentPublic, errors.New("demo runtime not active")
	}
	userIndex := m.demoUserIndexLocked(clientID)
	if userIndex < 0 {
		return ProfilePublic, DemoTreatmentPublic, fmt.Errorf("unknown demo client %q", clientID)
	}
	client, ok := m.clientByIDLocked(clientID)
	if !ok {
		return ProfilePublic, DemoTreatmentPublic, fmt.Errorf("client %q not active", clientID)
	}
	profile, treatment := demoUploadAssignment(m.demo.Strategy, m.demo.Users[userIndex].Index, false)
	if client.Profile != profile {
		if err := m.applyClientProfileLocked(client, profile); err != nil {
			return ProfilePublic, DemoTreatmentPublic, err
		}
		m.metrics.setProfile(clientID, profile)
	}
	m.demo.Users[userIndex].Uploading = false
	m.demo.Users[userIndex].UploadStartedAt = nil
	m.demo.Users[userIndex].Treatment = treatment
	return profile, treatment, nil
}

func (m *ScenarioManager) demoUserIndexLocked(clientID string) int {
	if m.demo == nil {
		return -1
	}
	for i := range m.demo.Users {
		if m.demo.Users[i].ClientID == clientID {
			return i
		}
	}
	return -1
}
