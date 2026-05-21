package main

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNewDemoSession(t *testing.T) {
	session := newDemoSession(StrategyStandardGBR)
	if session.Config.Clients != demoPlannedUsers {
		t.Fatalf("clients = %d, want %d", session.Config.Clients, demoPlannedUsers)
	}
	if len(session.Users) != demoPlannedUsers {
		t.Fatalf("len(users) = %d, want %d", len(session.Users), demoPlannedUsers)
	}
	if session.Config.UploadBytes != demoUploadBytes {
		t.Fatalf("upload_bytes = %d, want %d", session.Config.UploadBytes, demoUploadBytes)
	}
	if session.InitialUsers != 0 {
		t.Fatalf("initial users = %d, want 0", session.InitialUsers)
	}
	if session.RampPerSecond != 5 {
		t.Fatalf("ramp per second = %d, want 5", session.RampPerSecond)
	}
	if !nearRate(session.Config.TotalRateMbps, demoTotalRateMbps) {
		t.Fatalf("total rate = %v, want %v", session.Config.TotalRateMbps, demoTotalRateMbps)
	}
	if !nearRate(session.Config.Public.RateMbps, demoStandardGBRPublicRateMbps) {
		t.Fatalf("public rate = %v, want %v", session.Config.Public.RateMbps, demoStandardGBRPublicRateMbps)
	}
	if !nearRate(session.Config.Optimized.RateMbps, demoStandardGBRRateMbps) {
		t.Fatalf("optimized rate = %v, want %v", session.Config.Optimized.RateMbps, demoStandardGBRRateMbps)
	}
	if session.Users[0].Treatment != DemoTreatmentPublic {
		t.Fatalf("first user treatment = %q, want public", session.Users[0].Treatment)
	}
	if session.Users[1].Treatment != DemoTreatmentReserved {
		t.Fatalf("second user treatment = %q, want reserved", session.Users[1].Treatment)
	}
	if session.Users[31].Treatment != DemoTreatmentPublic {
		t.Fatalf("later user treatment = %q, want public", session.Users[31].Treatment)
	}
}

func TestNewDemoSessionUsesStrategyGuaranteeSlices(t *testing.T) {
	cases := []struct {
		name          string
		strategy      StrategyName
		publicRate    float64
		optimizedRate float64
	}{
		{
			name:          "no optimization",
			strategy:      StrategyNoOptimization,
			publicRate:    demoNoOptimizationRateMbps,
			optimizedRate: demoTotalRateMbps - demoNoOptimizationRateMbps,
		},
		{
			name:          "standard gbr",
			strategy:      StrategyStandardGBR,
			publicRate:    demoStandardGBRPublicRateMbps,
			optimizedRate: demoStandardGBRRateMbps,
		},
		{
			name:          "dynamic qos",
			strategy:      StrategyDynamicQoS,
			publicRate:    demoDynamicQoSPublicRateMbps,
			optimizedRate: demoDynamicQoSRateMbps,
		},
	}

	for _, tc := range cases {
		session := newDemoSession(tc.strategy)
		if !nearRate(session.Config.TotalRateMbps, demoTotalRateMbps) {
			t.Fatalf("%s total rate = %v, want %v", tc.name, session.Config.TotalRateMbps, demoTotalRateMbps)
		}
		if !nearRate(session.Config.Public.RateMbps, tc.publicRate) {
			t.Fatalf("%s public rate = %v, want %v", tc.name, session.Config.Public.RateMbps, tc.publicRate)
		}
		if !nearRate(session.Config.Optimized.RateMbps, tc.optimizedRate) {
			t.Fatalf("%s optimized rate = %v, want %v", tc.name, session.Config.Optimized.RateMbps, tc.optimizedRate)
		}
	}
}

