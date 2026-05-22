package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

const (
	demoPlannedUsers  = 50
	demoInitialUsers  = 0
	demoRampPerSecond = 5
	demoUploadBytes   = 8 * 1024

	demoNoOptimizationGuaranteedUsers = 20
	demoStandardGBRGuaranteedUsers    = 20
	demoDynamicQoSGuaranteedUsers     = demoPlannedUsers
	demoStandardGBRPublicHealthyUsers = demoPlannedUsers - demoStandardGBRGuaranteedUsers

	demoNoOptimizationRatePerUEMbps = 0.190
	demoStandardGBRRatePerUEMbps    = 12.0 / demoStandardGBRGuaranteedUsers
	demoDynamicQoSRatePerUEMbps     = 0.318
	demoStandardGBRPublicRateMbps   = 3.25
	demoDynamicQoSPublicRateMbps    = 0.10
	demoNoOptimizationRateMbps      = demoNoOptimizationRatePerUEMbps * demoNoOptimizationGuaranteedUsers
	demoStandardGBRRateMbps         = demoStandardGBRRatePerUEMbps * demoStandardGBRGuaranteedUsers
	demoDynamicQoSRateMbps          = demoDynamicQoSRatePerUEMbps * demoDynamicQoSGuaranteedUsers
	demoTotalRateMbps               = demoDynamicQoSRateMbps + demoDynamicQoSPublicRateMbps

	demoDynamicQoSMaxLatencyMS = 150.0
)

type DemoUserStatus string

const (
	DemoUserStatusPlanned DemoUserStatus = "planned"
	DemoUserStatusIdle    DemoUserStatus = "idle"
	DemoUserStatusRunning DemoUserStatus = "running"
	DemoUserStatusGood    DemoUserStatus = "good"
	DemoUserStatusDelayed DemoUserStatus = "delayed"
	DemoUserStatusHigh    DemoUserStatus = "high"
	DemoUserStatusFailed  DemoUserStatus = "failed"
)

type DemoTreatment string

const (
	DemoTreatmentPublic         DemoTreatment = "public"
	DemoTreatmentReserved       DemoTreatment = "reserved"
	DemoTreatmentTemporaryGrant DemoTreatment = "temporary_grant"
)

type DemoRuntimeMode string

const (
	DemoRuntimeReal     DemoRuntimeMode = "real"
	DemoRuntimePlayback DemoRuntimeMode = "playback"
)

type DemoSessionRequest struct {
	Strategy    StrategyName           `json:"strategy"`
	RuntimeMode DemoRuntimeMode        `json:"runtime_mode,omitempty"`
	Bandwidth   *DemoBandwidthOverride `json:"bandwidth,omitempty"`
}

type DemoBandwidthOverride struct {
	TotalRateMbps     *float64 `json:"total_rate_mbps,omitempty"`
	PublicRateMbps    *float64 `json:"public_rate_mbps,omitempty"`
	OptimizedRateMbps *float64 `json:"optimized_rate_mbps,omitempty"`
}

type DemoCounters struct {
	PlannedUsers    int `json:"planned_users"`
	ActiveUsers     int `json:"active_users"`
	ProtectedUsers  int `json:"protected_users"`
	TemporaryGrants int `json:"temporary_grants"`
	GoodUsers       int `json:"good_users"`
	DelayedUsers    int `json:"delayed_users"`
	HighUsers       int `json:"high_users"`
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
	Online          bool           `json:"online"`
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
	Strategy      StrategyName    `json:"strategy"`
	RuntimeMode   DemoRuntimeMode `json:"runtime_mode"`
	Running       bool            `json:"running"`
	PreparedAt    time.Time       `json:"prepared_at"`
	InitialUsers  int             `json:"initial_users"`
	RampPerSecond int             `json:"ramp_per_second"`
	Bandwidth     DemoBandwidth   `json:"bandwidth"`
	Counters      DemoCounters    `json:"counters"`
	Scenario      ScenarioConfig  `json:"scenario"`
	Users         []DemoUser      `json:"users"`
}

