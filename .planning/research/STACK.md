# Stack Research

**Domain:** AI-powered Swedish real estate analysis (web scraping + PDF parsing + LLM analysis)
**Researched:** 2026-02-24
**Confidence:** MEDIUM-HIGH

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| **Next.js** | 16.x (latest 16.1.6) | Frontend + BFF (API routes for Stripe) | Default for React in 2026. Turbopack stable, opt-in caching model fixes App Router pain. TypeScript-first, Tailwind built in. Vercel deployment = zero-ops. | HIGH |
| **Python** | 3.13 | Backend runtime | FastAPI requires >=3.10. 3.13 is current stable with best ecosystem support. Avoid 3.14 (too new, library compat risk). | HIGH |
| **FastAPI** | 0.133.x | Backend API server | Async-first, auto-generated OpenAPI docs, Pydantic v2 integration for data validation. Standard for Python APIs in 2026. Handles scraping orchestration, PDF parsing, AI calls. | HIGH |
| **Supabase** | Hosted (latest) | Database + Auth + Storage | PostgreSQL under the hood. PostgREST v14 for fast queries. Built-in auth (email/password sufficient for MVP). File storage for uploaded PDFs. Row Level Security for user data isolation. Free tier generous for MVP. | HIGH |
| **Claude API** | Anthropic SDK 0.83.x | AI analysis engine | Handles Swedish well, structured output via tool use, 200k context for long arsredovisningar. No ML infra needed. Direct API via Python SDK. | HIGH |
| **Apify** | Hosted platform | Web scraping (Booli) | Pre-built Booli.se scraper exists on Apify Store (lexis-solutions/booli-se-scraper). Pay-per-use, no infra to manage. Proxy rotation and anti-bot handled. Critical for a solo dev: don't build scraping infra. | HIGH |

### Frontend Libraries

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| **Tailwind CSS** | 4.2.x | Styling | v4 is a ground-up rewrite. CSS-first config, faster builds. Default in Next.js 16 scaffolding. |
| **shadcn/ui** | latest (copy-paste, not versioned) | UI components | Not a dependency -- copies source into your project. Radix primitives + Tailwind. De facto standard for Next.js apps in 2026. |
| **@supabase/supabase-js** | 2.97.x | Frontend Supabase client | Auth flows, real-time subscriptions if needed later. Isomorphic (works in SSR + client). |
| **@supabase/ssr** | latest | Next.js server-side Supabase | Cookie-based auth for App Router server components. Required for SSR auth. |
| **@stripe/stripe-js** | latest | Stripe frontend | Embedded Checkout (iframe on your domain, not redirect). PCI compliance offloaded. Always loads latest Stripe.js at runtime regardless of package version. |
| **@stripe/react-stripe-js** | latest | React Stripe components | Official React bindings for Elements/Checkout. |

### Backend Libraries (Python)

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| **anthropic** | 0.83.x | Claude API client | Official Anthropic Python SDK. Async support, streaming, tool use for structured output. |
| **supabase** (Python) | 2.28.x | Backend Supabase client | CRUD operations, storage uploads, auth verification from FastAPI. |
| **pymupdf4llm** | 0.3.4 | PDF parsing (arsredovisningar) | Purpose-built for LLM consumption. Converts PDF to Markdown with table detection. Fast (0.12s extraction). Production-stable. Best option for feeding PDF content to Claude. |
| **stripe** (Python) | 14.3.x | Payment processing | Server-side Stripe operations. Checkout session creation, webhook handling. API version 2026-01-28. |
| **apify-client** | latest | Apify API client | Trigger Booli scraper runs, fetch results. Official Python client. |
| **pydantic** | 2.x (bundled with FastAPI) | Data validation | FastAPI uses Pydantic v2 natively. Define request/response schemas. Also used for structuring Claude output schemas. |
| **uvicorn** | latest | ASGI server | Standard FastAPI production server. Use with `--workers` for multi-process. |
| **httpx** | latest | HTTP client | Async HTTP requests to SCB, BRA, Skolverket APIs. Replaces requests for async FastAPI. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **uv** | Python package manager | 10-100x faster than pip. Replaces pip, virtualenv, pyenv. Default for new Python projects in 2026. Use `uv init`, `uv add`, `uv run`. |
| **pnpm** | Node package manager | Faster and more disk-efficient than npm. Standard for Next.js projects. |
| **Docker** | Containerization (backend) | FastAPI backend in Docker for consistent deployment. Not needed for Next.js (Vercel handles it). |
| **ESLint + Prettier** | Frontend linting/formatting | Included in Next.js 16 scaffolding. |
| **Ruff** | Python linting/formatting | Replaces flake8, black, isort. Written in Rust, extremely fast. Standard for Python in 2026. |
| **pytest** | Python testing | Standard. Use with pytest-asyncio for async FastAPI tests. |

