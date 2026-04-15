package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

type ClientRunConfig struct {
	ClientID    string
	ClientIP    string
	ServerURL   string
	Profile     ProfileName
	UploadBytes int
	Interval    time.Duration
	Duration    time.Duration
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
	client := &http.Client{Timeout: 30 * time.Second}
	enc := json.NewEncoder(os.Stdout)

	start := time.Now()
	deadline := start.Add(cfg.Duration)
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

		reqStart := time.Now()
		req, err := http.NewRequest(http.MethodPost, cfg.ServerURL, bytes.NewReader(payload))
		if err != nil {
			sample.Error = err.Error()
			printSample(enc, sample)
			sleepUntil(deadline, cfg.Interval, reqStart)
			continue
		}
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := client.Do(req)
		if err != nil {
			sample.Error = err.Error()
			printSample(enc, sample)
			sleepUntil(deadline, cfg.Interval, reqStart)
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		sample.Success = true
		sample.LatencyMS = float64(time.Since(reqStart).Microseconds()) / 1000.0
		printSample(enc, sample)
		sleepUntil(deadline, cfg.Interval, reqStart)
	}
	return nil
}

func printSample(enc *json.Encoder, sample ClientSample) {
	_ = enc.Encode(sample)
}

func sleepUntil(deadline time.Time, interval time.Duration, started time.Time) {
	next := started.Add(interval)
	if next.After(deadline) {
		return
	}
	time.Sleep(time.Until(next))
}
