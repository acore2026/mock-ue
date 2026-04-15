package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func runInNamespace(ns string, name string, args ...string) error {
	fullArgs := append([]string{"netns", "exec", ns, name}, args...)
	cmd := exec.Command("ip", fullArgs...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v failed: %v: %s", name, args, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func createNamespace(ns string) error {
	_ = exec.Command("ip", "netns", "del", ns).Run()
	return runCommand("ip", "netns", "add", ns)
}

func deleteNamespace(ns string) error {
	return runCommand("ip", "netns", "del", ns)
}

func runCommand(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v failed: %v: %s", name, args, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func signalNotify(ch chan os.Signal) {
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
}

func contextWithTimeoutImpl(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

func configureServerLink(runtime *ScenarioRuntime) error {
	local := "veth-srv"
	router := routerServerIface
	routerIP := strings.Split(routerServerCIDR, "/")[0]
	if err := runCommand("ip", "link", "add", local, "type", "veth", "peer", "name", router); err != nil {
		return err
	}
	if err := runCommand("ip", "link", "set", local, "netns", runtime.ServerNS); err != nil {
		return err
	}
	if err := runCommand("ip", "link", "set", router, "netns", runtime.RouterNS); err != nil {
		return err
	}
	if err := runInNamespace(runtime.ServerNS, "ip", "link", "set", local, "name", serverIface); err != nil {
		return err
	}
	if err := runInNamespace(runtime.ServerNS, "ip", "addr", "add", serverCIDR, "dev", serverIface); err != nil {
		return err
	}
	if err := runInNamespace(runtime.ServerNS, "ip", "link", "set", serverIface, "up"); err != nil {
		return err
	}
	if err := runInNamespace(runtime.ServerNS, "ip", "route", "replace", "default", "via", routerIP); err != nil {
		return err
	}
	if err := runInNamespace(runtime.ServerNS, "tc", "qdisc", "replace", "dev", serverIface, "root", "netem", "delay", rttDelay.String()); err != nil {
		return err
	}

	if err := runInNamespace(runtime.RouterNS, "ip", "link", "set", "lo", "up"); err != nil {
		return err
	}
	if err := runInNamespace(runtime.RouterNS, "ip", "addr", "add", routerServerCIDR, "dev", router); err != nil {
		return err
	}
	if err := runInNamespace(runtime.RouterNS, "ip", "link", "set", router, "up"); err != nil {
		return err
	}
	if err := runInNamespace(runtime.RouterNS, "sysctl", "-w", "net.ipv4.ip_forward=1"); err != nil {
		return err
	}
	return nil
}

func configureClients(runtime *ScenarioRuntime) error {
	for idx, client := range runtime.Clients {
		local := localVethName(idx + 1)
		router := client.RouterIF
		if err := runCommand("ip", "link", "add", local, "type", "veth", "peer", "name", router); err != nil {
			return err
		}
		if err := runCommand("ip", "link", "set", local, "netns", client.Namespace); err != nil {
			return err
		}
		if err := runCommand("ip", "link", "set", router, "netns", runtime.RouterNS); err != nil {
			return err
		}
		if err := runInNamespace(client.Namespace, "ip", "link", "set", local, "name", serverIface); err != nil {
			return err
		}
		if err := runInNamespace(client.Namespace, "ip", "addr", "add", fmt.Sprintf("10.30.%d.2/24", idx+1), "dev", serverIface); err != nil {
			return err
		}
		if err := runInNamespace(client.Namespace, "ip", "link", "set", serverIface, "up"); err != nil {
			return err
		}
		if err := runInNamespace(client.Namespace, "ip", "route", "replace", "default", "via", clientRouterIPForIndex(idx+1)); err != nil {
			return err
		}
		if err := runInNamespace(client.Namespace, "tc", "qdisc", "replace", "dev", serverIface, "root", "netem", "delay", rttDelay.String()); err != nil {
			return err
		}

		if err := runInNamespace(runtime.RouterNS, "ip", "addr", "add", fmt.Sprintf("10.30.%d.1/24", idx+1), "dev", router); err != nil {
			return err
		}
		if err := runInNamespace(runtime.RouterNS, "ip", "link", "set", router, "up"); err != nil {
			return err
		}
	}
	return nil
}

func configureRouter(runtime *ScenarioRuntime, cfg ScenarioConfig) error {
	maxRate := math.Max(cfg.Public.RateMbps, cfg.Optimized.RateMbps)
	if maxRate <= 0 {
		maxRate = 50
	}

	if err := runInNamespace(runtime.RouterNS, "tc", "qdisc", "replace", "dev", routerServerIface, "root", "handle", "1:", "htb", "default", "20"); err != nil {
		return err
	}
	if err := runInNamespace(runtime.RouterNS, "tc", "class", "replace", "dev", routerServerIface, "parent", "1:", "classid", "1:1", "htb", "rate", mbps(maxRate), "ceil", mbps(maxRate), "prio", "1"); err != nil {
		return err
	}
	if err := runInNamespace(runtime.RouterNS, "tc", "class", "replace", "dev", routerServerIface, "parent", "1:1", "classid", "1:10", "htb", "rate", mbps(cfg.Public.RateMbps), "ceil", mbps(cfg.Public.RateMbps), "prio", strconv.Itoa(cfg.Public.Priority)); err != nil {
		return err
	}
	if err := runInNamespace(runtime.RouterNS, "tc", "class", "replace", "dev", routerServerIface, "parent", "1:1", "classid", "1:20", "htb", "rate", mbps(cfg.Optimized.RateMbps), "ceil", mbps(cfg.Optimized.RateMbps), "prio", strconv.Itoa(cfg.Optimized.Priority)); err != nil {
		return err
	}
	if cfg.Public.LossPercent > 0 {
		if err := runInNamespace(runtime.RouterNS, "tc", "qdisc", "replace", "dev", routerServerIface, "parent", "1:10", "handle", "10:", "netem", "loss", fmt.Sprintf("%.4f%%", cfg.Public.LossPercent)); err != nil {
			return err
		}
	}

	for idx, client := range runtime.Clients {
		if err := updateRouterFilterForClient(runtime.RouterNS, client, ProfilePublic, idx+1); err != nil {
			return err
		}
	}
	return nil
}

func updateRouterFilter(client ClientRuntime, profile ProfileName, cfg ScenarioConfig) error {
	return updateRouterFilterForClient(routerNSName, client, profile, clientIndex(client.ID))
}

func updateRouterFilterForClient(ns string, client ClientRuntime, profile ProfileName, index int) error {
	classID := "1:10"
	if profile == ProfileOptimized {
		classID = "1:20"
	}
	if index <= 0 {
		index = clientIndex(client.ID)
	}
	if index <= 0 {
		return fmt.Errorf("invalid client id %q", client.ID)
	}
	return runInNamespace(ns, "tc", "filter", "replace", "dev", routerServerIface, "protocol", "ip", "parent", "1:", "prio", strconv.Itoa(100+index), "u32", "match", "ip", "src", client.IP+"/32", "flowid", classID)
}

func teardownNamespace(runtime *ScenarioRuntime) error {
	var errs []string
	for _, client := range runtime.Clients {
		if err := deleteNamespace(client.Namespace); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if err := deleteNamespace(runtime.ServerNS); err != nil {
		errs = append(errs, err.Error())
	}
	if err := deleteNamespace(runtime.RouterNS); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func mbps(rate float64) string {
	if rate <= 0 {
		rate = 1
	}
	if math.Mod(rate, 1) == 0 {
		return fmt.Sprintf("%.0fmbit", rate)
	}
	return fmt.Sprintf("%.2fmbit", rate)
}

func clientIndex(clientID string) int {
	parts := strings.Split(clientID, "-")
	if len(parts) == 0 {
		return 0
	}
	n, _ := strconv.Atoi(parts[len(parts)-1])
	return n
}
