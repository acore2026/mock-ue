# QoS Simulation Demo Brief

## Goal

Build a pure software demo that visually compares three QoS strategies for periodic image uploads in a 5G-style access and core network scenario. The purpose is not protocol accuracy at implementation level, but a clear and believable demonstration of how different resource allocation strategies affect user experience under load.

The demo should make the contrast between the three strategies immediately understandable:

- no optimization degrades quickly under contention
- standard GBR protects a fixed number of users but wastes resources once reserved
- dynamic QoS reuses the same total capacity more efficiently and supports more users with good performance

## Scenario

There are 50 simulated users.

Each user uploads one image every second.

The system classifies upload outcome by end-to-end completion latency:

- under 100 ms: good
- 100 to 200 ms: delayed
- over 200 ms: failed

The user-facing story is that image uploads represent a periodic uplink task such as camera capture or visual recognition input.

The demo should show user quality changing as load increases and as different QoS strategies are applied.

## Desired Demo Outcomes

### 1. No Optimization

This mode should support about 10 users well.

Expected visible behavior:

- the first small set of active users can complete within the good latency window
- once load grows beyond the effective capacity of the best-effort path, queueing increases
- after that point, latency deteriorates broadly across the population
- users increasingly shift from good to delayed and then failed

This mode should feel like a shared unmanaged network path where everyone competes for the same limited service and nobody is specially protected.

### 2. Standard GBR

This mode should support about 30 users well.

Expected visible behavior:

- the first 30 admitted users remain good and stable
- users beyond that point degrade
- later users do not receive the same protection because the reserved pool has already been committed
- reserved capacity stays tied to admitted sessions until the session ends, even if the user is idle between uploads

This mode should feel like a static reservation model: useful and protective, but rigid and inefficient under bursty or intermittent traffic.

### 3. Dynamic QoS

This mode should support 50 users well.

Expected visible behavior:

- all 50 users remain in the good range under the designed workload
- bandwidth is not permanently tied to a user session
- capacity is assigned temporarily when an upload is actually active
- once that upload completes, the temporary resource grant is released and can be reused by others

This mode should feel adaptive, efficient, and clearly better at handling bursty periodic demand using the same total network budget.

## Conceptual Network Mapping

The simulation should use a simplified two-path abstraction rather than deep protocol realism.

### Public / Best-Effort Path

This path represents ordinary unmanaged or weakly managed service.

Conceptually it has:

- lower priority
- limited effective bandwidth share
- higher queueing delay under load
- optional impairment effects such as packet drops or extra delay

Unoptimized users should remain on this path.

When overloaded, this path should cause increasing completion delay and eventual failures.

### Prioritized Path

This path represents optimized QoS treatment.

Conceptually it has:

- higher priority
- protection from simulated packet drops
- preferential access to shared capacity
- controlled admission or temporary assignment depending on mode

Optimized users should be placed on this path.

This path should not be treated as truly unlimited. It should still conceptually sit under the same total system capacity budget. The improvement comes from priority and smarter allocation, not from magically adding infinite bandwidth.

## Total Capacity Model

All three strategies should be presented as operating under the same overall network budget.

Use a single conceptual total capacity pool of 100 Mbit.

The difference between the strategies is not the existence of more raw capacity, but how that same capacity is allocated and reused.

This is central to the demo narrative.

## Strategy Mapping

### No Optimization Mapping

- all users stay on the public path
- no special reservation is applied
- everyone competes in shared best-effort conditions
- overload causes growing queue delay and degraded completion time for the population

### Standard GBR Mapping

- a fixed amount of total protected capacity is available within the same overall 100 Mbit budget
- the first 30 sessions are admitted into protected treatment
- once admitted, their reserved share remains associated with the session until it drains or ends
- later users remain on the public path
- the system does not reclaim reserved capacity dynamically between intermittent bursts

This should visually demonstrate the weakness of static reservation for periodic traffic.

### Dynamic QoS Mapping

- the same 100 Mbit total capacity is used
- no long-lived reservation is pinned to a user just because a session exists
- when a user actually starts an upload, the system temporarily grants prioritized treatment
- when that upload completes, the grant is released immediately
- prioritized resources are continuously reused across the user population

This should visually demonstrate efficiency gains without changing the total network budget.

## Key Behavioral Principle

For this demo, completion latency should be the main signal of success or failure.

Packet drops can exist as part of the simulation effect, especially on the public path, but they should be secondary.

The core visible story is:

- low contention leads to good completion time
- overload leads to queueing and missed deadlines
- smarter allocation keeps more users within the good latency window

## Visual Story for the UI

The UI should emphasize that different users are being treated differently by the resource policy.

Useful visual concepts include:

- each user shown with current state: good, delayed, or failed
- a visible split between public-path users and prioritized-path users
- counters showing how many users are currently protected
- a view of total capacity as a shared pool
- a distinction between static reservation and temporary dynamic grants
- visible transitions when a user is promoted to prioritized treatment and when that treatment is released

The UI should make it obvious that:

- no optimization means shared deterioration
- standard GBR means early users are protected and later ones are not
- dynamic QoS means protection is reused in time rather than permanently locked to sessions

## Messaging the Demo Should Convey

The demo should communicate these ideas clearly:

1. Best-effort service does not scale well for periodic uplink bursts.
2. Static GBR improves reliability, but only for a fixed admitted group.
3. Static reservation can waste capacity when users are not actively transmitting.
4. Dynamic QoS can support more users under the same total capacity by allocating protection only when needed.
5. The gain comes from better timing and reuse of resources, not from increasing the total bandwidth budget.

## Scope Boundaries

This is a concept demo, not a full 5G protocol implementation.

Keep the model at behavior level.

It is enough to simulate:

- users generating periodic uploads
- a shared total capacity pool
- public versus prioritized treatment
- static admission versus temporary grant reuse
- completion latency classification into good, delayed, and failed

Avoid unnecessary telecom detail unless it directly improves the clarity of the demo.

## Final Framing

The core comparison is:

- no optimization: unmanaged contention
- standard GBR: fixed protection, fixed admission ceiling
- dynamic QoS: temporary protection, better reuse, higher effective user support

The whole demo should make that contrast legible in a few seconds, even to someone who does not know the protocol background.