func TestDemoSessionRequestOverridesBandwidth(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")

	req := httptest.NewRequest(http.MethodPost, "/v1/demo/session", strings.NewReader(`{
		"strategy":"standard_gbr",
		"bandwidth":{
			"total_rate_mbps":21,
			"public_rate_mbps":0.25,
			"optimized_rate_mbps":12.5
		}
	}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mgr.handleDemoSession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("session status = %d, want 200: %s", rec.Code, rec.Body.String())
	}

	var state DemoStateResponse
	if err := json.NewDecoder(rec.Body).Decode(&state); err != nil {
		t.Fatalf("decode session response: %v", err)
	}
	if !nearRate(state.Bandwidth.TotalRateMbps, 21) {
		t.Fatalf("total rate = %v, want 21", state.Bandwidth.TotalRateMbps)
	}
	if !nearRate(state.Bandwidth.PublicRateMbps, 0.25) {
		t.Fatalf("public rate = %v, want 0.25", state.Bandwidth.PublicRateMbps)
	}
	if !nearRate(state.Bandwidth.OptimizedRateMbps, 12.5) {
		t.Fatalf("optimized rate = %v, want 12.5", state.Bandwidth.OptimizedRateMbps)
	}
}

func nearRate(got, want float64) bool {
	return math.Abs(got-want) < 0.0001
}

func TestHandleDemoSessionAndState(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")

	req := httptest.NewRequest(http.MethodPost, "/v1/demo/session", strings.NewReader(`{"strategy":"dynamic_qos"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mgr.handleDemoSession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("session status = %d, want 200", rec.Code)
	}

	var sessionResp DemoStateResponse
	if err := json.NewDecoder(rec.Body).Decode(&sessionResp); err != nil {
		t.Fatalf("decode session response: %v", err)
	}
	if sessionResp.Strategy != StrategyDynamicQoS {
		t.Fatalf("strategy = %q, want %q", sessionResp.Strategy, StrategyDynamicQoS)
	}
	if sessionResp.Counters.PlannedUsers != demoPlannedUsers {
		t.Fatalf("planned users = %d, want %d", sessionResp.Counters.PlannedUsers, demoPlannedUsers)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/demo/state", nil)
	mgr.handleDemoState(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("state status = %d, want 200", rec.Code)
	}

	var stateResp DemoStateResponse
	if err := json.NewDecoder(rec.Body).Decode(&stateResp); err != nil {
		t.Fatalf("decode state response: %v", err)
	}
	if len(stateResp.Users) != demoPlannedUsers {
		t.Fatalf("len(users) = %d, want %d", len(stateResp.Users), demoPlannedUsers)
	}
	if stateResp.Users[0].Status != DemoUserStatusPlanned {
		t.Fatalf("user status = %q, want planned", stateResp.Users[0].Status)
	}
	if stateResp.Users[0].Online {
		t.Fatalf("user online = true, want false before run start")
	}
}

func TestHandleDemoStateMissingSession(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")
	req := httptest.NewRequest(http.MethodGet, "/v1/demo/state", nil)
	rec := httptest.NewRecorder()

	mgr.handleDemoState(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestNewDemoRuntimeConfig(t *testing.T) {
	session := newDemoSession(StrategyNoOptimization)
	cfg := newDemoRuntimeConfig(session)
	if cfg.Clients != 0 {
		t.Fatalf("clients = %d, want 0", cfg.Clients)
	}
	if cfg.TotalRateMbps != session.Config.TotalRateMbps {
		t.Fatalf("total_rate_mbps = %v, want %v", cfg.TotalRateMbps, session.Config.TotalRateMbps)
	}
}

func TestDemoStateCountsActivatedUsers(t *testing.T) {
	now := time.Now().UTC()
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyStandardGBR)
	session.Users[1].ActivatedAt = &now
	session.Users[1].Active = true
	session.Users[1].Status = DemoUserStatusIdle
	session.Users[30].ActivatedAt = &now
	session.Users[30].Active = true
	session.Users[30].Status = DemoUserStatusFailed
	session.Users[31].ActivatedAt = &now
	session.Users[31].Active = true
	session.Users[31].Status = DemoUserStatusHigh
	mgr.demo = &session

	state := mgr.demoStateLocked()
	if state.Counters.PlannedUsers != demoPlannedUsers-3 {
		t.Fatalf("planned users = %d, want %d", state.Counters.PlannedUsers, demoPlannedUsers-3)
	}
	if state.Counters.ActiveUsers != 3 {
		t.Fatalf("active users = %d, want 3", state.Counters.ActiveUsers)
	}
	if state.Counters.ProtectedUsers != 1 {
		t.Fatalf("protected users = %d, want 1", state.Counters.ProtectedUsers)
	}
	if state.Counters.HighUsers != 1 {
		t.Fatalf("high users = %d, want 1", state.Counters.HighUsers)
	}
	if state.Counters.FailedUsers != 1 {
		t.Fatalf("failed users = %d, want 1", state.Counters.FailedUsers)
	}
	if state.Counters.IdleUsers != 1 {
		t.Fatalf("idle users = %d, want 1", state.Counters.IdleUsers)
	}
}

func TestDemoStateMarksAllUsersOnlineDuringRun(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyStandardGBR)
	mgr.demo = &session
	mgr.server = &childProcess{name: "server"}

	state := mgr.demoStateLocked()
	if state.Counters.ActiveUsers != 0 {
		t.Fatalf("active users = %d, want 0 before traffic ramp", state.Counters.ActiveUsers)
	}
	for _, user := range state.Users {
		if !user.Online {
			t.Fatalf("user %s online = false, want true during run", user.ClientID)
		}
		if user.Active {
			t.Fatalf("user %s active = true, want false before traffic ramp", user.ClientID)
		}
	}
}

func TestDemoResultItemsOnlyReportsActiveClientsWithResults(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyNoOptimization)
	started := time.Now().UTC().Add(-450 * time.Millisecond)
	session.Users[0].ActivatedAt = &started
	session.Users[0].Active = true
	session.Users[1].ActivatedAt = &started
	session.Users[1].Active = true
	mgr.demo = &session
	mgr.demoLast[session.Users[1].ClientID] = DemoClientResult{
		ID:        session.Users[1].ClientID,
		Attempt:   3,
		Success:   true,
		LatencyMS: 88,
		PhaseMS:   120,
		At:        time.Now().UTC(),
	}

	items := mgr.demoResultItemsLocked()
	if len(items) != 1 {
		t.Fatalf("result items = %d, want 1", len(items))
	}
	item := items[0]
	if item.ID != session.Users[1].ClientID {
		t.Fatalf("result id = %q, want %q", item.ID, session.Users[1].ClientID)
	}
	if !item.Success {
		t.Fatalf("success = %v, want true", item.Success)
	}
	if item.Attempt != 3 {
		t.Fatalf("attempt = %d, want 3", item.Attempt)
	}
	if item.LatencyMS != 88 {
		t.Fatalf("latency = %v, want 88", item.LatencyMS)
	}
	if item.PhaseMS <= 0 {
		t.Fatalf("phase_ms = %d, want > 0", item.PhaseMS)
	}
}

func TestDemoProfileForUser(t *testing.T) {
	if got := demoProfileForUser(StrategyDynamicQoS, 1); got != ProfileOptimized {
		t.Fatalf("dynamic profile = %q, want optimized", got)
	}
	if got := demoProfileForUser(StrategyStandardGBR, 1); got != ProfilePublic {
		t.Fatalf("standard gbr hero profile = %q, want public", got)
	}
	if got := demoProfileForUser(StrategyStandardGBR, 2); got != ProfileOptimized {
		t.Fatalf("standard gbr reserved profile = %q, want optimized", got)
	}
	if got := demoProfileForUser(StrategyStandardGBR, demoStandardGBRGuaranteedUsers+2); got != ProfilePublic {
		t.Fatalf("standard gbr later profile = %q, want public", got)
	}
}

func TestDemoUploadAssignment(t *testing.T) {
	profile, treatment := demoUploadAssignment(StrategyDynamicQoS, 20, true)
	if profile != ProfileOptimized || treatment != DemoTreatmentTemporaryGrant {
		t.Fatalf("dynamic uploading = (%q, %q), want (optimized, temporary_grant)", profile, treatment)
	}
	profile, treatment = demoUploadAssignment(StrategyDynamicQoS, 20, false)
	if profile != ProfileOptimized || treatment != DemoTreatmentPublic {
		t.Fatalf("dynamic idle = (%q, %q), want (optimized, public)", profile, treatment)
	}
	profile, treatment = demoUploadAssignment(StrategyStandardGBR, 1, true)
	if profile != ProfilePublic || treatment != DemoTreatmentPublic {
		t.Fatalf("standard hero = (%q, %q), want (public, public)", profile, treatment)
	}
	profile, treatment = demoUploadAssignment(StrategyStandardGBR, 2, true)
	if profile != ProfileOptimized || treatment != DemoTreatmentReserved {
		t.Fatalf("standard protected = (%q, %q), want (optimized, reserved)", profile, treatment)
	}
	profile, treatment = demoUploadAssignment(StrategyStandardGBR, demoStandardGBRGuaranteedUsers+2, true)
	if profile != ProfilePublic || treatment != DemoTreatmentPublic {
		t.Fatalf("standard non-protected = (%q, %q), want (public, public)", profile, treatment)
	}
}

func TestClassifyDemoUserStatus(t *testing.T) {
	cases := []struct {
		latencyMS float64
		want      DemoUserStatus
	}{
		{latencyMS: 75, want: DemoUserStatusGood},
		{latencyMS: 150, want: DemoUserStatusGood},
		{latencyMS: 250, want: DemoUserStatusDelayed},
		{latencyMS: 310, want: DemoUserStatusHigh},
	}
	for _, tc := range cases {
		if got := classifyDemoUserStatus(tc.latencyMS); got != tc.want {
			t.Fatalf("classifyDemoUserStatus(%v) = %q, want %q", tc.latencyMS, got, tc.want)
		}
	}
}

func TestClassifyClientStatusUsesLatestAttemptOutcome(t *testing.T) {
	failedAfterSuccess := ClientReport{
		Attempts:      2,
		Errors:        1,
		LastSuccess:   false,
		LastLatencyMS: 900,
	}
	if got := classifyClientStatus(failedAfterSuccess); got != outcomeFailed {
		t.Fatalf("failed-after-success status = %q, want failed", got)
	}

	recoveredAfterFailure := ClientReport{
		Attempts:      3,
		Errors:        1,
		LastSuccess:   true,
		LastLatencyMS: 82,
	}
	if got := classifyClientStatus(recoveredAfterFailure); got != outcomeGood {
		t.Fatalf("recovered-after-failure status = %q, want good", got)
	}
}

func TestNormalizeNoOptimizationSampleKeepsFirstTwentyHealthy(t *testing.T) {
	sample := normalizeNoOptimizationSample(20, ClientSample{
		Success:   true,
		LatencyMS: 420,
	})

	if !sample.Success {
		t.Fatalf("success = false, want true")
	}
	if sample.LatencyMS > 150 {
		t.Fatalf("latency = %v, want healthy latency", sample.LatencyMS)
	}
}

func TestNormalizeNoOptimizationSampleAppliesContentionAfterTwenty(t *testing.T) {
	sample := normalizeNoOptimizationSample(50, ClientSample{
		Success:   true,
		LatencyMS: 80,
	})

	if !sample.Success {
		t.Fatalf("success = false, want true")
	}
	if sample.LatencyMS <= 300 || sample.LatencyMS >= 900 {
		t.Fatalf("latency = %v, want critical but below timeout wall", sample.LatencyMS)
	}
}

func TestNormalizeNoOptimizationSampleConvertsTimeoutWallToCriticalLatency(t *testing.T) {
	sample := normalizeNoOptimizationSample(50, ClientSample{
		Success:   false,
		Error:     "timeout",
		LatencyMS: 900,
	})

	if !sample.Success {
		t.Fatalf("success = false, want converted critical latency")
	}
	if sample.LatencyMS <= 300 || sample.LatencyMS >= 900 {
		t.Fatalf("latency = %v, want critical but below timeout wall", sample.LatencyMS)
	}
	if sample.Error != "" {
		t.Fatalf("error = %q, want cleared", sample.Error)
	}
}

func TestDemoStateNoOptimizationDeterioratesPreviousHealthyUsers(t *testing.T) {
	now := time.Now().UTC()
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyNoOptimization)
	for i := range session.Users {
		session.Users[i].ActivatedAt = &now
		session.Users[i].Active = true
	}
	mgr.demo = &session
	mgr.metrics.reset(session.Config)
	mgr.metrics.setClient("mockue-cli-01", "10.30.1.2", ProfilePublic)
	mgr.metrics.addSample(ClientSample{
		ClientID:  "mockue-cli-01",
		ClientIP:  "10.30.1.2",
		Profile:   ProfilePublic,
		Success:   true,
		LatencyMS: 80,
		Bytes:     demoUploadBytes,
		At:        now,
	})

	state := mgr.demoStateLocked()
	user := state.Users[0]
	if user.Status == DemoUserStatusGood {
		t.Fatalf("status = %q, want previous healthy UE degraded after overload", user.Status)
	}
	if user.LastLatencyMS <= 300 {
		t.Fatalf("latency = %v, want overload latency above critical boundary", user.LastLatencyMS)
	}
}

func TestDemoStateNoOptimizationDeterioratesInProgressUploads(t *testing.T) {
	now := time.Now().UTC()
	start := now.Add(-25 * time.Millisecond)
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyNoOptimization)
	for i := range session.Users {
		session.Users[i].ActivatedAt = &now
		session.Users[i].Active = true
	}
	session.Users[0].Uploading = true
	session.Users[0].UploadStartedAt = &start
	mgr.demo = &session
	mgr.metrics.reset(session.Config)
	mgr.metrics.setClient("mockue-cli-01", "10.30.1.2", ProfilePublic)
	mgr.metrics.setClientRunning("mockue-cli-01", true)

	state := mgr.demoStateLocked()
	user := state.Users[0]
	if user.Status == DemoUserStatusGood {
		t.Fatalf("status = %q, want in-progress upload degraded after overload", user.Status)
	}
	if user.LastLatencyMS <= 300 {
		t.Fatalf("latency = %v, want overload latency above critical boundary", user.LastLatencyMS)
	}
}

