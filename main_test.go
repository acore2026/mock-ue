package main

import "testing"

func TestDefaultScenarioConfig(t *testing.T) {
	cfg := defaultScenarioConfig()
	if cfg.Clients != 30 {
		t.Fatalf("clients = %d, want 30", cfg.Clients)
	}
	if cfg.UploadBytes != 4096 {
		t.Fatalf("upload bytes = %d, want 4096", cfg.UploadBytes)
	}
	if cfg.Public.RateMbps != 10 || cfg.Optimized.RateMbps != 50 {
		t.Fatalf("unexpected default profile rates: %#v", cfg)
	}
}

func TestMergeScenarioConfig(t *testing.T) {
	clients := 12
	duration := 15
	req := ScenarioSetupRequest{
		Clients:   &clients,
		DurationS: &duration,
		ServerIP:  "172.31.10.2",
		RouterIP:  "172.31.10.1",
		Public:    &ProfileConfig{RateMbps: 8, LossPercent: 0.5, Priority: 3},
		Optimized: &ProfileConfig{RateMbps: 60, LossPercent: 0, Priority: 1},
	}
	cfg := mergeScenarioConfig(req)
	if cfg.Clients != 12 || cfg.DurationS != 15 {
		t.Fatalf("merged config did not apply overrides: %#v", cfg)
	}
	if cfg.ServerIP != "172.31.10.2" || cfg.RouterIP != "172.31.10.1" {
		t.Fatalf("merged config did not apply addresses: %#v", cfg)
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
}
