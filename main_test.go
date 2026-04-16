package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDefaultScenarioConfig(t *testing.T) {
	cfg := defaultScenarioConfig()
	if cfg.Strategy != StrategyNoOptimization {
		t.Fatalf("strategy = %q, want %q", cfg.Strategy, StrategyNoOptimization)
	}
	if cfg.Clients != 50 {
		t.Fatalf("clients = %d, want 50", cfg.Clients)
	}
	if cfg.UploadBytes != 120*1024 {
		t.Fatalf("upload bytes = %d, want %d", cfg.UploadBytes, 120*1024)
	}
	if cfg.IntervalMS != 1000 {
		t.Fatalf("interval_ms = %d, want 1000", cfg.IntervalMS)
	}
	if cfg.TotalRateMbps != 100 {
		t.Fatalf("total_rate_mbps = %v, want 100", cfg.TotalRateMbps)
	}
	if cfg.Public.RateMbps != 10 || cfg.Optimized.RateMbps != 90 {
		t.Fatalf("unexpected default profile rates: %#v", cfg)
	}
	if cfg.Public.Priority <= cfg.Optimized.Priority {
		t.Fatalf("priorities not ordered as expected: public=%d optimized=%d", cfg.Public.Priority, cfg.Optimized.Priority)
	}
}

func TestMergeScenarioConfig(t *testing.T) {
	clients := 12
	duration := 15
	totalRate := 120.0
	req := ScenarioSetupRequest{
		Strategy:      StrategyStandardGBR,
		Clients:       &clients,
		DurationS:     &duration,
		ServerIP:      "172.31.10.2",
		RouterIP:      "172.31.10.1",
		TotalRateMbps: &totalRate,
		Public:        &ProfileConfig{RateMbps: 8, LossPercent: 0.5, Priority: 3},
		Optimized:     &ProfileConfig{RateMbps: 60, LossPercent: 0, Priority: 1},
	}
	cfg := mergeScenarioConfig(req)
	if cfg.Strategy != StrategyStandardGBR {
		t.Fatalf("strategy = %q, want %q", cfg.Strategy, StrategyStandardGBR)
	}
	if cfg.Clients != 12 || cfg.DurationS != 15 {
		t.Fatalf("merged config did not apply overrides: %#v", cfg)
	}
	if cfg.ServerIP != "172.31.10.2" || cfg.RouterIP != "172.31.10.1" {
		t.Fatalf("merged config did not apply addresses: %#v", cfg)
	}
	if cfg.TotalRateMbps != 120 {
		t.Fatalf("total rate = %v, want 120", cfg.TotalRateMbps)
	}
	if cfg.Public.RateMbps != 8 || cfg.Optimized.RateMbps != 60 {
		t.Fatalf("merged config did not apply profiles: %#v", cfg)
	}
}

func TestStatisticsHelpers(t *testing.T) {
	values := []float64{10, 20, 30, 40}
	stats := summarize(values)
	if stats.Count != 4 {
		t.Fatalf("count = %d, want 4", stats.Count)
	}
	if stats.MeanMS != 25 {
		t.Fatalf("mean = %v, want 25", stats.MeanMS)
	}
	if stats.MaxMS != 40 {
		t.Fatalf("max = %v, want 40", stats.MaxMS)
	}
	if got := percentile([]float64{10, 20, 30, 40}, 95); got != 38.5 {
		t.Fatalf("p95 = %v, want 38.5", got)
	}
}

func TestIdentityHelpers(t *testing.T) {
	if got := clientName(1); got != "mockue-cli-01" {
		t.Fatalf("clientName(1) = %q", got)
	}
	if got := clientIPForIndex(3); got != "10.30.3.2" {
		t.Fatalf("clientIPForIndex(3) = %q", got)
	}
	if got := clientRouterIPForIndex(3); got != "10.30.3.1" {
		t.Fatalf("clientRouterIPForIndex(3) = %q", got)
	}
	if got := mbps(12.5); got != "12.50mbit" {
		t.Fatalf("mbps(12.5) = %q", got)
	}
	if got := clientIndexFromID("mockue-cli-09"); got != 9 {
		t.Fatalf("clientIndexFromID(mockue-cli-09) = %d, want 9", got)
	}
}

func TestClientPhaseOffset(t *testing.T) {
	interval := time.Second
	if got := clientPhaseOffset("mockue-cli-01", interval); got != 0 {
		t.Fatalf("clientPhaseOffset(client 1) = %v, want 0", got)
	}
	if got := clientPhaseOffset("mockue-cli-26", interval); got != 500*time.Millisecond {
		t.Fatalf("clientPhaseOffset(client 26) = %v, want 500ms", got)
	}
	if got := clientPhaseOffset("mockue-cli-50", interval); got != 980*time.Millisecond {
		t.Fatalf("clientPhaseOffset(client 50) = %v, want 980ms", got)
	}
	if got := clientPhaseOffset("bad", interval); got != 0 {
		t.Fatalf("clientPhaseOffset(bad) = %v, want 0", got)
	}
}

func TestSleepUntilDoesNotCatchUpWhenBehind(t *testing.T) {
	start := time.Now().Add(-2 * time.Second)
	deadline := time.Now().Add(1500 * time.Millisecond)
	before := time.Now()
	if !sleepUntil(deadline, time.Second, start) {
		t.Fatalf("sleepUntil returned false, want true")
	}
	if elapsed := time.Since(before); elapsed < 900*time.Millisecond {
		t.Fatalf("sleepUntil slept %v, want close to one interval", elapsed)
	}
}