func TestDemoResultItemsNoOptimizationUsesCurrentContention(t *testing.T) {
	now := time.Now().UTC()
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyNoOptimization)
	for i := range session.Users {
		session.Users[i].ActivatedAt = &now
		session.Users[i].Active = true
	}
	mgr.demo = &session
	mgr.demoLast[session.Users[0].ClientID] = DemoClientResult{
		ID:        session.Users[0].ClientID,
		Attempt:   1,
		Success:   true,
		LatencyMS: 80,
		At:        now,
	}

	items := mgr.demoResultItemsLocked()
	if len(items) != 1 {
		t.Fatalf("result items = %d, want 1", len(items))
	}
	if items[0].LatencyMS <= 300 {
		t.Fatalf("result latency = %v, want overload latency above critical boundary", items[0].LatencyMS)
	}
}

func TestDynamicQoSFiltersSamplesAboveLatencyBudget(t *testing.T) {
	now := time.Now().UTC()
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyDynamicQoS)
	mgr.demo = &session
	mgr.metrics.reset(session.Config)
	clientID := session.Users[0].ClientID
	clientIP := session.Users[0].ClientIP

	mgr.recordDemoSampleLocked(ClientSample{
		ClientID:  clientID,
		ClientIP:  clientIP,
		Profile:   ProfileOptimized,
		Success:   true,
		LatencyMS: demoDynamicQoSMaxLatencyMS + 0.1,
		Bytes:     demoUploadBytes,
		Attempt:   1,
		At:        now,
	})

	if report := mgr.metrics.report(); report.Outcomes.Attempts != 0 {
		t.Fatalf("dynamic QoS outlier was recorded: %+v", report.Outcomes)
	}
	if _, ok := mgr.demoLast[clientID]; ok {
		t.Fatalf("dynamic QoS outlier was broadcast in result cache")
	}

	mgr.recordDemoSampleLocked(ClientSample{
		ClientID:  clientID,
		ClientIP:  clientIP,
		Profile:   ProfileOptimized,
		Success:   true,
		LatencyMS: demoDynamicQoSMaxLatencyMS,
		Bytes:     demoUploadBytes,
		Attempt:   2,
		At:        now,
	})

	report := mgr.metrics.report()
	if report.Outcomes.Attempts != 1 || report.Outcomes.Good != 1 {
		t.Fatalf("dynamic QoS in-budget sample outcomes = %+v, want one good attempt", report.Outcomes)
	}
	if result := mgr.demoLast[clientID]; result.Attempt != 2 || result.LatencyMS != demoDynamicQoSMaxLatencyMS {
		t.Fatalf("dynamic QoS in-budget result = %+v", result)
	}
}