### Infrastructure

| Technology | Purpose | Why | Monthly Cost (MVP) |
|------------|---------|-----|--------------------|
| **Vercel** | Frontend hosting | Zero-config Next.js deployment. Free tier: 100GB bandwidth, 100k function invocations. Git push to deploy. | $0 (Hobby) |
| **Railway** | Backend hosting (FastAPI) | One-click FastAPI deployment. $5/mo Hobby plan includes $5 credits. Scales well. Docker support. Simple env var management. | ~$5-10 |
| **Supabase** | Database + Auth + Storage | Free tier: 500MB database, 1GB storage, 50k monthly active users. More than enough for MVP. | $0 (Free) |
| **Apify** | Scraping compute | Free tier: $5/mo credits. Per-analysis Booli scrape ~$0.01-0.05. Low volume at start. | ~$5 |
| **Anthropic** | Claude API | Pay per token. Claude Sonnet 4.6 for analysis. ~$0.03-0.10 per analysis depending on report length + arsredovisning size. | ~$5-20 (usage) |
| **Stripe** | Payments | 1.5% + SEK 1.80 per transaction (Swedish pricing). No monthly fee. | $0 + tx fees |

**Total estimated MVP infra cost: $15-40/month** (well within $100 constraint)

## Architecture Decision: Why Two Services (Not Monolith)

**Next.js frontend + FastAPI backend** instead of a Next.js monolith because:

1. **Python ecosystem for AI/scraping**: pymupdf4llm, anthropic SDK, apify-client, httpx for Swedish APIs -- all Python. Wrapping these in Node.js adds complexity for no benefit.
2. **Long-running operations**: Scraping + PDF parsing + Claude analysis takes 10-30 seconds. FastAPI handles this with async workers. Next.js serverless functions have timeout limits (10s on Vercel Hobby, 60s on Pro).
3. **Cost**: Vercel serverless charges per invocation. Heavy compute (PDF parsing, API orchestration) is cheaper on Railway's always-on container.
4. **Separation of concerns**: Frontend handles UI, auth flows, Stripe checkout. Backend handles data pipeline (scrape -> parse -> analyze -> store).

**Communication**: Next.js frontend calls FastAPI backend via REST. Supabase sits between both (frontend writes user data, backend writes analysis results). Auth tokens passed from frontend to backend for user identification.

## Installation

### Frontend (Next.js)

```bash
# Scaffold
pnpm create next-app@latest bostad-ai --typescript --tailwind --eslint --app --src-dir

# Core dependencies
pnpm add @supabase/supabase-js @supabase/ssr @stripe/stripe-js @stripe/react-stripe-js

# UI components (run per-component as needed)
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button card input dialog

# Dev
pnpm add -D @types/node
```

### Backend (Python/FastAPI)

