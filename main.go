package main

import (
	"flag"
	"log"
)

var (
	mode        = flag.String("mode", "control", "run mode: control, server, or client")
	listenAddr  = flag.String("listen", ":9090", "listen address for control or server mode")
	serverURL   = flag.String("server-url", "", "target server URL for client mode")
	clientID    = flag.String("client-id", "", "client identifier for client mode")
	profile     = flag.String("profile", string(ProfilePublic), "traffic profile for client mode")
	clientIP    = flag.String("client-ip", "", "client IP address for client mode")
	controlSock = flag.String("controller-socket", "", "unix socket used for demo upload lifecycle callbacks")
	uploadSize  = flag.Int("upload-bytes", 4096, "upload payload size in bytes")
	intervalMS  = flag.Int("interval-ms", 1000, "upload interval in milliseconds")
	durationS   = flag.Int("duration-s", 60, "client run duration in seconds")
)

func main() {
	flag.Parse()

	switch *mode {
	case "control":
		if err := runControl(*listenAddr); err != nil {
			log.Fatal(err)
		}
	case "server":
		if err := runHTTPServer(*listenAddr); err != nil {
			log.Fatal(err)
		}
	case "client":
		if err := runHTTPClient(ClientRunConfig{
			ClientID:      *clientID,
			ClientIP:      *clientIP,
			ControlSocket: *controlSock,
			ServerURL:     *serverURL,
			Profile:       ProfileName(*profile),
			UploadBytes:   *uploadSize,
			Interval:      secondsFromMillis(*intervalMS),
			Duration:      secondsFromDuration(*durationS),
		}); err != nil {
			log.Fatal(err)
		}
	default:
		log.Fatalf("unknown mode %q", *mode)
	}
}
