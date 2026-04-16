package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	routerNSName      = "mockue-router"
	serverNSName      = "mockue-srv"
	clientNSFmt       = "mockue-cli-%02d"
	routerServerIface = "rt-srv"
	serverIface       = "eth0"
	controlPort       = 9090
	defaultServerPort = 8080
	routerServerCIDR  = "172.31.255.1/24"
	serverCIDR        = "172.31.255.2/24"
	rttDelay          = 10 * time.Millisecond
	defaultBandwidth  = 50 * 1000 * 1000
)

type ClientRuntime struct {
	ID        string      `json:"id"`
	IP        string      `json:"ip"`
	Namespace string      `json:"namespace"`
	LocalIF   string      `json:"local_if"`
	RouterIF  string      `json:"router_if"`
	Profile   ProfileName `json:"profile"`
}

type ScenarioRuntime struct {
	RouterNS string          `json:"router_ns"`
	ServerNS string          `json:"server_ns"`
	ServerIP string          `json:"server_ip"`
	Clients  []ClientRuntime `json:"clients"`
}

type childProcess struct {
	name string
	cmd  *exec.Cmd
}

type ScenarioManager struct {
	mu        sync.Mutex
	execPath  string
	config    ScenarioConfig
	demo      *DemoSession
	demoLast  map[string]DemoClientResult
	demoRamp  context.CancelFunc
	demoProg  context.CancelFunc
	demoHTTP  *http.Server
	demoSock  string
	runtime   *ScenarioRuntime
	server    *childProcess
	clients   map[string]*childProcess
	metrics   *MetricsStore
	stream    *demoStreamHub
	startedAt *time.Time
	runEndsAt *time.Time
}

func newScenarioManager(execPath string) *ScenarioManager {
	cfg := defaultScenarioConfig()
	return &ScenarioManager{
		execPath: execPath,
		config:   cfg,
		demoLast: make(map[string]DemoClientResult),
		metrics:  newMetricsStore(cfg),
		stream:   newDemoStreamHub(),
		clients:  make(map[string]*childProcess),
	}
}

func defaultScenarioConfig() ScenarioConfig {
	return ScenarioConfig{
		Strategy:      StrategyNoOptimization,
		Clients:       50,
		UploadBytes:   120 * 1024,
		IntervalMS:    1000,
		DurationS:     60,
		RTTMS:         20,
		ServerPort:    defaultServerPort,
		ServerIP:      "172.31.255.2",
		RouterIP:      "172.31.255.1",
		TotalRateMbps: 100,
		Public: ProfileConfig{
			RateMbps:    10,
			LossPercent: 0.0001,
			Priority:    2,
			QueueLimit:  100,
		},
		Optimized: ProfileConfig{
			RateMbps:    90,
			LossPercent: 0,
			Priority:    1,
			QueueLimit:  100,
		},
	}
}

func mergeScenarioConfig(req ScenarioSetupRequest) ScenarioConfig {
	cfg := defaultScenarioConfig()
	if req.Strategy != "" {
		cfg.Strategy = req.Strategy
	}
	if req.Clients != nil {
		cfg.Clients = *req.Clients
	}
	if req.UploadBytes != nil {
		cfg.UploadBytes = *req.UploadBytes
	}
	if req.IntervalMS != nil {
		cfg.IntervalMS = *req.IntervalMS
	}
	if req.DurationS != nil {
		cfg.DurationS = *req.DurationS
	}
	if req.RTTMS != nil {
		cfg.RTTMS = *req.RTTMS
	}
	if req.ServerPort != nil {
		cfg.ServerPort = *req.ServerPort
	}
	if req.ServerIP != "" {
		cfg.ServerIP = req.ServerIP
	}
	if req.RouterIP != "" {
		cfg.RouterIP = req.RouterIP
	}
	if req.TotalRateMbps != nil {
		cfg.TotalRateMbps = *req.TotalRateMbps
	}
	if req.Public != nil {
		cfg.Public = *req.Public
	}
	if req.Optimized != nil {
		cfg.Optimized = *req.Optimized
	}
	return cfg
}