```bash
# Initialize with uv
uv init bostad-ai-api
cd bostad-ai-api

# Core
uv add fastapi uvicorn[standard] anthropic supabase pymupdf4llm stripe apify-client httpx pydantic-settings python-multipart

# Dev
uv add --dev pytest pytest-asyncio ruff
```

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| **Frontend framework** | Next.js 16 | Remix / SvelteKit | Next.js has largest ecosystem, best Vercel integration, most shadcn/UI component libraries. Remix is good but smaller community. SvelteKit excellent DX but Swedish real estate niche means less community help. |
| **Backend framework** | FastAPI | Django / Flask | Django too heavy for an API-only backend (ORM unnecessary with Supabase). Flask lacks async natively and type hints. FastAPI is the sweet spot: async + typed + auto-docs. |
| **Database** | Supabase (PostgreSQL) | PlanetScale / Neon / raw PostgreSQL | Supabase bundles auth + storage + database. For a solo dev, this eliminates 3 separate services. PlanetScale dropped free tier. Neon is good but lacks integrated auth/storage. |
| **AI provider** | Claude (Anthropic) | OpenAI GPT-4o / Gemini | Claude handles Swedish better in testing. Structured output via tool use works well. Anthropic pricing competitive. Project already committed to Claude. OpenAI is a fine fallback. |
| **Scraping** | Apify (managed) | Crawlee (self-hosted) / Scrapy | Solo dev constraint. Apify handles proxy rotation, anti-bot, scheduling, retries. Pre-built Booli scraper exists. Self-hosting scraping infra is a maintenance burden. Crawlee is Apify's own open-source lib -- use it if you outgrow managed Apify. |
| **PDF parsing** | pymupdf4llm | pdfplumber / unstructured.io | pymupdf4llm is purpose-built for LLM consumption. Outputs Markdown directly. Table detection included. pdfplumber is good for tables but requires more post-processing for LLM input. Unstructured.io is heavier than needed. |
| **Package manager (Python)** | uv | Poetry / pip | uv is 10-100x faster, replaces multiple tools. Poetry is mature but slower. pip alone lacks dependency resolution and virtual env management. uv is the 2026 default for new projects. |
| **Backend hosting** | Railway | Render / Fly.io / AWS Lambda | Railway has simplest FastAPI deployment + fair pricing. Render free tier sleeps (bad UX for first request). Fly.io more complex config. Lambda cold starts + 15min timeout limit. |
| **Frontend hosting** | Vercel | Netlify / Cloudflare Pages | Vercel is built by Next.js team. Best integration, zero config. Netlify good but Next.js support lags. Cloudflare Pages improving but not yet on par for Next.js 16. |
| **Payments** | Stripe | Klarna / Swish | Stripe supports SEK, has Embedded Checkout (2026 best practice), excellent SDK. Klarna is buy-now-pay-later (wrong model). Swish is Sweden-only mobile payments -- consider adding later as payment method within Stripe. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **LangChain** | Massive over-abstraction for this use case. You're making direct Claude API calls with structured prompts, not building an agent framework. LangChain adds complexity, debug difficulty, and version churn. | Direct Anthropic SDK (`anthropic` package). Use Pydantic models for structured output schemas. |
| **Prisma (in Next.js)** | Supabase already provides a database client. Adding Prisma means two data access layers, schema sync issues, and unnecessary complexity. | `@supabase/supabase-js` for frontend, `supabase` Python client for backend. |
| **BeautifulSoup / Scrapy (self-hosted)** | Solo dev building scraping infrastructure = maintenance burden. Anti-bot, proxy rotation, retries, scheduling -- all solved problems on Apify. | Apify managed platform with pre-built Booli scraper. |
| **MongoDB / Firebase** | Relational data (users -> analyses -> listings -> BRF data) is inherently relational. MongoDB adds impedance mismatch. Firebase locks you into Google ecosystem without PostgreSQL's power. | Supabase (PostgreSQL). |
| **Celery** | Overkill for MVP. You need async background jobs, not a distributed task queue. FastAPI's `BackgroundTasks` or a simple queue handles the analysis pipeline. | FastAPI `BackgroundTasks` for fire-and-forget. If you need job status tracking later, consider `arq` (Redis-backed, lightweight). |
| **NextAuth.js** | Supabase Auth handles authentication. Adding NextAuth means two auth systems. Supabase Auth provides email/password, magic link, and JWT -- everything MVP needs. | Supabase Auth (via `@supabase/ssr` for Next.js). |
| **Tailwind v3** | v4 is stable and is the default in Next.js 16. v3 is legacy. Don't start a new project on an old version. | Tailwind CSS v4.2.x. |
| **Custom ML models** | Building price prediction or BRF scoring models = months of work, needs training data. Claude's reasoning substitutes for statistical models in v1. | Claude API with well-crafted prompts. Revisit custom models when you have data and revenue. |

## Stack Patterns

**If scraping becomes unreliable (Booli blocks/changes):**
- Migrate from Apify managed actor to Crawlee Python self-hosted
- Add residential proxies (Apify proxy or Bright Data)
- Implement request caching (cache scraped listings in Supabase for 24h)

