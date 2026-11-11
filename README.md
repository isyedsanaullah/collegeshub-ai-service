# Collegeshub AI Service (`collegeshub-ai-service`)

Centralized, independently deployed AI microservice for the Collegeshub multi-tenant educational SaaS platform.

---

## 1. System Mission & Boundary of Authority

This service operates as the dedicated intelligence, vector memory, and financial accounting backend for Collegeshub:

| Responsibility | Main Backend (`academix_backend`) | AI Microservice (`collegeshub-ai-service`) |
|---|---|---|
| **User Identity & 2FA** | **Owner** (JWT issuer, sessions) | Reads verified claims from S2S assertion |
| **College & Tenant Lifecycle** | **Owner** (College creation, status) | Receives tenant ID via assertion & outbox |
| **RBAC & Memberships** | **Owner** (Roles, permissions) | Enforces AI-specific role quotas |
| **Subscription Billing** | **Owner** (Stripe/Bank, plan limits) | Synchronizes monthly plan allocations |
| **Payment Slip Verification** | **Owner** (Evidence verification) | Receives approval signal to mint credits |
| **AI Provider Management** | No access to provider keys | **Owner** (AES-256-GCM vault, key rotation) |
| **Model Registry & Pricing** | No | **Owner** (Versioned input/output token pricing) |
| **Dynamic Model Routing** | No | **Owner** (Least-cost capable model selection) |
| **AI Request Execution** | No direct LLM calls | **Owner** (Streaming SSE, completions, tools) |
| **Credit Wallet & Ledger** | No direct wallet edits | **Owner** (Atomic reserve/settle, FEFO grants) |
| **Document Intelligence** | S3/R2 upload bridge | **Owner** (Extraction, chunking, pgvector RAG) |
| **Background Processing** | No | **Owner** (BullMQ queues, worker threads) |
| **AI Financial Accounting** | Receives billing summaries | **Owner** (Usage telemetry, gross margins) |

---

## 2. Technology Stack

- **Runtime:** Node.js 20+ / TypeScript (Strict Mode)
- **Framework:** Express.js with custom middleware (Pino structured logging, correlation IDs)
- **Database:** Neon PostgreSQL with `pgvector` extension
- **ORM:** Prisma ORM with `@prisma/adapter-pg` connection pool
- **Queues & Caching:** Redis 7+ & BullMQ for background vector indexing and rate limits
- **Document Storage:** Cloudflare R2 (S3-compatible API via `@aws-sdk/client-s3`)
- **LLM Integrations:** Google Gemini (`@google/generative-ai`), OpenAI (`openai`), OpenRouter

---

## 3. Server-to-Server (S2S) Security Protocol

No public client or browser ever connects directly to `collegeshub-ai-service`. All traffic originates from the Main Backend via signed internal assertions:

1. **Assertion:** Short-lived HMAC-SHA256 or Asymmetric JWT signed with `INTERNAL_SERVICE_SECRET`.
2. **Lifetime:** Strictly $\le 60\text{ seconds}$ (`exp`).
3. **Replay Prevention:** Every request carries a unique `jti` (nonce) checked against an ephemeral Redis set.
4. **Header:** Transmitted via `X-Collegeshub-Assertion: <token>`.
5. **Zero Trust:** Client-supplied tenant IDs or user IDs are strictly ignored; the assertion is the sole source of truth.

---

## 4. Local Development Setup

### Prerequisites
- Node.js 20+
- Redis (local or remote)
- Neon PostgreSQL instance with `vector` extension enabled

### Setup Steps
```bash
# 1. Clone repository
git clone <repository-url>
cd collegeshub-ai-service

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env with your local credentials

# 4. Generate Prisma Client & push schema
npm run prisma:generate
npm run prisma:push

# 5. Start development server
npm run dev
```

---

## 5. Deployment Architecture (Render)

This service is deployed independently as a Dockerized web service or Node.js web service on Render:

- **Build Command:** `npm install && npx prisma generate && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/health/readiness`
- **Port:** Configured via `PORT` (default `10001`)

---

## 6. Financial Integrity Principles

1. **Integer Accounting:** All credit balances, grant amounts, and reservations are stored as 64-bit integers (1 credit = $0.000001 USD). Floating-point arithmetic is prohibited.
2. **Two-Phase Reserve & Settle:** Requests reserve maximum token cost before provider invocation. On completion, exact provider usage is settled and unused reserved credits are refunded.
3. **FEFO Allocation:** Expiring monthly subscription credits are consumed before non-expiring purchased add-on credits.
4. **Immutable Ledger:** Direct balance mutations are forbidden. Every balance shift requires an immutable `AICreditLedgerEntry`.