type DemoSession struct {
	PreparedAt    time.Time
	Strategy      StrategyName
	RuntimeMode   DemoRuntimeMode
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
	if req.RuntimeMode == "" {
		req.RuntimeMode = DemoRuntimeReal
	}
	if !validDemoRuntimeMode(req.RuntimeMode) {
		http.Error(w, fmt.Sprintf("unknown runtime_mode %q", req.RuntimeMode), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.demoRunActiveLocked() || m.runtime != nil {
		if err := m.stopLocked(); err != nil {
			http.Error(w, fmt.Sprintf("failed to stop active scenario: %v", err), http.StatusInternalServerError)
			return
		}
	}

	session := newDemoSession(req.Strategy)
	session.RuntimeMode = req.RuntimeMode
	if req.Bandwidth != nil {
		applyDemoBandwidthOverride(&session.Config, *req.Bandwidth)
	}
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
	if m.demoRunActiveLocked() {
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
	if !m.demoRunActiveLocked() {
		http.Error(w, "demo run not active", http.StatusConflict)
		return
	}
	var err error
	if m.demo.RuntimeMode == DemoRuntimePlayback {
		_, err = m.activatePlaybackUsersLocked(count)
	} else {
		_, err = m.activateDemoUsersLocked(count)
	}
	if err != nil {
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
	runtimeMode := m.demo.RuntimeMode
	if err := m.stopLocked(); err != nil {
		http.Error(w, fmt.Sprintf("failed to reset demo run: %v", err), http.StatusInternalServerError)
		return
	}
	session := newDemoSession(strategy)
	session.RuntimeMode = runtimeMode
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
	if _, _, err := m.endDemoUploadLocked(req.ClientID); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func newDemoSession(strategy StrategyName) DemoSession {
	cfg := defaultScenarioConfig()
	cfg.Strategy = strategy
	cfg.Clients = demoPlannedUsers
	cfg.UploadBytes = demoUploadBytes
	cfg.DurationS = 0
	applyDemoCapacity(&cfg, strategy)

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
		RuntimeMode:   DemoRuntimeReal,
		InitialUsers:  demoInitialUsers,
		RampPerSecond: demoRampPerSecond,
		Config:        cfg,
		Users:         users,
	}
}

func applyDemoCapacity(cfg *ScenarioConfig, strategy StrategyName) {
	cfg.TotalRateMbps = demoTotalRateMbps

	switch strategy {
	case StrategyStandardGBR:
		cfg.Public.RateMbps = demoStandardGBRPublicRateMbps
		cfg.Optimized.RateMbps = demoStandardGBRRateMbps
	case StrategyDynamicQoS:
		cfg.Public.RateMbps = demoDynamicQoSPublicRateMbps
		cfg.Optimized.RateMbps = demoDynamicQoSRateMbps
	default:
		cfg.Public.RateMbps = demoNoOptimizationRateMbps
		cfg.Optimized.RateMbps = cfg.TotalRateMbps - cfg.Public.RateMbps
	}
}

func applyDemoBandwidthOverride(cfg *ScenarioConfig, override DemoBandwidthOverride) {
	if override.TotalRateMbps != nil && *override.TotalRateMbps > 0 {
		cfg.TotalRateMbps = *override.TotalRateMbps
	}
	if override.PublicRateMbps != nil && *override.PublicRateMbps >= 0 {
		cfg.Public.RateMbps = *override.PublicRateMbps
	}
	if override.OptimizedRateMbps != nil && *override.OptimizedRateMbps >= 0 {
		cfg.Optimized.RateMbps = *override.OptimizedRateMbps
	}
}

func newDemoRuntimeConfig(session DemoSession) ScenarioConfig {
	cfg := session.Config
	cfg.Clients = 0
	return cfg
}

func validDemoRuntimeMode(mode DemoRuntimeMode) bool {
	switch mode {
	case DemoRuntimeReal, DemoRuntimePlayback:
		return true
	default:
		return false
	}
}

func (m *ScenarioManager) startDemoRunLocked() error {
	if m.demo.RuntimeMode == DemoRuntimePlayback {
		return m.startDemoPlaybackLocked()
	}

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

func (m *ScenarioManager) startDemoPlaybackLocked() error {
	m.stopDemoRampLocked()
	m.stopDemoProgressLocked()
	m.stopDemoPlaybackLocked()
	m.config = newDemoRuntimeConfig(*m.demo)
	m.metrics.reset(m.config)
	startedAt := time.Now()
	m.metrics.markStarted(startedAt)

	ctx, cancel := context.WithCancel(context.Background())
	m.demoPlay = cancel
	go m.runDemoPlayback(ctx)
	return nil
}

func (m *ScenarioManager) stopDemoPlaybackLocked() {
	if m.demoPlay != nil {
		m.demoPlay()
		m.demoPlay = nil
	}
}

func (m *ScenarioManager) runDemoPlayback(ctx context.Context) {
	ticker := time.NewTicker(demoProgressInterval)
	defer ticker.Stop()

	tick := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tick++
			m.mu.Lock()
			if m.demo == nil || m.demo.RuntimeMode != DemoRuntimePlayback || m.demoPlay == nil {
				m.mu.Unlock()
				return
			}
			activated, err := m.activatePlaybackUsersLocked(m.demo.RampPerSecond)
			if err != nil {
				log.Printf("demo playback activation failed: %v", err)
				m.mu.Unlock()
				continue
			}
			items := m.playbackResultItemsLocked(tick)
			if activated > 0 {
				m.broadcastDemoSnapshotLocked()
			}
			if len(items) > 0 {
				m.broadcastDemoResultsLocked(items)
				m.broadcastDemoSnapshotLocked()
			}
			m.mu.Unlock()
		}
	}
}

func (m *ScenarioManager) activatePlaybackUsersLocked(count int) (int, error) {
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

		now := time.Now().UTC()
		profile := demoProfileForUser(m.demo.Strategy, m.demo.Users[i].Index)
		m.demo.Users[i].ActivatedAt = &now
		m.demo.Users[i].Active = true
		m.demo.Users[i].Running = true
		m.demo.Users[i].Status = DemoUserStatusIdle
		m.demo.Users[i].Treatment = demoEffectiveTreatment(m.demo.Strategy, m.demo.Users[i].Treatment, profile)
		m.metrics.setClient(m.demo.Users[i].ClientID, m.demo.Users[i].ClientIP, profile)
		m.metrics.setClientRunning(m.demo.Users[i].ClientID, true)
		activated++
	}
	return activated, nil
}

func (m *ScenarioManager) playbackResultItemsLocked(tick int) []DemoClientResult {
	if m.demo == nil {
		return nil
	}

	now := time.Now().UTC()
	activeUsers := m.demoActiveUsersLocked()
	items := make([]DemoClientResult, 0, activeUsers)
	for i := range m.demo.Users {
		if !m.demo.Users[i].Active {
			continue
		}

		user := &m.demo.Users[i]
		user.Attempts++
		profile, treatment := demoUploadAssignment(m.demo.Strategy, user.Index, true)
		latencyMS := playbackLatencyMS(m.demo.Strategy, *user, activeUsers, tick)
		status := classifyDemoUserStatus(latencyMS)
		user.Running = true
		user.Uploading = false
		user.Treatment = treatment
		user.Status = status
		user.LastLatencyMS = latencyMS
		user.LastSeen = &now
		m.metrics.setProfile(user.ClientID, profile)

		sample := ClientSample{
			ClientID:  user.ClientID,
			ClientIP:  user.ClientIP,
			Profile:   profile,
			Success:   true,
			LatencyMS: latencyMS,
			Bytes:     m.demo.Config.UploadBytes,
			Attempt:   user.Attempts,
			At:        now,
		}
		m.metrics.addSample(sample)

		result := DemoClientResult{
			ID:        user.ClientID,
			Attempt:   user.Attempts,
			Success:   true,
			LatencyMS: latencyMS,
			PhaseMS:   int(clientPhaseOffset(user.ClientID, time.Second).Milliseconds()),
			At:        now,
		}
		m.demoLast[user.ClientID] = result
		items = append(items, normalizeDemoResult(m.demo.Strategy, activeUsers, result))
	}
	return items
}

func playbackLatencyMS(strategy StrategyName, user DemoUser, activeUsers int, tick int) float64 {
	jitter := demoLatencyJitterMS(user.ClientID, user.Attempts+tick, 10)
	switch strategy {
	case StrategyDynamicQoS:
		return clampDemoLatency(66+jitter, 42, 118)
	case StrategyStandardGBR:
		if isDemoStandardGBRReservedUser(user.Index) {
			return clampDemoLatency(72+jitter, 48, 135)
		}
		if activeUsers <= demoStandardGBRPublicHealthyUsers {
			return clampDemoLatency(112+jitter, 72, 150)
		}
		overload := activeUsers - demoStandardGBRPublicHealthyUsers
		return clampDemoLatency(300+float64(overload)*5+jitter, 300, 500)
	default:
		if activeUsers <= demoNoOptimizationGuaranteedUsers {
			return clampDemoLatency(88+jitter, 55, 145)
		}
		overload := activeUsers - demoNoOptimizationGuaranteedUsers
		return clampDemoLatency(300+float64(overload)*4+jitter, 300, 500)
	}
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
				if activated > 0 {
					m.broadcastDemoSnapshotLocked()
				}
				if err != nil {
					log.Printf("demo ramp activation failed, will retry: %v", err)
					m.mu.Unlock()
					continue
				}
				if activated == 0 {
					m.stopDemoRampLocked()
					m.mu.Unlock()
					return
				}
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
		RuntimeMode:   m.demo.RuntimeMode,
		Running:       m.demoRunActiveLocked(),
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

	sessionOnline := m.demoRunActiveLocked()
	activeUsers := m.demoActiveUsersLocked()
	for _, user := range m.demo.Users {
		if user.ActivatedAt != nil {
			user.Active = true
			if !user.Uploading && user.Status == DemoUserStatusPlanned {
				user.Status = DemoUserStatusIdle
			}
		}
		if client, ok := clientReports[user.ClientID]; ok {
			clientStatus := classifyDemoClientStatus(m.demo.Strategy, activeUsers, client)
			clientLatency := normalizeDemoClientLatency(m.demo.Strategy, activeUsers, client)
			user.Active = user.ActivatedAt != nil
			user.Running = client.Running
			user.Attempts = client.Attempts
			user.LastSeen = client.LastSeen
			user.Treatment = demoEffectiveTreatment(m.demo.Strategy, user.Treatment, client.Profile)
			switch {
			case user.Uploading && user.UploadStartedAt != nil:
				if m.demo.Strategy == StrategyDynamicQoS {
					user.LastLatencyMS = dynamicQoSDisplayLatency(client.LastLatencyMS)
					user.Status = DemoUserStatusRunning
					break
				}
				user.LastLatencyMS = elapsedMS(*user.UploadStartedAt, now)
				if m.demo.Strategy == StrategyNoOptimization {
					user.LastLatencyMS = normalizeNoOptimizationSample(activeUsers, ClientSample{
						Success:   true,
						LatencyMS: user.LastLatencyMS,
					}).LatencyMS
				} else if m.demo.Strategy == StrategyStandardGBR && client.Profile == ProfilePublic {
					user.LastLatencyMS = normalizeStandardGBRPublicSample(activeUsers, ClientSample{
						ClientID:  user.ClientID,
						Profile:   client.Profile,
						Success:   true,
						LatencyMS: user.LastLatencyMS,
						Attempt:   client.Attempts,
					}).LatencyMS
				}
				user.Status = classifyDemoUserStatus(user.LastLatencyMS)
			case user.Uploading:
				user.Status = DemoUserStatusRunning
				user.LastLatencyMS = clientLatency
			case clientStatus == outcomeGood:
				user.LastLatencyMS = clientLatency
				user.Status = DemoUserStatusGood
			case clientStatus == outcomeDelayed:
				user.LastLatencyMS = clientLatency
				user.Status = DemoUserStatusDelayed
			case clientStatus == outcomeHigh:
				user.LastLatencyMS = clientLatency
				user.Status = DemoUserStatusHigh
			case clientStatus == outcomeFailed:
				user.LastLatencyMS = clientLatency
				user.Status = DemoUserStatusFailed
			default:
				user.LastLatencyMS = clientLatency
				user.Status = DemoUserStatusIdle
			}
		}
		user.Online = sessionOnline || user.Active

		state.Users = append(state.Users, user)
	}

	for _, user := range state.Users {
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
		case DemoUserStatusHigh:
			state.Counters.ActiveUsers++
			state.Counters.HighUsers++
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
	return classifyDemoClientStatus("", 0, client)
}

func classifyDemoClientStatus(strategy StrategyName, activeUsers int, client ClientReport) string {
	switch {
	case client.Attempts == 0:
		return "idle"
	case strategy == StrategyNoOptimization || (strategy == StrategyStandardGBR && client.Profile == ProfilePublic):
		return classifyLatency(normalizeDemoClientLatency(strategy, activeUsers, client))
	case !client.LastSuccess:
		return outcomeFailed
	default:
		return classifyLatency(client.LastLatencyMS)
	}
}

func normalizeDemoClientLatency(strategy StrategyName, activeUsers int, client ClientReport) float64 {
	if client.Attempts == 0 {
		return client.LastLatencyMS
	}
	sample := ClientSample{
		ClientID:  client.ClientID,
		Profile:   client.Profile,
		Success:   client.LastSuccess,
		LatencyMS: client.LastLatencyMS,
		Error:     client.LastError,
		Attempt:   client.Attempts,
	}
	switch strategy {
	case StrategyNoOptimization:
		return normalizeNoOptimizationSample(activeUsers, sample).LatencyMS
	case StrategyStandardGBR:
		return normalizeStandardGBRPublicSample(activeUsers, sample).LatencyMS
	default:
		return client.LastLatencyMS
	}
}

func classifyDemoUserStatus(latencyMS float64) DemoUserStatus {
	switch classifyLatency(latencyMS) {
	case outcomeGood:
		return DemoUserStatusGood
	case outcomeDelayed:
		return DemoUserStatusDelayed
	case outcomeHigh:
		return DemoUserStatusHigh
	default:
		return DemoUserStatusFailed
	}
}

func (m *ScenarioManager) recordDemoSampleLocked(sample ClientSample) {
	if m.demo != nil {
		sample = normalizeDemoSample(m.demo.Strategy, m.demoActiveUsersLocked(), sample)
		if !shouldRecordDemoSample(m.demo.Strategy, sample) {
			return
		}
	}
	m.metrics.addSample(sample)
	m.recordDemoResultLocked(sample)
}

func (m *ScenarioManager) demoActiveUsersLocked() int {
	if m.demo == nil {
		return 0
	}
	active := 0
	for _, user := range m.demo.Users {
		if user.Active || user.ActivatedAt != nil {
			active++
		}
	}
	return active
}

func normalizeDemoSample(strategy StrategyName, activeUsers int, sample ClientSample) ClientSample {
	switch strategy {
	case StrategyNoOptimization:
		return normalizeNoOptimizationSample(activeUsers, sample)
	case StrategyStandardGBR:
		return normalizeStandardGBRPublicSample(activeUsers, sample)
	default:
		return sample
	}
}

func normalizeNoOptimizationSample(activeUsers int, sample ClientSample) ClientSample {
	latencyMS := sample.LatencyMS
	if latencyMS <= 0 && !sample.Success {
		latencyMS = float64(uploadAttemptTimeout.Microseconds()) / 1000.0
	}

	if activeUsers <= demoNoOptimizationGuaranteedUsers {
		sample.Success = true
		if latencyMS <= 0 || latencyMS > 140 {
			latencyMS = 140
		}
		sample.LatencyMS = latencyMS
		sample.Error = ""
		return sample
	}

	floor := noOptimizationContentionFloor(activeUsers)
	if latencyMS < floor {
		latencyMS = floor + demoLatencyJitterMS(sample.ClientID, sample.Attempt, 24)
	}
	if latencyMS > 500 {
		latencyMS = 470 + demoLatencyJitterMS(sample.ClientID, sample.Attempt, 24)
	}
	latencyMS = clampDemoLatency(latencyMS, 300, 500)
	sample.Success = true
	sample.LatencyMS = latencyMS
	sample.Error = ""
	return sample
}

func noOptimizationContentionFloor(activeUsers int) float64 {
	overload := activeUsers - demoNoOptimizationGuaranteedUsers
	if overload < 0 {
		overload = 0
	}
	return 300 + float64(overload)*4
}

func normalizeStandardGBRPublicSample(activeUsers int, sample ClientSample) ClientSample {
	if sample.Profile != ProfilePublic {
		return sample
	}

	latencyMS := sample.LatencyMS
	if activeUsers <= demoStandardGBRPublicHealthyUsers {
		sample.Success = true
		if latencyMS <= 0 || latencyMS > 140 {
			latencyMS = 140
		}
		sample.LatencyMS = latencyMS
		sample.Error = ""
		return sample
	}

	if latencyMS <= 0 || !sample.Success {
		latencyMS = 470 + demoLatencyJitterMS(sample.ClientID, sample.Attempt, 24)
	}

	floor := standardGBRPublicContentionFloor(activeUsers)
	if latencyMS < floor {
		latencyMS = floor + demoLatencyJitterMS(sample.ClientID, sample.Attempt, 24)
	}
	if latencyMS > 500 {
		latencyMS = 470 + demoLatencyJitterMS(sample.ClientID, sample.Attempt, 24)
	}

	sample.Success = true
	sample.LatencyMS = clampDemoLatency(latencyMS, 300, 500)
	sample.Error = ""
	return sample
}

func standardGBRPublicContentionFloor(activeUsers int) float64 {
	overload := activeUsers - demoStandardGBRPublicHealthyUsers
	if overload < 1 {
		overload = 1
	}
	return 300 + float64(overload-1)*5
}

func demoLatencyJitterMS(clientID string, attempt int, amplitude int) float64 {
	if amplitude <= 0 {
		return 0
	}
	span := amplitude*2 + 1
	seed := attempt * 17
	for _, ch := range clientID {
		seed += int(ch)
	}
	return float64(seed%span - amplitude)
}

func clampDemoLatency(value, min, max float64) float64 {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func shouldRecordDemoSample(strategy StrategyName, sample ClientSample) bool {
	return strategy != StrategyDynamicQoS || sample.LatencyMS <= demoDynamicQoSMaxLatencyMS
}

func dynamicQoSDisplayLatency(latencyMS float64) float64 {
	if latencyMS > 0 && latencyMS <= demoDynamicQoSMaxLatencyMS {
		return latencyMS
	}
	return 0
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
		if isDemoStandardGBRReservedUser(index) {
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
	if strategy == StrategyStandardGBR {
		if isDemoStandardGBRReservedUser(index) {
			return ProfileOptimized
		}
		return ProfilePublic
	}
	return strategyProfile(strategy, index-1)
}

func isDemoStandardGBRReservedUser(index int) bool {
	return index > 1 && index <= demoStandardGBRGuaranteedUsers+1
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
		if isDemoStandardGBRReservedUser(index) {
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