**If analysis takes too long (>30s):**
- Split into async job: return job ID immediately, poll for completion
- Use Supabase Realtime to push completion notification to frontend
- Consider Claude Haiku for faster (cheaper) initial analysis, Sonnet for deep analysis

**If you need to scale beyond Vercel Hobby:**
- Vercel Pro ($20/mo) gives 60s function timeout and more bandwidth
- Railway Pro ($20/mo) gives more compute
- Supabase Pro ($25/mo) gives 8GB database, daily backups

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| Next.js 16.x | React 19.2, Tailwind 4.x | React 19.2 features (View Transitions, useEffectEvent) available |
| FastAPI 0.133.x | Python 3.10-3.14, Pydantic 2.x | Pydantic v2 is required (v1 no longer supported) |
| Supabase JS 2.97.x | Next.js 16.x | Use `@supabase/ssr` for App Router server components |
| Supabase Python 2.28.x | Python 3.9+ | Works with FastAPI's async patterns |
| anthropic 0.83.x | Python 3.9+ | Async client available: `AsyncAnthropic()` |
| pymupdf4llm 0.3.4 | Python 3.9+ | Depends on PyMuPDF (installed automatically) |
| Tailwind 4.2.x | Next.js 16.x | CSS-first config (no more tailwind.config.js in v4) |

## Key API Constraints

### SCB (Statistics Sweden) API
- **Rate limit**: Max 10 requests per 10 seconds per IP
- **Data limit**: Max 100,000 values per query
- **API version**: PxWebApi 2.0 (launched October 2025, new version)
- **Auth**: None required (open data, free to use)
- **Format**: JSON-stat2 response format

### Apify
- **Free tier**: $5/month in credits
- **Booli scraper**: `lexis-solutions/booli-se-scraper` on Apify Store
- **Run cost**: ~$0.01-0.05 per scrape depending on complexity
- **Output**: JSON with listing data

### Claude API (Anthropic)
- **Context window**: 200k tokens (Sonnet 4.6)
- **Rate limits**: Varies by tier (free tier: 5 RPM, paid: higher)
- **Pricing**: Input ~$3/M tokens, Output ~$15/M tokens (Sonnet 4.6)
- **Structured output**: Use tool use / tool calling with Pydantic schemas

## Sources

- [Next.js 16 Blog Post](https://nextjs.org/blog/next-16) -- Next.js 16 features, Turbopack stable, cache components (HIGH confidence)
- [FastAPI PyPI](https://pypi.org/project/fastapi/) -- Version 0.133.0, Python >=3.10 (HIGH confidence)
- [Anthropic Python SDK PyPI](https://pypi.org/project/anthropic/) -- Version 0.83.0 (HIGH confidence)
- [Supabase Changelog](https://supabase.com/changelog) -- PostgREST v14, Python type gen (HIGH confidence)
- [Supabase Python PyPI](https://pypi.org/project/supabase/) -- Version 2.28.0 (HIGH confidence)
- [pymupdf4llm PyPI](https://pypi.org/project/pymupdf4llm/) -- Version 0.3.4 (HIGH confidence)
- [Stripe Python PyPI](https://pypi.org/project/stripe/) -- Version 14.3.0 (HIGH confidence)
- [Tailwind CSS v4.2 Release](https://tailwindcss.com/blog) -- v4.2.0 with webpack plugin (HIGH confidence)
- [Apify Booli Scraper](https://apify.com/lexis-solutions/booli-se-scraper) -- Pre-built Booli.se scraper (HIGH confidence)
- [SCB Open Data API](https://www.scb.se/en/services/open-data-api/pxwebapi/) -- PxWebApi 2.0, rate limits (HIGH confidence)
- [Railway Pricing](https://railway.com/pricing) -- Hobby $5/mo (MEDIUM confidence, pricing may change)
- [Vercel Pricing](https://vercel.com/pricing) -- Free tier limits (MEDIUM confidence, pricing may change)
- [shadcn/ui Changelog](https://ui.shadcn.com/docs/changelog) -- RTL support, visual builder (HIGH confidence)
- [uv package manager](https://github.com/astral-sh/uv) -- 10-100x faster than pip, replaces multiple tools (HIGH confidence via multiple sources)

---
*Stack research for: Bostad AI -- AI-powered Swedish real estate analysis*
*Researched: 2026-02-24*
