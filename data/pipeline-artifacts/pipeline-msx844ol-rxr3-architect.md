## Recommendation

Implement a decoupled, role-specific memory architecture to prevent "context bloat" in the council pipeline. Instead of passing the entire conversation history to every agent, we will move to a scoped-context model where each agent reads only its relevant `role_memory.json` and writes its conclusions there. This replaces the heavy `council-conversation.json` with a lightweight, high-performance switching mechanism.

The implementation includes:
1.  **Scoped Memory Files**: New files in `data/agent_memory/` for `manager`, `architect`, `builder`, `auditor`, `critic`, `strategist`, and `trader`.
2.  **Memory Controller**: A centralized, atomic write interface to manage pruning (keep last $N$ entries) and validation.
3.  **Pipeline Test Suite**: Targeted tests for memory integrity and pipeline flow.
4.  **Exclusion**: This plan does **not** include the Bitrue start-flow fix; that is a separate operational task for the Builder.

## Build Plan

### 1. Documentation & Schema Design
- `data/changelog.md` → Add entry documenting the shift from monolithic conversation history to role-scoped memory.
- `data/agent_memory/schema.json` (conceptual) → Define the structure: `{ timestamp: string, role: string, content: string, metadata: object }`.

### 2. Memory Infrastructure (The "Memory Controller")
- `server/council.ts` → Implement `writeRoleMemory(role, content)` and `readRoleMemory(role)`.
    - **Pruning Logic**: Automatically keep only the last 10 entries per role to prevent token overflow.
    - **Atomicity**: Use temporary file writes + rename to prevent corruption during concurrent writes.
    - **Validation**: Reject any write containing sensitive patterns (secrets/keys).
- `server/agent-providers.ts` → Update agent initialization logic. Each agent must now receive its specific `role_memory.json` path during instantiation.

### 3. Pipeline & Route Updates
- `server/routes.ts` → Update the pipeline execution endpoint to handle the new memory-loading sequence (Load Role Memory $\rightarrow$ Process $\rightarrow$ Write Role Memory).
- `data/pipeline-state.json` → Update schema to track which memory files were touched during the last run.

### 4. Testing & Validation
- `server/council-memory.test.ts` (New) → Tests: Atomic write/read, pruning (ensuring 11th entry deletes 1st), and validation (rejecting bad data).
- `server/pipeline.test.ts` (New) → Dry-run end-to-end test: Manager $\rightarrow$ Architect $\rightarrow$ Builder $\rightarrow$ Auditor $\rightarrow$ Critic $\rightarrow$ Manager.

### 5. Cleanup
- `.gitignore` → Add `data/agent_memory/*.log` (if logging is enabled) and ensure local dev memory doesn't commit to production.

## Verification
- **Unit Test**: `npm test server/council-memory.test.ts` (must pass 100%).
- **Integration Test**: `npm test server/pipeline.test.ts` (must complete a full cycle without "context too large" errors).
- **Build Check**: `npm run build` (must pass TypeScript check).
- **Manual Check**: Verify `data/agent_memory/architect.json` is updated after a pipeline run.

## Risks
- **Memory Fragmentation**: If pruning logic is poorly tuned, critical context might be lost. (Mitigation: Keep last 10 entries, not 5).
- **Race Conditions**: Two agents writing to the same memory file. (Mitigation: Use atomic file swaps).
- **Orphaned Data**: Old `council-conversation.json` data might confuse agents if not properly phased out. (Mitigation: Clear the old file once the new system is verified).

## What We Keep As-Is
- **All Trading Parameters**: Leverage, Capital, Ticker, and Exchange (Bitrue/Bitunix) remain untouched.
- **Live Trading Status**: No bots will be started or stopped.
- **Core Trading Logic**: The actual math/execution engines are not part of this structural refactor.