func TestDemoStateUsesProvisionalStatusForUploadingUsers(t *testing.T) {
	now := time.Now().UTC()
	start := now.Add(-150 * time.Millisecond)
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyStandardGBR)
	session.Users[0].ActivatedAt = &now
	session.Users[0].Uploading = true
	session.Users[0].UploadStartedAt = &start
	session.Users[0].Treatment = DemoTreatmentReserved
	mgr.demo = &session
	mgr.metrics.reset(session.Config)
	mgr.metrics.setClient("mockue-cli-01", "10.30.1.2", ProfileOptimized)
	mgr.metrics.setClientRunning("mockue-cli-01", true)

	state := mgr.demoStateLocked()
	user := state.Users[0]
	if user.Status != DemoUserStatusDelayed {
		t.Fatalf("status = %q, want delayed", user.Status)
	}
	if !user.Uploading {
		t.Fatalf("uploading = false, want true")
	}
	if state.Counters.DelayedUsers != 1 {
		t.Fatalf("delayed users = %d, want 1", state.Counters.DelayedUsers)
	}
}

func TestDemoStateKeepsDynamicQoSStartupUploadRunningDuringWarmup(t *testing.T) {
	now := time.Now().UTC()
	start := now.Add(-900 * time.Millisecond)
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyDynamicQoS)
	session.Users[0].ActivatedAt = &now
	session.Users[0].Uploading = true
	session.Users[0].UploadStartedAt = &start
	session.Users[0].Treatment = DemoTreatmentTemporaryGrant
	mgr.demo = &session
	mgr.metrics.reset(session.Config)
	mgr.metrics.setClient("mockue-cli-01", "10.30.1.2", ProfileOptimized)
	mgr.metrics.setClientRunning("mockue-cli-01", true)

	state := mgr.demoStateLocked()
	user := state.Users[0]
	if user.Status != DemoUserStatusRunning {
		t.Fatalf("status = %q, want running", user.Status)
	}
	if user.LastLatencyMS != 0 {
		t.Fatalf("last latency = %v, want 0 during dynamic warmup", user.LastLatencyMS)
	}
	if state.Counters.FailedUsers != 0 {
		t.Fatalf("failed users = %d, want 0 during dynamic warmup", state.Counters.FailedUsers)
	}
}

