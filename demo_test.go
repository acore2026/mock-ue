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
	if session.Config.UploadBytes != 8*1024 {
		t.Fatalf("upload_bytes = %d, want %d", session.Config.UploadBytes, 8*1024)
	}
	if session.Config.TotalRateMbps != defaultScenarioConfig().TotalRateMbps/6 {
		t.Fatalf("total rate = %v, want one sixth default", session.Config.TotalRateMbps)
	}
	if got := session.Config.Public.RateMbps + session.Config.Optimized.RateMbps; math.Abs(got-session.Config.TotalRateMbps) > 0.0001 {
		t.Fatalf("profile rates sum = %v, want total %v", got, session.Config.TotalRateMbps)
	}
	if session.Users[0].Treatment != DemoTreatmentReserved {
		t.Fatalf("first user treatment = %q, want reserved", session.Users[0].Treatment)
	}
	if session.Users[31].Treatment != DemoTreatmentPublic {
		t.Fatalf("later user treatment = %q, want public", session.Users[31].Treatment)
	}
}

func TestNewDemoSessionDynamicQoSRaisesOptimizedBudget(t *testing.T) {
	session := newDemoSession(StrategyDynamicQoS)
	if session.Config.TotalRateMbps != defaultScenarioConfig().TotalRateMbps/2 {
		t.Fatalf("dynamic total rate = %v, want half default", session.Config.TotalRateMbps)
	}
	if session.Config.Optimized.RateMbps <= newDemoSession(StrategyStandardGBR).Config.Optimized.RateMbps {
		t.Fatalf("dynamic optimized rate = %v, want greater than standard demo rate", session.Config.Optimized.RateMbps)
	}
	if session.Config.Optimized.RateMbps <= 16 {
		t.Fatalf("dynamic optimized rate = %v, want safely above the no-failure threshold", session.Config.Optimized.RateMbps)
	}
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
	session.Users[0].ActivatedAt = &now
	session.Users[0].Active = true
	session.Users[0].Status = DemoUserStatusIdle
	session.Users[30].ActivatedAt = &now
	session.Users[30].Active = true
	session.Users[30].Status = DemoUserStatusFailed
	mgr.demo = &session

	state := mgr.demoStateLocked()
	if state.Counters.PlannedUsers != demoPlannedUsers-2 {
		t.Fatalf("planned users = %d, want %d", state.Counters.PlannedUsers, demoPlannedUsers-2)
	}
	if state.Counters.ActiveUsers != 2 {
		t.Fatalf("active users = %d, want 2", state.Counters.ActiveUsers)
	}
	if state.Counters.ProtectedUsers != 1 {
		t.Fatalf("protected users = %d, want 1", state.Counters.ProtectedUsers)
	}
	if state.Counters.FailedUsers != 1 {
		t.Fatalf("failed users = %d, want 1", state.Counters.FailedUsers)
	}
	if state.Counters.IdleUsers != 1 {
		t.Fatalf("idle users = %d, want 1", state.Counters.IdleUsers)
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
	if got := demoProfileForUser(StrategyStandardGBR, 1); got != ProfileOptimized {
		t.Fatalf("standard gbr first profile = %q, want optimized", got)
	}
	if got := demoProfileForUser(StrategyStandardGBR, 31); got != ProfilePublic {
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
	profile, treatment = demoUploadAssignment(StrategyStandardGBR, 10, true)
	if profile != ProfileOptimized || treatment != DemoTreatmentReserved {
		t.Fatalf("standard protected = (%q, %q), want (optimized, reserved)", profile, treatment)
	}
	profile, treatment = demoUploadAssignment(StrategyStandardGBR, 40, true)
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
		{latencyMS: 150, want: DemoUserStatusDelayed},
		{latencyMS: 250, want: DemoUserStatusFailed},
	}
	for _, tc := range cases {
		if got := classifyDemoUserStatus(tc.latencyMS); got != tc.want {
			t.Fatalf("classifyDemoUserStatus(%v) = %q, want %q", tc.latencyMS, got, tc.want)
		}
	}
}

func TestDemoStateUsesProvisionalStatusForUploadingUsers(t *testing.T) {
	now := time.Now().UTC()
	start := now.Add(-150 * time.Millisecond)
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
