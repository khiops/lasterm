# Codebase Audit: lasterm

**Date:** 2026-03-18
**Mode:** full
**Scope:** full codebase (5 packages + root)

---

## Executive Summary

| Dimension | Score | Status |
|-----------|-------|--------|
| Architecture | 8/10 | 🟢 |
| Code Quality | 6/10 | 🟡 |
| Principle Compliance | 6/10 | 🟡 |
| Documentation | 4/10 | 🔴 |
| Test Coverage | 8/10 | 🟢 |

**Overall Health:** 🟡 Needs Attention

The architecture is clean (correct dependency direction, clear separation of concerns between packages), and test coverage is strong (2031 tests, 92 test files). However, several god classes (SessionManager, MetaDAL, useLayout) need decomposition, documentation has drifted significantly from code, and two security issues require immediate attention.

---

## Key Findings (Top 5 by Priority Score)

| # | Finding | C | I | R | Score | Axis |
|---|---------|---|---|---|-------|------|
| 1 | **CORS `origin: true` + `credentials: true` allows any website to make authenticated requests** | C1 | I4 | R3 | 12.0 | Security |
| 2 | **SSH host key verification disabled (MITM possible)** | C2 | I4 | R3 | 6.0 | Security |
| 3 | **README.md does not exist** | C1 | I3 | R2 | 6.0 | Documentation |
| 4 | **PROTOCOL.md documents ~30% of actual REST routes** | C3 | I3 | R2 | 2.0 | Documentation |
| 5 | **sea-addon-loader.ts fully duplicated between agent and hub** | C2 | I2 | R2 | 2.0 | DRY |

---

## Metrics

| Metric | Value |
|--------|-------|
| Source files | 276 |
| Lines of code | ~75,000 |
| Test files | 92 |
| Tests | 2,031 |
| API routes | 52 |
| Dependencies | ~30 direct (pnpm catalog) |
| TODO/FIXME count | 0 (cleaned pre-audit) |

---

## Quick Stats by Area

| Area | Files | Issues | Health |
|------|-------|--------|--------|
| packages/shared | ~20 | 1 (circular import) | 🟢 |
| packages/agent | ~15 | 1 (DRY: sea-addon-loader) | 🟢 |
| packages/hub | ~40 | 18 (SRP, DRY, Security) | 🟡 |
| packages/clients/web | ~50 | 6 (SRP, Complexity) | 🟡 |
| packages/clients/desktop | ~5 | 0 | 🟢 |
| docs/ | 15 | 10 (drift) | 🔴 |

---

## Recommendations

### Immediate (P0)
- Restrict CORS origins to explicit allowlist (`server.ts:45`)
- Add SSH host key verification (at minimum TOFU with persistence)
- Create README.md

### Short-term (P1)
- Update PROTOCOL.md: add missing WS messages and REST routes
- Update SPEC.md entity model (Host, Channel, LaunchProfile)
- Extract sea-addon-loader to @lasterm/shared
- Fix error response format inconsistency in pair.ts and wallpapers.ts

### Medium-term (P2-P3)
- Decompose SessionManager into sub-managers
- Split MetaDAL into domain-specific DALs
- Extract useLayout into smaller composables
- Add pagination to list API endpoints
