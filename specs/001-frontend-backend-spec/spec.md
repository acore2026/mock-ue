# Feature Specification: Provisional Frontend and Backend Demo

**Feature Branch**: `001-frontend-backend-spec`  
**Created**: 2026-05-06  
**Status**: Draft  
**Input**: User description: "refer to ui/README.md, build a provisional spec for this project, frontend and backend"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Prepare a QoS Comparison Demo (Priority: P1)

An operator opens the dashboard, selects one of the available QoS strategies, and
prepares a demo session that clearly shows the planned user population, capacity
allocation, and initial status before any traffic starts.

**Why this priority**: A prepared session is the starting point for every useful
demo and gives the operator confidence that the scenario is ready.

**Independent Test**: Can be tested by preparing each strategy from a clean
state and confirming the dashboard shows the selected strategy, planned users,
capacity split, and zero active uploads.

**Acceptance Scenarios**:

1. **Given** no session exists, **When** the operator prepares a dynamic QoS
   session, **Then** the dashboard shows the selected strategy, 50 planned
   users, shared capacity, and no active run.
2. **Given** a session exists for another strategy, **When** the operator
   prepares a new strategy, **Then** the prior run state is replaced and the
   dashboard reflects the newly selected strategy.

---

### User Story 2 - Run and Observe Live User Outcomes (Priority: P1)

An operator starts the prepared session and watches user quality change as
simulated users begin periodic uploads. The dashboard updates counters, user
cards, latency trends, and treatment labels so the operator can explain what is
happening without reading logs.

**Why this priority**: The core value of the project is a visual, believable
comparison of how QoS strategy affects user experience under load.

**Independent Test**: Can be tested by starting a prepared run and confirming
that active users ramp up, upload outcomes appear, and user statuses transition
between planned, idle, running, good, delayed, or failed.

**Acceptance Scenarios**:

1. **Given** a prepared session, **When** the operator starts the run, **Then**
   the system activates an initial user group and begins showing live upload
   outcomes.
2. **Given** a run is active, **When** more users are admitted, **Then** the
   dashboard updates active counts, protected counts, temporary grants, and
   per-user treatment without requiring a page refresh.
3. **Given** uploads complete, **When** their latency is measured, **Then** each
   upload is classified as good, delayed, or failed using the demo thresholds.

---

### User Story 3 - Compare Strategy Behavior (Priority: P2)

An operator switches between no optimization, standard GBR, and dynamic QoS runs
to compare how the same overall capacity budget affects user outcomes.

**Why this priority**: The demo is useful only if the contrast between the three
strategies is legible and repeatable.

**Independent Test**: Can be tested by running all three strategies under the
same planned workload and verifying that the visible outcomes match the intended
narrative: unmanaged contention degrades earliest, static reservation protects a
fixed group, and dynamic QoS reuses protection across the population.

**Acceptance Scenarios**:

1. **Given** no optimization is selected, **When** load grows beyond the best
   effort path, **Then** the dashboard shows broad degradation across users.
2. **Given** standard GBR is selected, **When** more than the protected group is
   active, **Then** early protected users remain stable while later users are
   more likely to degrade.
3. **Given** dynamic QoS is selected, **When** users upload periodically,
   **Then** temporary prioritized treatment appears during active uploads and is
   released afterward.

---

### User Story 4 - Control and Recover the Scenario (Priority: P2)

An operator or automation client can stop, reset, inspect, and recover the demo
state when a run is complete, interrupted, or misconfigured.

**Why this priority**: The demo manipulates host networking state, so operators
need predictable controls and recoverable failure behavior.

**Independent Test**: Can be tested by stopping an active run, resetting a
prepared session, requesting state before preparation, and submitting invalid
strategy or profile values.

**Acceptance Scenarios**:

1. **Given** a run is active, **When** the operator stops it, **Then** the run
   ends and the dashboard shows a non-running state.
2. **Given** a session is prepared, **When** the operator resets it, **Then** all
   counters, user outcomes, and latency history return to the initial state for
   the selected strategy.
3. **Given** the operator submits an invalid action, **When** the system rejects
   it, **Then** the response explains what went wrong and the dashboard remains
   usable.

### Edge Cases

