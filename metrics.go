package main

import (
	"math"
	"sort"
	"sync"
	"time"
)

type ProfileName string

const (
	ProfilePublic    ProfileName = "public"
	ProfileOptimized ProfileName = "optimized"
)

type ProfileConfig struct {
	RateMbps    float64 `json:"rate_mbps"`
	LossPercent float64 `json:"loss_percent"`
	Priority    int     `json:"priority"`
	QueueLimit  int     `json:"queue_limit"`
}

type ScenarioConfig struct {
	Clients     int           `json:"clients"`
	UploadBytes int           `json:"upload_bytes"`
	IntervalMS  int           `json:"interval_ms"`
	DurationS   int           `json:"duration_s"`
	RTTMS       int           `json:"rtt_ms"`
	ServerPort  int           `json:"server_port"`
	ServerIP    string        `json:"server_ip"`
	RouterIP    string        `json:"router_ip"`
	Public      ProfileConfig `json:"public"`
	Optimized   ProfileConfig `json:"optimized"`
}

type ScenarioSetupRequest struct {
	Clients     *int           `json:"clients"`
	UploadBytes *int           `json:"upload_bytes"`
	IntervalMS  *int           `json:"interval_ms"`
	DurationS   *int           `json:"duration_s"`
	RTTMS       *int           `json:"rtt_ms"`
	ServerPort  *int           `json:"server_port"`
	ServerIP    string         `json:"server_ip"`
	RouterIP    string         `json:"router_ip"`
	Public      *ProfileConfig `json:"public"`
	Optimized   *ProfileConfig `json:"optimized"`
}

type RunStartRequest struct {
	DurationS *int `json:"duration_s"`
}

type ProfileUpdateRequest struct {
	Profile ProfileName `json:"profile"`
}

type ClientSample struct {
	ClientID  string      `json:"client_id"`
	ClientIP  string      `json:"client_ip"`
	Profile   ProfileName `json:"profile"`
	Success   bool        `json:"success"`
	LatencyMS float64     `json:"latency_ms,omitempty"`
	Bytes     int         `json:"bytes"`
	Error     string      `json:"error,omitempty"`
	Attempt   int         `json:"attempt"`
	At        time.Time   `json:"at"`
}

type SampleStats struct {
	Count     int     `json:"count"`
	Successes int     `json:"successes"`
	Errors    int     `json:"errors"`
	TotalMS   float64 `json:"total_ms"`
	MeanMS    float64 `json:"mean_ms"`
	P95MS     float64 `json:"p95_ms"`
	MaxMS     float64 `json:"max_ms"`
}

type ClientReport struct {
	ClientID      string      `json:"client_id"`
	ClientIP      string      `json:"client_ip"`
	Profile       ProfileName `json:"profile"`
	Running       bool        `json:"running"`
	Samples       int         `json:"samples"`
	Successes     int         `json:"successes"`
	Errors        int         `json:"errors"`
	MeanMS        float64     `json:"mean_ms"`
	P95MS         float64     `json:"p95_ms"`
	MaxMS         float64     `json:"max_ms"`
	TotalMS       float64     `json:"total_ms"`
	UploadedByte  int         `json:"uploaded_bytes"`
	LastError     string      `json:"last_error,omitempty"`
	LastLatencyMS float64     `json:"last_latency_ms,omitempty"`
	LastSeen      *time.Time  `json:"last_seen,omitempty"`
}

type RunReport struct {
	Running    bool           `json:"running"`
	StartedAt  *time.Time     `json:"started_at,omitempty"`
	FinishedAt *time.Time     `json:"finished_at,omitempty"`
	Scenario   ScenarioConfig `json:"scenario"`
	Aggregate  SampleStats    `json:"aggregate"`
	Clients    []ClientReport `json:"clients"`
}

type clientMetrics struct {
	ClientID    string
	ClientIP    string
	Profile     ProfileName
	Running     bool
	Uploaded    int
	Samples     []float64
	Errors      int
	LastError   string
	LastLatency float64
	LastSeen    *time.Time
}

type MetricsStore struct {
	mu       sync.Mutex
	started  *time.Time
	finished *time.Time
	scenario ScenarioConfig
	clients  map[string]*clientMetrics
}

