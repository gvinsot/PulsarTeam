With Docker Swarm on the manager host, agent execution uses a single Swarm service (for example `agent-sandbox-pool`) that maintains a pool of sandbox replicas, not one service per agent.

Flow:
1. Orchestrator ensures the pool service exists with desired replica count, image, limits, network, mounts, and secrets.
2. For each tool execution, it leases one healthy free sandbox task from the pool.
3. The action runs inside that leased sandbox container.
4. On completion, the sandbox is either reset and returned to the pool or replaced if unhealthy.
5. If demand exceeds capacity, the orchestrator scales the same service up; it scales down when idle based on policy.

So: no new container per execution by default; existing pooled sandboxes are reused, with Swarm handling placement/restarts and the orchestrator handling lease/release lifecycle.