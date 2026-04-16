package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const uploadAttemptTimeout = 900 * time.Millisecond

type ClientRunConfig struct {
	ClientID      string
	ClientIP      string
	ControlSocket string
	ServerURL     string
	Profile       ProfileName
	UploadBytes   int
	Interval      time.Duration
	Duration      time.Duration
}

func runHTTPServer(listen string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/upload", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		n, _ := io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/plain")
		_, _ = fmt.Fprintf(w, "received %d bytes\n", n)
	})

	srv := &http.Server{Addr: listen, Handler: mux}
	log.Printf("mockue server listening on %s", listen)
	return srv.ListenAndServe()
}

func runHTTPClient(cfg ClientRunConfig) error {
	if cfg.ClientID == "" {
		return errors.New("client-id is required")
	}
	if cfg.ServerURL == "" {
		return errors.New("server-url is required")
	}
	if cfg.UploadBytes <= 0 {
		cfg.UploadBytes = 4096
	}
	if cfg.Interval <= 0 {
		cfg.Interval = time.Second
	}
	if cfg.Duration <= 0 {
		cfg.Duration = 60 * time.Second
	}

	payload := bytes.Repeat([]byte("a"), cfg.UploadBytes)
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy: nil,
		},
	}
	controlClient := controlHTTPClient(cfg.ControlSocket)
	enc := json.NewEncoder(os.Stdout)

	start := time.Now()
	deadline := start.Add(cfg.Duration)
	initialDelay := clientPhaseOffset(cfg.ClientID, cfg.Interval)
	if initialDelay > 0 {
		firstSend := start.Add(initialDelay)
		if firstSend.After(deadline) {
			return nil
		}
		time.Sleep(time.Until(firstSend))
	}
	attempt := 0
	for time.Now().Before(deadline) {
		attempt++
		sample := ClientSample{
			ClientID: cfg.ClientID,
			ClientIP: cfg.ClientIP,
			Profile:  cfg.Profile,
			Bytes:    cfg.UploadBytes,
			Attempt:  attempt,
			At:       time.Now().UTC(),
		}
		sample.Profile = cfg.Profile

		reqStart := time.Now()
		if controlClient != nil {
			profile, err := notifyUploadBegin(controlClient, cfg.ClientID, attempt)
			if err != nil {
				sample.Error = fmt.Sprintf("control begin failed: %v", err)
				printSample(enc, sample)
				if !sleepUntil(deadline, cfg.Interval, reqStart) {
					break
				}
				continue
			}
			sample.Profile = profile
		}
		reqStart = time.Now()
		sample.At = reqStart.UTC()
		reqCtx, cancel := context.WithTimeout(context.Background(), uploadAttemptTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, cfg.ServerURL, bytes.NewReader(payload))
		if err != nil {
			cancel()
			sample.Error = err.Error()
			notifyUploadEnd(controlClient, cfg.ClientID, attempt)
			printSample(enc, sample)
			if !sleepUntil(deadline, cfg.Interval, reqStart) {
				break
			}
			continue
		}
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := client.Do(req)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
				sample.Error = "timeout"
				sample.LatencyMS = float64(uploadAttemptTimeout.Microseconds()) / 1000.0
			} else {
				sample.Error = err.Error()
			}
			cancel()
			notifyUploadEnd(controlClient, cfg.ClientID, attempt)
			printSample(enc, sample)
			if !sleepUntil(deadline, cfg.Interval, reqStart) {
				break
			}
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		cancel()
		sample.Success = true
		sample.LatencyMS = float64(time.Since(reqStart).Microseconds()) / 1000.0
		printSample(enc, sample)
		notifyUploadEnd(controlClient, cfg.ClientID, attempt)
		if !sleepUntil(deadline, cfg.Interval, reqStart) {
			break
		}
	}
	return nil
}

func printSample(enc *json.Encoder, sample ClientSample) {
	_ = enc.Encode(sample)
}

func sleepUntil(deadline time.Time, interval time.Duration, started time.Time) bool {
	next := started.Add(interval)
	if !time.Now().Before(next) {
		next = time.Now().Add(interval)
	}
	if next.After(deadline) {
		return false
	}
	time.Sleep(time.Until(next))
	return true
}

func clientPhaseOffset(clientID string, interval time.Duration) time.Duration {
	if interval <= 0 {
		return 0
	}
	index := clientIndexFromID(clientID)
	if index <= 1 {
		return 0
	}
	// Spread clients evenly across the interval so they do not all burst together.
	phaseSteps := 50
	offset := time.Duration((int64(interval) * int64((index-1)%phaseSteps)) / int64(phaseSteps))
	if offset >= interval {
		return 0
	}
	return offset
}

func clientIndexFromID(clientID string) int {
	parts := strings.Split(clientID, "-")
	if len(parts) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(parts[len(parts)-1])
	return n
}

func controlHTTPClient(socket string) *http.Client {
	if socket == "" {
		return nil
	}
	return &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		},
	}
}

func notifyUploadBegin(client *http.Client, clientID string, attempt int) (ProfileName, error) {
	if client == nil {
		return ProfilePublic, nil
	}
	body, _ := json.Marshal(DemoUploadEventRequest{ClientID: clientID, Attempt: attempt})
	req, err := http.NewRequest(http.MethodPost, "http://unix/v1/demo/uploads/begin", bytes.NewReader(body))
	if err != nil {
		return ProfilePublic, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return ProfilePublic, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return ProfilePublic, fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var grant DemoUploadEventResponse
	if err := json.NewDecoder(resp.Body).Decode(&grant); err != nil {
		return ProfilePublic, err
	}
	return grant.Profile, nil
}

func notifyUploadEnd(client *http.Client, clientID string, attempt int) {
	if client == nil {
		return
	}
	body, _ := json.Marshal(DemoUploadEventRequest{ClientID: clientID, Attempt: attempt})
	req, err := http.NewRequest(http.MethodPost, "http://unix/v1/demo/uploads/end", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}