func runControl(listenAddr string) error {
	execPath, err := os.Executable()
	if err != nil {
		return err
	}
	mgr := newScenarioManager(execPath)
	mux := http.NewServeMux()
	mgr.registerRoutes(mux)

	srv := &http.Server{Addr: listenAddr, Handler: mux}
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()

	waitForSignal := make(chan os.Signal, 1)
	notifySignals(waitForSignal)

	select {
	case sig := <-waitForSignal:
		log.Printf("shutting down after %s", sig)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = mgr.stopAll()
	return nil
}

func (m *ScenarioManager) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/v1/demo/session", m.handleDemoSession)
	mux.HandleFunc("/v1/demo/state", m.handleDemoState)
	mux.HandleFunc("/v1/demo/run/start", m.handleDemoRunStart)
	mux.HandleFunc("/v1/demo/run/spawn", m.handleDemoRunSpawn)
	mux.HandleFunc("/v1/demo/run/stop", m.handleDemoRunStop)
	mux.HandleFunc("/v1/demo/run/reset", m.handleDemoRunReset)
	mux.HandleFunc("/v1/demo/stream", m.handleDemoStream)
	mux.HandleFunc("/v1/clients", m.handleClients)
	mux.HandleFunc("/v1/clients/spawn", m.handleSpawnClients)
	mux.HandleFunc("/v1/scenario/setup", m.handleSetup)
	mux.HandleFunc("/v1/run/start", m.handleStart)
	mux.HandleFunc("/v1/run/status", m.handleStatus)
	mux.HandleFunc("/v1/run/report", m.handleReport)
	mux.HandleFunc("/v1/run/stop", m.handleStop)
	mux.HandleFunc("/v1/scenario", m.handleDeleteScenario)
	mux.HandleFunc("/v1/clients/", m.handleClientProfile)
	mux.HandleFunc("/v1/metrics/sample", m.handleMetricsSample)
}

func (m *ScenarioManager) handleSetup(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	var req ScenarioSetupRequest
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, fmt.Sprintf("invalid setup payload: %v", err), http.StatusBadRequest)
			return
		}
	}

	cfg := mergeScenarioConfig(req)
	if !validStrategy(cfg.Strategy) {
		http.Error(w, fmt.Sprintf("unknown strategy %q", cfg.Strategy), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.stopLocked(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	m.config = cfg
	m.metrics.reset(cfg)
	if err := m.setupLocked(); err != nil {
		http.Error(w, fmt.Sprintf("setup failed: %v", err), http.StatusInternalServerError)
		_ = m.stopLocked()
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "ready",
		"scenario": m.config,
		"runtime":  m.runtime,
	})
}

func (m *ScenarioManager) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	var req RunStartRequest
	if r.Body != nil {
		defer r.Body.Close()
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtime == nil {
		if err := m.setupLocked(); err != nil {
			http.Error(w, fmt.Sprintf("setup failed: %v", err), http.StatusInternalServerError)
			return
		}
	}
	if m.server != nil {
		http.Error(w, "run already active", http.StatusConflict)
		return
	}

	if req.DurationS != nil && *req.DurationS > 0 {
		m.config.DurationS = *req.DurationS
	}
	m.metrics.reset(m.config)
	for _, client := range m.runtime.Clients {
		m.metrics.setClient(client.ID, client.IP, client.Profile)
	}
	if err := m.startLocked(); err != nil {
		http.Error(w, fmt.Sprintf("start failed: %v", err), http.StatusInternalServerError)
		_ = m.stopLocked()
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"status": "running",
		"config": m.config,
	})
}

func (m *ScenarioManager) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.stopLocked(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "stopped"})
}

func (m *ScenarioManager) handleDeleteScenario(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodDelete); err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.stopLocked(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "torn_down"})
}

