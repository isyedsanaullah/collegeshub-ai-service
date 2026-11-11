# Collegeshub AI Service — Architecture Specification

## 1. System Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                        COLLEGESHUB FRONTEND (Next.js)                   │
│   • Student AI Tutor Chat     • Quiz & Assignment Generator            │
│   • Teacher Assistant         • Document RAG & PDF Search              │
│   • College Admin AI Wallet   • Super Admin AI Control Panel           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS (Bearer User-JWT)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        MAIN BACKEND (Express.js)                        │
│   • Auth Verification (JWT, 2FA, session epoch check)                  │
│   • Tenant Isolation & College Resolution (`tenantContext.js`)          │
│   • Subscription & Plan Feature Gates (`loadEntitlements.js`)          │
│   • Payment Intake & Proof Verification (`settlementService.js`)       │
│   • Generates Short-Lived S2S Signed Assertion (HMAC-SHA256, 60s)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ S2S Assertion (X-Collegeshub-Assertion)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   COLLEGESHUB AI SERVICE (TypeScript)                  │
│                                                                        │
│  ┌───────────────────────┐  ┌───────────────────────────────────────┐  │
│  │   AI Gateway & Proxy  │  │    Provider & Model Registry          │  │
│  │   • Assertion Verify  │  │    • AES-256-GCM Credential Vault     │  │
│  │   • Nonce Replay Check│  │    • Dynamic Route Optimization       │  │
│  │   • Quota & Rate Limit│  │    • Failover Circuit Breakers        │  │
│  └───────────┬───────────┘  └───────────────────┬───────────────────┘  │
│              │                                  │                      │
│              ▼                                  ▼                      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │              Two-Phase Financial Execution Engine                │  │
│  │  1. Pre-flight Reservation (Hold estimated tokens with row lock) │  │
│  │  2. Provider Invocation (Streaming SSE / Completion)              │  │
│  │  3. Post-execution Settlement (FEFO deduction & refund unused)   │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│              ┌──────────────────────┴──────────────────────┐           │
│              ▼                                             ▼           │
│  ┌───────────────────────┐                     ┌────────────────────┐  │
│  │  RAG & Vector Memory  │                     │  BullMQ Workers    │  │
│  │  • Cloudflare R2 PDFs │                     │  • PDF Extraction  │  │
│  │  • Chunking & Parsing │                     │  • Vector Indexing │  │
│  │  • pgvector Embedding │                     │  • Reconciliation  │  │
│  └───────────────────────┘                     └────────────────────┘  │
└──────────────────────────────┬─────────────────────────────┬───────────┘
                               │                             │
                               ▼                             ▼
                ┌──────────────────────────────┐     ┌──────────────┐
                │ Neon PostgreSQL (AI Service) │     │ Redis Cluster│
                │ • CollegeAIWallet            │     │ • Nonces     │
                │ • AICreditGrant (FEFO)       │     │ • Rate Limits│
                │ • AICreditLedgerEntry        │     │ • Job Queues │
                │ • AIRequestLog               │     │ • Fast Cache │
                │ • pgvector Embeddings        │     └──────────────┘
                └──────────────────────────────┘
```

## 2. Core Entities & Financial Flow

### 2.1 First-Expiring, First-Out (FEFO) Grant Consumption
When a request consumes credits:
1. Query active grants for `collegeId` with `remainingAmount > 0`.
2. Order by `expiresAt ASC NULLS LAST` (expiring monthly subscription credits are consumed before non-expiring purchased add-on credits).
3. Atomically decrement each grant until the debit total is met.
4. Record an immutable `AICreditLedgerEntry`.

### 2.2 Replay-Safe Service-to-Service Assertion
Every internal request carries:
- `sub`: Authenticated User ID
- `collegeId`: Tenant ID
- `role`: User Role (student, teacher, admin, superAdmin)
- `planId`: Active Subscription Plan
- `jti`: Random UUID nonce
- `exp`: Max 60 seconds from issuance

The AI service verifies signature and stores `jti` in Redis with TTL 60s. Any duplicate `jti` is rejected with `401 REPLAY_DETECTED`.