- State is requested before any demo session has been prepared.
- A run is started twice or stopped when no compatible run exists.
- A strategy, profile, or user reference is unknown.
- The live update connection drops and later reconnects.
- Simulated upload samples are delayed, malformed, duplicated, or missing.
- Host setup or cleanup fails before the run is ready.
- More users are requested after all planned users are already active.
- A new strategy is prepared while an existing run or scenario is still active.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a dashboard that shows current strategy,
  run state, planned users, active users, protected users, temporary grants,
  bandwidth allocation, and outcome counts.
- **FR-002**: The system MUST allow an operator to prepare a demo session for no
  optimization, standard GBR, or dynamic QoS.
- **FR-003**: The system MUST show the same total capacity budget across all
  strategies so outcome differences are explained by allocation behavior, not
  hidden capacity increases.
- **FR-004**: The system MUST allow an operator to start, stop, reset, refresh,
  and incrementally admit users for a prepared session.
- **FR-005**: The system MUST represent 50 planned users and distinguish planned,
  idle, running, good, delayed, and failed user states.
- **FR-006**: The system MUST distinguish public, reserved, and temporary grant
  treatment in the user-facing demo state.
- **FR-007**: The system MUST classify upload outcomes as good under 100 ms,
  delayed from 100 ms through 200 ms, and failed over 200 ms.
- **FR-008**: The system MUST provide current state and final reports suitable
  for both the dashboard and automation clients.
- **FR-009**: The system MUST keep the dashboard updated with live state,
  upload, and result changes while a run is active.
- **FR-010**: The system MUST recover from interrupted live updates by
  reconnecting or allowing the operator to refresh the latest state.
- **FR-011**: The system MUST reject invalid strategies, profiles, malformed
  requests, impossible lifecycle actions, and unknown users without corrupting
  the active session.
- **FR-012**: The system MUST cleanly stop active workloads and release scenario
  state when an operator stops, resets, or replaces a session.
- **FR-UX-001**: Control-surface changes MUST preserve stable field names,
  predictable status outcomes, and actionable error messages for operators and
  scripts.
- **FR-PERF-001**: User-visible state changes during an active run MUST appear
  quickly enough for the demo narrative to feel live.

### Key Entities *(include if feature involves data)*

- **QoS Strategy**: The selected allocation policy being demonstrated: no
  optimization, standard GBR, or dynamic QoS.
- **Demo Session**: A prepared scenario with selected strategy, capacity budget,
  planned users, admission behavior, and run state.
- **Simulated User**: A demo participant with identity, network treatment,
  activity state, upload attempts, latest latency, and outcome status.
- **Bandwidth Allocation**: The shared total capacity and its public versus
  optimized portions for the selected strategy.
- **Upload Sample**: A measured upload attempt with success, latency, byte
  count, attempt number, timestamp, and optional error.
- **Run Report**: Aggregate and per-user results that summarize run status,
  latency, success, failures, and protected user counts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new operator can prepare and start a demo run in under 2 minutes
  using only visible controls.
- **SC-002**: During a run, 95% of visible state changes appear on the dashboard
  within 2 seconds of the underlying event.
- **SC-003**: The dashboard can display all 50 planned users without requiring
  navigation away from the primary demo view.
- **SC-004**: In the designed workload, no optimization visibly supports about
  10 users well, standard GBR supports about 30 users well, and dynamic QoS
  supports about 50 users well.
- **SC-005**: At least 90% of non-technical viewers can correctly identify the
  best-performing strategy after watching one complete comparison.
- **SC-006**: Invalid or out-of-order user actions produce a clear explanation
  and leave the prior valid scenario state intact in all tested cases.
- **SC-CONTROL-001**: Automation clients can prepare, start, inspect, stop, and
  reset a scenario using documented inputs and outputs.
- **SC-PERF-001**: Filtering, sorting, and reviewing user outcome data remains
  responsive while all 50 planned users are shown.

## Assumptions

- The existing UI README is tooling-oriented, so this provisional spec derives
  product behavior from the current dashboard, backend control flow, and demo
  brief in the repository.
- The primary audience is an operator or demo presenter running the project in a
  trusted local or lab environment.
- Authentication and multi-tenant permissions are outside the provisional scope.
- The scenario remains a concept demo and does not attempt full protocol
  fidelity.
- The frontend and backend are treated as one product: a browser dashboard plus
  a control service for scenario lifecycle, live state, and reports.
