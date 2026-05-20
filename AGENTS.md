# Repository Guidelines

## Project Structure & Module Organization
This repository is a Go-backed QoS simulation demo with a React/Vite dashboard.

- `main.go`: process entrypoint; supports `control`, `server`, and `client` modes.
- `manager.go`: scenario lifecycle, `/v1/*` HTTP routes, process orchestration, and strategy/profile application.
- `demo.go`: demo-session model, user-state calculation, strategy treatment rules, and demo endpoints.
- `metrics.go`: scenario config, profile/strategy types, client samples, and aggregate reports.
- `netops.go`: Linux namespace and traffic-control command construction.
- `workload.go`: mock upload server/client runtime used by spawned simulated UEs.
- `stream.go`: WebSocket event hub for live demo state, upload, result, and heartbeat events.
- `cmd/demo-probe/`: CLI probe for running strategy comparisons against the control API.
- `ui/`: React 19, TypeScript, Vite dashboard. `ui/src/api.ts` owns frontend API calls.
- `specs/` and `.specify/`: Spec Kit artifacts and governance. Read `.specify/memory/constitution.md` before planning feature work.
- `start.sh`: builds the Go backend and UI, then starts the control service and Vite dev server with a proxy.

Generated binaries, `ui/dist/`, logs, screenshots, and local runtime output are not source of truth. Rebuild them instead of editing generated artifacts.

## Build, Test, and Development Commands
- `GOCACHE=/tmp/mock-ue-go-build GOMODCACHE=/tmp/mock-ue-go-mod go build -o /tmp/mock-ue-server .`: build the control binary.
- `GOCACHE=/tmp/mock-ue-go-build GOMODCACHE=/tmp/mock-ue-go-mod go test . ./cmd/demo-probe`: run Go tests without traversing frontend dependency folders.
- `go fmt ./...`: format Go sources before review. If `ui/node_modules` exists, avoid broad `go test ./...` unless you intentionally want to scan nested dependency trees.
- `cd ui && npm run build`: type-check and build the dashboard.
- `cd ui && npm run lint`: run frontend lint checks.
- `./start.sh`: build and run the demo stack. Defaults are backend `0.0.0.0:7501`, UI `0.0.0.0:7500`, logs in `/tmp/mock-ue-demo`.

Manual development startup:

```sh
GOCACHE=/tmp/mock-ue-go-build GOMODCACHE=/tmp/mock-ue-go-mod go build -o /tmp/mock-ue-server .
/tmp/mock-ue-server --mode control --listen 0.0.0.0:7501

cd ui
VITE_API_PROXY_TARGET=http://127.0.0.1:7501 npm run dev -- --host 0.0.0.0 --port 7500 --strictPort
```

## API Notes
The dashboard uses the demo routes:

- `POST /v1/demo/session`: prepare a strategy session. Strategies are `no_optimization`, `standard_gbr`, and `dynamic_qos`.
- `GET /v1/demo/state`: fetch current demo state.
- `POST /v1/demo/run/start`: start a prepared run.
- `POST /v1/demo/run/spawn`: admit more users.
- `POST /v1/demo/run/stop`: stop an active run.
- `POST /v1/demo/run/reset`: reset the current strategy session.
- `GET /v1/demo/stream`: WebSocket stream for live snapshots, uploads, results, and heartbeats.

The lower-level automation routes remain available under `/v1/scenario`, `/v1/run/*`, `/v1/clients*`, and `/v1/metrics/sample`.

## Coding Style & Naming Conventions
Use standard Go formatting with tabs via `go fmt`. Keep exported Go identifiers in `CamelCase` and unexported helpers in `camelCase`. Preserve existing JSON `snake_case` field names because scripts and the dashboard consume them directly.

Keep frontend components and helpers consistent with the current TypeScript/Vite style. Prefer updating `ui/src/api.ts` and `ui/src/types.ts` alongside backend route or payload changes.

## Testing Guidelines
Add table-driven Go tests beside the code they cover. Behavior changes must exercise success, validation, and failure paths. Unit tests must not require root, mutate host networking, or run real `tc` commands; isolate command construction and privileged behavior.

For frontend behavior changes, run `npm run build` and `npm run lint` from `ui/`. Add focused tests or manual validation notes when dashboard behavior changes materially.

## Security & Operational Notes
This service can create Linux namespaces and apply `tc` rules, so treat request input and strategy/profile changes as privileged operational surface. Validate all user-controlled values before they influence command arguments. Avoid hardcoding environment-specific interfaces or addresses in source code.

Running full scenarios requires Linux networking tools and privileges sufficient for namespaces, veth pairs, qdiscs, and filters. The browser dashboard itself can run unprivileged, but real scenario setup typically requires root or equivalent capabilities.

## Commit & Pull Request Guidelines
Use short imperative commit subjects such as `Document demo startup` or `Validate demo strategy`. Keep changes focused, list validation commands, and include sample API requests or responses for behavior changes. For Spec Kit-driven work, keep the spec, plan, tasks, and implementation synchronized with `.specify/memory/constitution.md`.