func (m *ScenarioManager) handleStatus(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodGet); err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	status := map[string]any{
		"running": m.server != nil,
		"config":  m.config,
		"runtime": m.runtime,
		"report":  m.metrics.report(),
	}
	writeJSON(w, http.StatusOK, status)
}

func (m *ScenarioManager) handleClients(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodGet); err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	report := m.metrics.report()
	writeJSON(w, http.StatusOK, ClientsStatusResponse{
		Running:    m.server != nil,
		StartedAt:  report.StartedAt,
		FinishedAt: report.FinishedAt,
		Scenario:   report.Scenario,
		Clients:    report.Clients,
	})
}

func (m *ScenarioManager) handleReport(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodGet); err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	writeJSON(w, http.StatusOK, m.metrics.report())
}

func (m *ScenarioManager) handleSpawnClients(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}

	var req ClientSpawnRequest
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, fmt.Sprintf("invalid spawn payload: %v", err), http.StatusBadRequest)
			return
		}
	}

	count := req.Count
	if count <= 0 {
		count = 1
	}
	profile := requestedProfile(req)
	if !validProfile(profile) {
		http.Error(w, fmt.Sprintf("unknown profile %q", profile), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtime == nil {
		http.Error(w, "scenario not initialized", http.StatusConflict)
		return
	}

	spawned := make([]ClientRuntime, 0, count)
	for i := 0; i < count; i++ {
		client, err := m.addClientLocked(profile)
		if err != nil {
			http.Error(w, fmt.Sprintf("spawn failed: %v", err), http.StatusInternalServerError)
			return
		}
		spawned = append(spawned, client)
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"status":  "spawned",
		"running": m.server != nil,
		"clients": spawned,
	})
}

func (m *ScenarioManager) handleClientProfile(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/clients/"), "/")
	if len(parts) != 2 || parts[1] != "profile" {
		http.NotFound(w, r)
		return
	}

	clientID := parts[0]
	var req ProfileUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("invalid profile payload: %v", err), http.StatusBadRequest)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtime == nil {
		http.Error(w, "scenario not initialized", http.StatusConflict)
		return
	}
	client, ok := m.clientByIDLocked(clientID)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if err := m.applyClientProfileLocked(client, req.Profile); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	m.metrics.setProfile(clientID, req.Profile)
	writeJSON(w, http.StatusOK, map[string]any{
		"client_id": clientID,
		"profile":   req.Profile,
	})
}

