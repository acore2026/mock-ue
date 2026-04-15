# Repository Guidelines

## Project Structure & Module Organization
This repository is a small Go service for applying Linux `tc` rules through an HTTP API.

- `main.go`: server entrypoint, HTTP handlers, config loading, and shelling out to `tc`
- `flows.json`: flow definitions keyed by name, used by `/v1/rules`
- `go.mod`, `go.sum`: module and dependency metadata
- `mock-ue-server`: compiled binary artifact; prefer rebuilding instead of editing or committing generated binaries
- `server.log`: local runtime output

Keep new code in small files by concern if the service grows, for example `handlers.go` or `config.go`.

## Build, Test, and Development Commands
- `GOCACHE=/tmp/mock-ue-go-build GOMODCACHE=/tmp/mock-ue-go-mod go build -o /tmp/mock-ue-server ./...`: build the server with writable caches
- `GOCACHE=/tmp/mock-ue-go-build GOMODCACHE=/tmp/mock-ue-go-mod go test ./...`: run all tests
- `go fmt ./...`: format Go sources before review
- `sudo /tmp/mock-ue-server`: run locally; `tc` operations usually require root or equivalent capabilities

Example API workflow after startup:

```sh
curl -X POST http://127.0.0.1:9090/v1/config/reload
curl http://127.0.0.1:9090/v1/flows
```

## Coding Style & Naming Conventions
Use standard Go formatting with tabs via `go fmt`. Keep exported types in `CamelCase` (`RuleRequest`) and unexported helpers in `camelCase` (`loadConfig`). Prefer clear handler names matching routes, and keep JSON field names `snake_case` to preserve the current API shape.

## Testing Guidelines
There are no `_test.go` files yet. Add table-driven tests with Go’s `testing` package, and place them beside the code they cover. Name tests `TestXxx`, for example `TestLoadConfig` or `TestApplyRuleRejectsUnknownFlow`. Mock external command execution instead of running real `tc` calls in unit tests.

## Commit & Pull Request Guidelines
Git history is not available in this checkout, so no repository-specific commit convention can be inferred. Use short imperative subjects such as `Add flow validation`. Keep pull requests focused, describe API or config changes, list validation steps, and include sample `curl` requests or responses when behavior changes.

## Security & Configuration Notes
Do not trust request input blindly: this service drives privileged network shaping commands. Review changes to `flows.json` carefully, avoid hardcoding environment-specific interfaces, and document any requirement for root, Linux networking tools, or host capabilities in the PR.