func newMetricsStore(cfg ScenarioConfig) *MetricsStore {
	return &MetricsStore{
		scenario: cfg,
		clients:  make(map[string]*clientMetrics, cfg.Clients),
	}
}

func (m *MetricsStore) reset(cfg ScenarioConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.scenario = cfg
	m.started = nil
	m.finished = nil
	m.clients = make(map[string]*clientMetrics, cfg.Clients)
}

func (m *MetricsStore) markStarted(t time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.started = &t
	m.finished = nil
}

func (m *MetricsStore) markFinished(t time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.finished = &t
}

func (m *MetricsStore) setClient(id, ip string, profile ProfileName) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clients[id] = &clientMetrics{ClientID: id, ClientIP: ip, Profile: profile}
}

func (m *MetricsStore) setProfile(id string, profile ProfileName) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.clients[id]; ok {
		c.Profile = profile
	}
}

func (m *MetricsStore) addSample(sample ClientSample) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.clients[sample.ClientID]
	if !ok {
		c = &clientMetrics{ClientID: sample.ClientID, ClientIP: sample.ClientIP, Profile: sample.Profile}
		m.clients[sample.ClientID] = c
	}
	c.Profile = sample.Profile
	c.Uploaded += sample.Bytes
	c.LastSeen = &sample.At
	if sample.Success {
		c.Samples = append(c.Samples, sample.LatencyMS)
		c.LastLatency = sample.LatencyMS
		return
	}
	c.Errors++
	c.LastError = sample.Error
}

func (m *MetricsStore) report() RunReport {
	m.mu.Lock()
	defer m.mu.Unlock()

	report := RunReport{
		Running:    m.finished == nil && m.started != nil,
		StartedAt:  m.started,
		FinishedAt: m.finished,
		Scenario:   m.scenario,
	}

	var latencies []float64
	var errors int
	for _, c := range m.clients {
		latencies = append(latencies, c.Samples...)
		errors += c.Errors
	}
	report.Aggregate = summarize(latencies)
	report.Aggregate.Errors = errors

	report.Clients = make([]ClientReport, 0, len(m.clients))
	for _, c := range m.clients {
		clientLatencies := append([]float64(nil), c.Samples...)
		sort.Float64s(clientLatencies)
		s := summarize(clientLatencies)
		lastSeen := c.LastSeen
		report.Clients = append(report.Clients, ClientReport{
			ClientID:      c.ClientID,
			ClientIP:      c.ClientIP,
			Profile:       c.Profile,
			Running:       report.Running,
			Samples:       len(c.Samples),
			Successes:     len(c.Samples),
			Errors:        c.Errors,
			MeanMS:        s.MeanMS,
			P95MS:         s.P95MS,
			MaxMS:         s.MaxMS,
			TotalMS:       s.TotalMS,
			UploadedByte:  c.Uploaded,
			LastError:     c.LastError,
			LastLatencyMS: c.LastLatency,
			LastSeen:      lastSeen,
		})
	}

	sort.Slice(report.Clients, func(i, j int) bool {
		return report.Clients[i].ClientID < report.Clients[j].ClientID
	})
	return report
}

func summarize(values []float64) SampleStats {
	if len(values) == 0 {
		return SampleStats{}
	}
	sort.Float64s(values)
	var total float64
	var max float64
	for i, v := range values {
		total += v
		if i == 0 || v > max {
			max = v
		}
	}
	mean := total / float64(len(values))
	return SampleStats{
		Count:     len(values),
		Successes: len(values),
		TotalMS:   total,
		MeanMS:    mean,
		P95MS:     percentile(values, 95),
		MaxMS:     max,
	}
}

func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	if p <= 0 {
		return values[0]
	}
	if p >= 100 {
		return values[len(values)-1]
	}
	rank := (p / 100) * float64(len(values)-1)
	low := int(math.Floor(rank))
	high := int(math.Ceil(rank))
	if low == high {
		return values[low]
	}
	weight := rank - float64(low)
	return values[low]*(1-weight) + values[high]*weight
}

func secondsFromMillis(ms int) time.Duration {
	return time.Duration(ms) * time.Millisecond
}

func secondsFromDuration(s int) time.Duration {
	return time.Duration(s) * time.Second
}