func (m *ScenarioManager) handleMetricsSample(w http.ResponseWriter, r *http.Request) {
	if err := requireMethod(w, r, http.MethodPost); err != nil {
		return
	}
	var sample ClientSample
	if err := json.NewDecoder(r.Body).Decode(&sample); err != nil {
		http.Error(w, fmt.Sprintf("invalid sample payload: %v", err), http.StatusBadRequest)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if sample.ClientID == "" {
		http.Error(w, "client_id is required", http.StatusBadRequest)
		return
	}
	m.metrics.addSample(sample)
	m.broadcastDemoSampleLocked(sample)
	w.WriteHeader(http.StatusNoContent)
}

func (m *ScenarioManager) setupLocked() error {
	if m.runtime != nil {
		return nil
	}

	runtime := &ScenarioRuntime{
		RouterNS: routerNSName,
		ServerNS: serverNSName,
		ServerIP: m.config.ServerIP,
	}
	for i := 1; i <= m.config.Clients; i++ {
		clientID := clientName(i)
		runtime.Clients = append(runtime.Clients, ClientRuntime{
			ID:        clientID,
			IP:        clientIPForIndex(i),
			Namespace: clientID,
			LocalIF:   "eth0",
			RouterIF:  routerVethName(i),
			Profile:   ProfilePublic,
		})
	}

	m.runtime = runtime

	if err := createNamespace(runtime.RouterNS); err != nil {
		return err
	}
	if err := createNamespace(runtime.ServerNS); err != nil {
		return err
	}
	for _, client := range runtime.Clients {
		if err := createNamespace(client.Namespace); err != nil {
			return err
		}
	}

	if err := configureServerLink(runtime); err != nil {
		return err
	}
	if err := configureClients(runtime); err != nil {
		return err
	}
	if err := configureRouter(runtime, m.config); err != nil {
		return err
	}

	for _, client := range runtime.Clients {
		m.metrics.setClient(client.ID, client.IP, client.Profile)
	}
	if err := m.applyStrategyLocked(); err != nil {
		return err
	}
	return nil
}

func (m *ScenarioManager) startLocked() error {
	if m.runtime == nil {
		return errors.New("scenario not initialized")
	}

	serverArgs := []string{"--mode", "server", "--listen", fmt.Sprintf("%s:%d", m.config.ServerIP, m.config.ServerPort)}
	serverCmd, err := m.spawnInNamespace(serverNSName, "server", serverArgs...)
	if err != nil {
		return err
	}
	if err := serverCmd.Start(); err != nil {
		return err
	}
	if f, ok := serverCmd.Stderr.(*os.File); ok {
		_ = f.Close()
	}
	m.server = &childProcess{name: "server", cmd: serverCmd}

	if err := waitForHTTP(m.runtime.ServerIP, m.config.ServerPort, 20, 500*time.Millisecond); err != nil {
		_ = m.stopLocked()
		return err
	}

	startedAt := time.Now()
	runEndsAt := startedAt.Add(time.Duration(m.config.DurationS) * time.Second)
	m.metrics.markStarted(startedAt)
	m.runEndsAt = &runEndsAt
	for _, client := range m.runtime.Clients {
		if err := m.startClientLocked(client, time.Until(runEndsAt)); err != nil {
			_ = m.stopLocked()
			return err
		}
	}

	go func(deadline time.Time) {
		time.Sleep(time.Until(deadline))
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.server != nil {
			_ = m.stopLocked()
		}
	}(runEndsAt)
	return nil
}

func (m *ScenarioManager) stopAll() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopLocked()
}

func (m *ScenarioManager) stopLocked() error {
	m.stopDemoRampLocked()
	m.stopDemoProgressLocked()
	m.stopDemoCallbackServerLocked()
	m.demoLast = make(map[string]DemoClientResult)
	for _, proc := range m.clients {
		killProcess(proc.cmd)
	}
	m.clients = make(map[string]*childProcess)
	m.metrics.setAllClientsRunning(false)
	if m.server != nil {
		killProcess(m.server.cmd)
		m.server = nil
	}
	m.runEndsAt = nil
	m.metrics.markFinished(time.Now())
	if m.runtime != nil {
		if err := teardownNamespace(m.runtime); err != nil {
			m.runtime = nil
			return err
		}
	}
	m.runtime = nil
	return nil
}

func (m *ScenarioManager) stopDemoRampLocked() {
	if m.demoRamp != nil {
		m.demoRamp()
		m.demoRamp = nil
	}
}

func (m *ScenarioManager) startDemoCallbackServerLocked() error {
	m.stopDemoCallbackServerLocked()

	socketPath := filepath.Join(os.TempDir(), "mockue-demo.sock")
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/demo/uploads/begin", m.handleDemoUploadBegin)
	mux.HandleFunc("/v1/demo/uploads/end", m.handleDemoUploadEnd)

	server := &http.Server{Handler: mux}
	m.demoHTTP = server
	m.demoSock = socketPath
	go func() {
		_ = server.Serve(listener)
	}()
	return nil
}

func (m *ScenarioManager) stopDemoCallbackServerLocked() {
	if m.demoHTTP != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = m.demoHTTP.Shutdown(ctx)
		cancel()
		m.demoHTTP = nil
	}
	if m.demoSock != "" {
		_ = os.Remove(m.demoSock)
		m.demoSock = ""
	}
}

