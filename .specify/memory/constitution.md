<!--
Sync Impact Report
Version change: template -> 1.0.0
Modified principles:
- PRINCIPLE_1_NAME -> I. Small, Reviewable Go Code
- PRINCIPLE_2_NAME -> II. Behavior and Safety Tests
- PRINCIPLE_3_NAME -> III. Consistent HTTP User Experience
- PRINCIPLE_4_NAME -> IV. Measured Performance
Added sections:
- Operational Constraints
- Delivery Workflow and Quality Gates
Removed sections:
- Placeholder fifth principle from template; four principles match the requested focus areas.
Templates requiring updates:
- ✅ .specify/templates/plan-template.md
- ✅ .specify/templates/spec-template.md
- ✅ .specify/templates/tasks-template.md
- ✅ .specify/templates/checklist-template.md
- ✅ .specify/templates/commands/*.md (no files present)
- ✅ AGENTS.md
Follow-up TODOs:
- None
-->
# Mock UE Constitution

## Core Principles

### I. Small, Reviewable Go Code
Production code MUST be idiomatic Go, formatted with `go fmt`, and organized by
clear concerns. Changes MUST keep handlers, configuration loading, validation,
and command execution readable enough to review in isolation. New abstractions
MUST remove meaningful duplication or isolate privileged behavior; speculative
frameworks and broad rewrites are prohibited.

Rationale: this service applies Linux traffic-control rules through privileged
commands, so understandable control flow is a safety requirement.

### II. Behavior and Safety Tests
Every behavior change MUST include tests that exercise the changed success,
validation, and failure paths. Unit tests MUST mock external `tc` execution and
MUST NOT require root privileges, host network mutation, or environment-specific
interfaces. Gaps are allowed only when documented in the plan with the risk,
manual validation command, and follow-up owner.

Rationale: test coverage must prove API behavior and command construction
without changing the developer or CI host network.

### III. Consistent HTTP User Experience
HTTP APIs MUST preserve stable JSON field names, predictable status codes, and
actionable error responses. New or changed routes MUST include examples for
successful and failed requests, and must remain consistent with existing
`/v1/*` route semantics unless the specification explicitly calls out a breaking
change and migration path.

Rationale: operators use this service through scripts and curl workflows, so
consistency is the user experience.

### IV. Measured Performance
Features MUST state expected latency, throughput, startup, or resource impact
when they affect request handling, configuration reloads, or rule application.
Implementations MUST avoid unnecessary shell invocations, unbounded request
processing, and repeated config parsing on hot paths. Performance claims MUST be
validated with tests, benchmarks, or documented manual measurements.

Rationale: traffic shaping controls must respond predictably and must not add
avoidable load while operating on privileged host networking state.

## Operational Constraints

The service targets Linux hosts with `tc` available and enough privileges to
modify queuing disciplines and filters. Request input MUST be validated before
it influences command arguments. Flow definitions MUST remain explicit in
`flows.json` or a reviewed configuration source, and environment-specific
interfaces or addresses MUST NOT be hardcoded into source code.

Generated binaries, logs, and local artifacts are not source of truth. Rebuild
the server from source instead of editing compiled outputs.

## Delivery Workflow and Quality Gates

Plans MUST pass the Constitution Check before design work and again before task
generation. Each feature plan MUST document code organization, test strategy,
API behavior, and measurable performance expectations or a justified N/A.

Task lists MUST include test, validation, API consistency, and performance work
for each affected user story. Pull requests MUST list validation commands and
sample API requests or responses when behavior changes.

## Governance

This constitution supersedes conflicting project practices. Amendments require
a documented change to this file, a semantic version bump, and synchronization
of affected Spec Kit templates and runtime guidance.

Versioning policy:
- MAJOR: removes or redefines principles in a backward-incompatible way.
- MINOR: adds a principle or materially expands governance requirements.
- PATCH: clarifies wording without changing required behavior.

Compliance review is mandatory for feature plans, generated tasks, and pull
requests. Any deviation from a MUST-level rule requires a written justification
in the plan or pull request with risk, mitigation, and follow-up.

**Version**: 1.0.0 | **Ratified**: 2026-05-06 | **Last Amended**: 2026-05-06