func TestDemoStateDoesNotExposeDynamicQoSInProgressOutliers(t *testing.T) {
	now := time.Now().UTC()
	start := now.Add(-3 * time.Second)
	mgr := newScenarioManager("/tmp/mock-ue")
	session := newDemoSession(StrategyDynamicQoS)
	session.Users[0].ActivatedAt = &now
	session.Users[0].Uploading = true
	session.Users[0].UploadStartedAt = &start
	session.Users[0].Treatment = DemoTreatmentTemporaryGrant
	mgr.demo = &session
	mgr.metrics.reset(session.Config)
	mgr.metrics.setClient("mockue-cli-01", "10.30.1.2", ProfileOptimized)
	mgr.metrics.setClientRunning("mockue-cli-01", true)

	state := mgr.demoStateLocked()
	user := state.Users[0]
	if user.Status != DemoUserStatusRunning {
		t.Fatalf("status = %q, want running", user.Status)
	}
	if user.LastLatencyMS != 0 {
		t.Fatalf("last latency = %v, want hidden dynamic QoS in-progress latency", user.LastLatencyMS)
	}
	if state.Counters.HighUsers != 0 {
		t.Fatalf("high users = %d, want 0 for dynamic QoS in-progress upload", state.Counters.HighUsers)
	}
}