func (m *ScenarioManager) spawnInNamespace(ns, name string, args ...string) (*exec.Cmd, error) {
	fullArgs := append([]string{"netns", "exec", ns, m.execPath}, args...)
	cmd := exec.Command("ip", fullArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	logDir := filepath.Join(os.TempDir(), "mockue")
	_ = os.MkdirAll(logDir, 0o755)
	logFile, err := os.OpenFile(filepath.Join(logDir, fmt.Sprintf("%s.log", name)), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	cmd.Stderr = logFile
	return cmd, nil
}

func (m *ScenarioManager) applyClientProfileLocked(client ClientRuntime, profile ProfileName) error {
	if !validProfile(profile) {
		return fmt.Errorf("unknown profile %q", profile)
	}
	client.Profile = profile
	for i := range m.runtime.Clients {
		if m.runtime.Clients[i].ID == client.ID {
			m.runtime.Clients[i].Profile = profile
			break
		}
	}
	return updateRouterFilter(client, profile, m.config)
}

func (m *ScenarioManager) applyStrategyLocked() error {
	if m.runtime == nil {
		return errors.New("scenario not initialized")
	}
	for i, client := range m.runtime.Clients {
		profile := strategyProfile(m.config.Strategy, i)
		if err := m.applyClientProfileLocked(client, profile); err != nil {
			return err
		}
		m.metrics.setProfile(client.ID, profile)
	}
	return nil
}

func (m *ScenarioManager) clientByIDLocked(id string) (ClientRuntime, bool) {
	if m.runtime == nil {
		return ClientRuntime{}, false
	}
	for _, client := range m.runtime.Clients {
		if client.ID == id {
			return client, true
		}
	}
	return ClientRuntime{}, false
}

func clientName(i int) string {
	return fmt.Sprintf(clientNSFmt, i)
}

func clientIPForIndex(i int) string {
	return fmt.Sprintf("10.30.%d.2", i)
}

func clientRouterIPForIndex(i int) string {
	return fmt.Sprintf("10.30.%d.1", i)
}

func localVethName(i int) string {
	return fmt.Sprintf("vc%02d", i)
}

func routerVethName(i int) string {
	return fmt.Sprintf("vr%02d", i)
}

func validStrategy(strategy StrategyName) bool {
	switch strategy {
	case StrategyNoOptimization, StrategyStandardGBR, StrategyDynamicQoS:
		return true
	default:
		return false
	}
}

func strategyProfile(strategy StrategyName, index int) ProfileName {
	switch strategy {
	case StrategyStandardGBR:
		if index < 30 {
			return ProfileOptimized
		}
		return ProfilePublic
	case StrategyDynamicQoS:
		return ProfileOptimized
	default:
		return ProfilePublic
	}
}

func validProfile(profile ProfileName) bool {
	switch profile {
	case ProfilePublic, ProfileOptimized:
		return true
	default:
		return false
	}
}

func requestedProfile(req ClientSpawnRequest) ProfileName {
	if req.Profile != "" {
		return req.Profile
	}
	return req.Network
}

func (m *ScenarioManager) addClientLocked(profile ProfileName) (ClientRuntime, error) {
	if m.runtime == nil {
		return ClientRuntime{}, errors.New("scenario not initialized")
	}

	index := m.nextClientIndexLocked()
	return m.addClientLockedWithIndex(profile, index)
}

func (m *ScenarioManager) addClientLockedWithIndex(profile ProfileName, index int) (ClientRuntime, error) {
	if m.runtime == nil {
		return ClientRuntime{}, errors.New("scenario not initialized")
	}

	client := ClientRuntime{
		ID:        clientName(index),
		IP:        clientIPForIndex(index),
		Namespace: clientName(index),
		LocalIF:   "eth0",
		RouterIF:  routerVethName(index),
		Profile:   profile,
	}

	if err := createNamespace(client.Namespace); err != nil {
		return ClientRuntime{}, err
	}
	if err := configureClient(m.runtime, client, index); err != nil {
		_ = deleteNamespace(client.Namespace)
		return ClientRuntime{}, err
	}
	if err := updateRouterFilterForClient(m.runtime.RouterNS, client, profile, index); err != nil {
		_ = deleteNamespace(client.Namespace)
		return ClientRuntime{}, err
	}

	m.runtime.Clients = append(m.runtime.Clients, client)
	if index > m.config.Clients {
		m.config.Clients = index
	}
	m.metrics.setScenario(m.config)
	m.metrics.setClient(client.ID, client.IP, profile)

	if m.server != nil {
		if err := m.startClientLocked(client, m.remainingRunDurationLocked()); err != nil {
			return ClientRuntime{}, err
		}
	}
	return client, nil
}

func (m *ScenarioManager) startClientLocked(client ClientRuntime, duration time.Duration) error {
	if duration <= 0 {
		return errors.New("run is already ending")
	}

	args := []string{
		"--mode", "client",
		"--client-id", client.ID,
		"--client-ip", client.IP,
		"--server-url", fmt.Sprintf("http://%s:%d/upload", m.config.ServerIP, m.config.ServerPort),
		"--profile", string(client.Profile),
		"--upload-bytes", fmt.Sprintf("%d", m.config.UploadBytes),
		"--interval-ms", fmt.Sprintf("%d", m.config.IntervalMS),
		"--duration-s", fmt.Sprintf("%d", int(math.Ceil(duration.Seconds()))),
	}
	if m.demoSock != "" {
		args = append(args, "--controller-socket", m.demoSock)
	}
	cmd, err := m.spawnInNamespace(client.Namespace, client.ID, args...)
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if f, ok := cmd.Stderr.(*os.File); ok {
		_ = f.Close()
	}
	m.clients[client.ID] = &childProcess{name: client.ID, cmd: cmd}
	m.metrics.setClientRunning(client.ID, true)
	go func(c *exec.Cmd, out io.ReadCloser, id string) {
		defer out.Close()
		m.handleClientStream(id, out)
		_ = c.Wait()
		m.metrics.setClientRunning(id, false)
	}(cmd, stdout, client.ID)
	return nil
}

func (m *ScenarioManager) remainingRunDurationLocked() time.Duration {
	if m.runEndsAt == nil {
		return 0
	}
	return time.Until(*m.runEndsAt)
}

func (m *ScenarioManager) nextClientIndexLocked() int {
	maxIndex := 0
	if m.runtime != nil {
		for _, client := range m.runtime.Clients {
			if idx := clientIndex(client.ID); idx > maxIndex {
				maxIndex = idx
			}
		}
	}
	return maxIndex + 1
}

func requireMethod(w http.ResponseWriter, r *http.Request, expected string) error {
	if r.Method != expected {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return errors.New("method not allowed")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func notifySignals(ch chan os.Signal) {
	// signal import is isolated in this helper to keep the main control path readable.
	signalNotify(ch)
}

func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return contextWithTimeoutImpl(d)
}

func killProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Wait()
}

func waitForHTTP(ip string, port int, attempts int, delay time.Duration) error {
	url := fmt.Sprintf("http://%s:%d/healthz", ip, port)
	for i := 0; i < attempts; i++ {
		if err := exec.Command("ip", "netns", "exec", routerNSName, "curl", "--noproxy", "*", "-sf", "--max-time", "1", url).Run(); err == nil {
			return nil
		}
		time.Sleep(delay)
	}
	return fmt.Errorf("server did not become ready at %s", url)
}

func (m *ScenarioManager) handleClientStream(clientID string, r io.Reader) {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		var sample ClientSample
		if err := json.Unmarshal(scanner.Bytes(), &sample); err != nil {
			continue
		}
		m.mu.Lock()
		m.metrics.addSample(sample)
		m.broadcastDemoSampleLocked(sample)
		m.mu.Unlock()
	}
}