func TestStrategyProfile(t *testing.T) {
	if got := strategyProfile(StrategyNoOptimization, 0); got != ProfilePublic {
		t.Fatalf("no optimization profile = %q, want public", got)
	}
	if got := strategyProfile(StrategyStandardGBR, 29); got != ProfileOptimized {
		t.Fatalf("standard GBR index 29 = %q, want optimized", got)
	}
	if got := strategyProfile(StrategyStandardGBR, 30); got != ProfilePublic {
		t.Fatalf("standard GBR index 30 = %q, want public", got)
	}
	if got := strategyProfile(StrategyDynamicQoS, 49); got != ProfileOptimized {
		t.Fatalf("dynamic QoS profile = %q, want optimized", got)
	}
}

func TestClassifyLatency(t *testing.T) {
	cases := []struct {
		latency float64
		want    string
	}{
		{latency: 99.9, want: outcomeGood},
		{latency: 100, want: outcomeDelayed},
		{latency: 200, want: outcomeDelayed},
		{latency: 200.1, want: outcomeFailed},
	}
	for _, tc := range cases {
		if got := classifyLatency(tc.latency); got != tc.want {
			t.Fatalf("classifyLatency(%v) = %q, want %q", tc.latency, got, tc.want)
		}
	}
}

func TestMetricsReportOutcomes(t *testing.T) {
	cfg := defaultScenarioConfig()
	cfg.Strategy = StrategyStandardGBR
	store := newMetricsStore(cfg)
	store.setClient("mockue-cli-01", "10.30.1.2", ProfileOptimized)
	store.setClient("mockue-cli-31", "10.30.31.2", ProfilePublic)
	store.addSample(ClientSample{
		ClientID:  "mockue-cli-01",
		ClientIP:  "10.30.1.2",
		Profile:   ProfileOptimized,
		Success:   true,
		LatencyMS: 80,
		Bytes:     1024,
	})
	store.addSample(ClientSample{
		ClientID:  "mockue-cli-01",
		ClientIP:  "10.30.1.2",
		Profile:   ProfileOptimized,
		Success:   true,
		LatencyMS: 150,
		Bytes:     1024,
	})
	store.addSample(ClientSample{
		ClientID:  "mockue-cli-31",
		ClientIP:  "10.30.31.2",
		Profile:   ProfilePublic,
		Success:   true,
		LatencyMS: 240,
		Bytes:     1024,
	})
	store.addSample(ClientSample{
		ClientID: "mockue-cli-31",
		ClientIP: "10.30.31.2",
		Profile:  ProfilePublic,
		Error:    "timeout",
		Bytes:    1024,
	})

	report := store.report()
	if report.Strategy != StrategyStandardGBR {
		t.Fatalf("strategy = %q, want %q", report.Strategy, StrategyStandardGBR)
	}
	if report.ProtectedClients != 1 {
		t.Fatalf("protected clients = %d, want 1", report.ProtectedClients)
	}
	if report.Outcomes.Attempts != 4 || report.Outcomes.Good != 1 || report.Outcomes.Delayed != 1 || report.Outcomes.Failed != 2 {
		t.Fatalf("unexpected aggregate outcomes: %+v", report.Outcomes)
	}
	if report.Aggregate.Errors != 1 {
		t.Fatalf("aggregate errors = %d, want 1", report.Aggregate.Errors)
	}
	if report.Clients[0].Outcomes.Attempts == 0 || report.Clients[1].Outcomes.Attempts == 0 {
		t.Fatalf("expected per-client outcomes in report: %+v", report.Clients)
	}
}

func TestRequestedProfile(t *testing.T) {
	req := ClientSpawnRequest{Profile: ProfileOptimized, Network: ProfilePublic}
	if got := requestedProfile(req); got != ProfileOptimized {
		t.Fatalf("requestedProfile(profile set) = %q, want optimized", got)
	}
	req = ClientSpawnRequest{Network: ProfilePublic}
	if got := requestedProfile(req); got != ProfilePublic {
		t.Fatalf("requestedProfile(network fallback) = %q, want public", got)
	}
	if validProfile("bad") {
		t.Fatalf("validProfile accepted invalid profile")
	}
}

func TestHandleClientsBeforeRun(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")
	mgr.runtime = &ScenarioRuntime{
		RouterNS: routerNSName,
		ServerNS: serverNSName,
		ServerIP: mgr.config.ServerIP,
		Clients: []ClientRuntime{
			{ID: "mockue-cli-01", IP: "10.30.1.2", Namespace: "mockue-cli-01", LocalIF: "eth0", RouterIF: "vr01", Profile: ProfilePublic},
			{ID: "mockue-cli-02", IP: "10.30.2.2", Namespace: "mockue-cli-02", LocalIF: "eth0", RouterIF: "vr02", Profile: ProfileOptimized},
		},
	}
	mgr.config.Clients = len(mgr.runtime.Clients)
	mgr.metrics.reset(mgr.config)
	for _, client := range mgr.runtime.Clients {
		mgr.metrics.setClient(client.ID, client.IP, client.Profile)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/clients", nil)
	rec := httptest.NewRecorder()
	mgr.handleClients(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var resp ClientsStatusResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Running {
		t.Fatalf("running = true, want false")
	}
	if len(resp.Clients) != 2 {
		t.Fatalf("len(clients) = %d, want 2", len(resp.Clients))
	}
	if resp.Clients[0].Running || resp.Clients[1].Running {
		t.Fatalf("expected clients to be idle before run: %+v", resp.Clients)
	}
}

func TestHandleSpawnClientsRequiresScenario(t *testing.T) {
	mgr := newScenarioManager("/tmp/mock-ue")
	req := httptest.NewRequest(http.MethodPost, "/v1/clients/spawn", strings.NewReader(`{"profile":"public"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	mgr.handleSpawnClients(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
}
