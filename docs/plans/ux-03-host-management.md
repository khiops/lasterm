---
doc-meta:
  status: canonical
  scope: web, hub, shared
  type: specification
  target_project: /mnt/wsl/shared/dev/lasterm
  created: 2026-03-07
  updated: 2026-03-07
  complexity: COMPLEX
  time-budget: 8h
  adversarial_applied: true
  llm_spec_applied: true
---

# Specification: UX-03 Host Management

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | web, hub, shared |
| Complexity | COMPLEX |
| Time budget | 8h |
| Blocks | 7 |
| BDD scenarios | 30 |
| Risk level | MEDIUM |

## 1. Problem Statement

Users cannot manage SSH hosts from the UI — no add/edit/delete modal, no SSH config import, no host grouping, no visual host rail with status indicators. All host management currently requires API calls. This story delivers full CRUD UI, SSH config import, host groups, DnD reorder, context menus, tooltips, and the host rail component.

## 2. User Stories

### US-01: Host CRUD
AS A lasterm user
I WANT to add, edit, and delete SSH hosts through a modal dialog
SO THAT I can manage my server connections without leaving the UI

ACCEPTANCE: Modal with all SSH fields, validation, inline test connection feedback

### US-02: SSH Config Import
AS A user with many servers in ~/.ssh/config
I WANT to import hosts from my SSH config file
SO THAT I don't have to re-enter connection details manually

ACCEPTANCE: Parse SSH config, smart filter (skip git hosts), batch import with preview

### US-03: Host Organization
AS A user with many hosts
I WANT to organize hosts into collapsible groups and reorder them
SO THAT I can quickly find the right server

ACCEPTANCE: Groups in host rail, DnD reorder, context menus, tooltips with connection info

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: Local host is always first in the rail, always visible, never deletable
- INV-02: Host labels are unique (case-insensitive), 1-64 chars, matching /^[a-zA-Z0-9._-]{1,64}$/. Dots allowed (SSH aliases commonly use them, e.g. "web.prod.example").
- INV-03: SSH passwords and key passphrases are NEVER stored — prompted at each connection
- INV-04: Key file paths are stored, contents are NOT stored — read at connect time
- INV-05: Hosts with host_group=NULL appear in an "Ungrouped" section at the bottom
- INV-06: sort_order is a dense integer sequence per group (0, 1, 2, ...)
- INV-07: Local host context menu is restricted: no Delete, Disconnect, Duplicate, Move to Group
- INV-08: PUT /api/hosts/reorder receives a group scope and ordered list of host IDs within that group. Body: `{ group: string | null, hostIds: string[] }`. sort_order is reassigned as 0..N from array position within the specified group. Consistent with INV-06 (per-group dense sequence).
- INV-09: GET /api/ssh-config ALWAYS reads from ~/.ssh/config (hardcoded path, no path parameter). Requires authentication.
- INV-10: Group names must be 1-32 characters, matching /^[a-zA-Z0-9 _-]{1,32}$/. Server validates on creation and rename.
- INV-11: Test connection is rate-limited to 5 attempts per minute per authenticated client.

### 3.2 Preconditions (required before action)

- PRE-01: Delete host with active sessions requires typing host name to confirm
- PRE-02: Delete host with no sessions/channels requires simple confirm button
- PRE-03: SSH host fields (hostname, port, auth method) are required for type="ssh"
- PRE-04: Test connection requires at least hostname + auth method configured
- PRE-05: Batch import requires at least 1 host selected

### 3.3 Effects (what changes)

- EFF-01: Create host → new row in hosts table, host appears in rail
- EFF-02: Edit host → update row, UI reflects changes immediately (optimistic)
- EFF-03: Delete host → disconnect active sessions, remove row, purge channels based on retention
- EFF-04: DnD reorder → update sort_order for affected hosts, persist immediately
- EFF-05: Move to group → update host_group, adjust sort_order in target group
- EFF-06: Import from SSH config → create N hosts in batch, each with ssh_config_host set
- EFF-07: Duplicate host → create clone with label suffixed "-copy". If "host-copy" exists, try "host-copy-2", "host-copy-3", etc.
- EFF-08: Delete group → set host_group=NULL for all hosts in group (move to ungrouped). Sessions and channels are NOT affected.

### 3.4 Error Handling

- ERR-01: Duplicate label → 409 CONFLICT, show inline validation error
- ERR-02: SSH config parse failure → show error with file path, suggest manual entry
- ERR-03: Test connection timeout (10s) → show "Timeout after 10s" inline
- ERR-04: Test connection auth failure → show "Auth failed (key rejected)" inline
- ERR-05: Test connection refused → show "Connection refused (port N)" inline
- ERR-06: Key path validation at host creation is format-only. File existence checked only at connect/test time. Show "Key file not found: /path" inline at connect/test.
- ERR-08: Batch import with label conflict → 409 with list of conflicting labels. No hosts created (atomic transaction).
- ERR-09: SSH config with Include directives → show warning banner in import dialog.
- ERR-10: Invalid group name → 400 VALIDATION_ERROR.

## 4. Technical Design

### 4.1 Architecture Decision

Extend existing host CRUD with new columns + new endpoints. No new tables — groups are implicit from the hosts.host_group column. SSH config parsing uses manual parser (not ssh2-config dependency — too heavy for simple parsing). Host rail is a new Vue component replacing the current minimal host list.

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| hosts | Add host_group TEXT | Yes (ALTER TABLE) |
| hosts | Add sort_order INTEGER DEFAULT 0 | Yes (backfill existing rows with dense sequence per group using rowid order) |
| hosts | Add ssh_config_host TEXT | Yes |
| hosts | Add ssh_user TEXT DEFAULT NULL | Yes |
| hosts | Add keep_alive_seconds INTEGER DEFAULT 60 | Yes |
| hosts | Add history_retention_days INTEGER DEFAULT 30 | Yes |

Note: icon_type, icon_value, color already exist in hosts table.

### 4.3 API Contract

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| /api/hosts | GET | — | Host[] (with new fields) |
| /api/hosts | POST | CreateHostBody (extended) | Host (201) |
| /api/hosts/:id | PUT | UpdateHostBody (extended) | Host (200) |
| /api/hosts/:id | DELETE | ?purge=true (query) | 204 |
| /api/hosts/:id/test | POST | — | { ok, latencyMs?, serverVersion?, error? } |
| /api/hosts/:id/duplicate | POST | — | Host (201) |
| /api/hosts/reorder | PUT | { group: string\|null, hostIds: string[] } | 204 |
| /api/hosts/groups/:name | PUT | { name: string } | 204 |
| /api/hosts/groups/:name | DELETE | — | 204 |
| /api/ssh-config | GET | — | SshConfigEntry[] |
| /api/hosts/import | POST | { entries: SshConfigImport[] } | Host[] (201) |
| /api/hosts/test | POST | { hostname, port, sshAuth, sshKeyPath? } | TestConnectionResult |

### 4.4 Type Definitions (shared)

```typescript
// Extend existing Host type
interface Host {
  // ... existing fields ...
  hostGroup: string | null
  sortOrder: number
  sshConfigHost: string | null
  sshUser: string | null
  keepAliveSeconds: number
  historyRetentionDays: number
}

interface SshConfigEntry {
  name: string
  hostname: string | null
  port: number
  user: string | null
  identityFile: string | null
  proxyJump: string | null
  isGitHost: boolean  // detected: github.com, gitlab.com, etc.
}

interface SshConfigImport {
  name: string        // SSH config host name
  label: string       // lasterm display name
  hostGroup?: string  // optional group assignment
}

interface TestConnectionResult {
  ok: boolean
  latencyMs?: number
  serverVersion?: string
  error?: string
}
```

### 4.5 Config Additions

```toml
[hostRail]
width = 72
showLabels = true
showStatusDot = true

[hosts.defaults]
defaultShell = "/bin/bash"
keepAliveSeconds = 60
historyRetentionDays = 30
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Host CRUD

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Add SSH host with manual configuration
  Given the user clicks [+] in the host rail
  When they fill in Name "prod", Hostname "1.2.3.4", Port 22, User "deploy", Auth "key", Key "/home/user/.ssh/id_ed25519"
  And click Save
  Then a new host appears in the rail with label "prod"
  And the host is persisted in meta.db with all SSH fields

@priority:high @type:nominal
Scenario: SC-02 Edit existing host
  Given host "prod" exists with hostname "1.2.3.4"
  When the user right-clicks "prod" > Edit Host
  And changes hostname to "1.2.3.5"
  And clicks Save
  Then the host rail updates optimistically
  And meta.db reflects the new hostname

@priority:high @type:nominal
Scenario: SC-03 Delete host with active sessions
  Given host "prod" has 2 active sessions
  When the user right-clicks "prod" > Delete Host
  Then a confirmation modal appears requiring the user to type "prod"
  When the user types "prod" and clicks Delete
  Then active sessions are disconnected
  And the host is removed from rail and meta.db

@priority:medium @type:edge
Scenario: SC-04 Delete host with no sessions
  Given host "staging" has no active sessions and no channels
  When the user right-clicks "staging" > Delete Host
  Then a simple confirmation dialog appears (no typing required)
  When the user clicks Delete
  Then the host is removed

@priority:high @type:error
Scenario: SC-05 Duplicate host label rejected
  Given host "prod" already exists
  When the user tries to create a host with label "prod"
  Then an inline validation error shows "Host name already exists"
  And the Save button remains disabled

@priority:medium @type:nominal
Scenario: SC-06 Duplicate host
  Given host "prod" exists with SSH config
  When the user right-clicks "prod" > Duplicate
  Then a new host "prod-copy" is created with identical settings
  And the new host appears in the same group
```

### Scenario Group: SSH Config Import

```gherkin
@priority:high @type:nominal
Scenario: SC-07 Import from SSH config
  Given ~/.ssh/config contains hosts "prod", "staging", "github.com"
  When the user opens Add Host > Source: From SSH config
  Then a dropdown shows "prod" and "staging" (github.com filtered)
  When the user selects "prod"
  Then hostname, port, user, key file, ProxyJump are pre-filled

@priority:high @type:nominal
Scenario: SC-08 Batch import from SSH config
  Given ~/.ssh/config contains 5 hosts (2 are git hosts)
  When the user opens the batch import dialog
  Then 3 server hosts are pre-checked, 2 git hosts are unchecked
  And ProxyJump dependencies are detected and shown
  When the user clicks "Import 3 hosts"
  Then 3 hosts are created in meta.db with ssh_config_host set

@priority:medium @type:error
Scenario: SC-09 SSH config file not found
  Given ~/.ssh/config does not exist
  When the user selects Source: From SSH config
  Then a message shows "No SSH config file found at ~/.ssh/config"

@priority:medium @type:edge
Scenario: SC-10 SSH config with ProxyJump dependency
  Given "prod" uses ProxyJump "bastion" and only "prod" is selected
  Then the import dialog warns: "prod requires bastion — it will be imported too"
  And "bastion" is auto-checked
```

### Scenario Group: Host Groups

```gherkin
@priority:high @type:nominal
Scenario: SC-11 Create host in a group
  Given group "Production" exists (via existing hosts)
  When the user creates a new host with Group: "Production"
  Then the host appears under the "Production" group separator in the rail

@priority:medium @type:nominal
Scenario: SC-12 Create new group inline
  Given no group "Staging" exists
  When the user clicks "+ New group" in the Add Host modal and enters "Staging"
  Then the host is assigned to group "Staging"
  And a new group separator appears in the rail

@priority:medium @type:nominal
Scenario: SC-13 Collapse/expand group
  Given group "Production" has 3 hosts, expanded
  When the user clicks the group separator
  Then the group collapses, showing "PROD > (3 hosts hidden)"
  When clicked again, it expands back

@priority:medium @type:nominal
Scenario: SC-14 Delete group
  Given group "Staging" has 2 hosts
  When the user right-clicks the group separator > Delete Group
  Then the 2 hosts move to "Ungrouped"
  And the group separator disappears

@priority:medium @type:nominal
Scenario: SC-15 Rename group
  Given group "Production" exists
  When the user right-clicks the group separator > Rename Group
  And enters "Prod"
  Then all hosts in the group reflect host_group "Prod"
```

### Scenario Group: Host Rail UX

```gherkin
@priority:high @type:nominal
Scenario: SC-16 Host rail displays with status dots
  Given local host is running, "prod" is connected, "staging" is idle
  Then the rail shows: local (green dot), prod (green dot), staging (gray dot)

@priority:medium @type:nominal
Scenario: SC-17 Host tooltip on hover
  Given host "prod" is connected with 3 terminals running
  When the user hovers over "prod" in the rail
  Then a tooltip shows: hostname, user, auth method, group, channel count, connection duration

@priority:medium @type:nominal
Scenario: SC-18 DnD reorder hosts
  Given hosts are ordered: prod, staging, dev-box
  When the user drags "dev-box" above "prod"
  Then the order becomes: dev-box, prod, staging
  And sort_order values are updated in meta.db

@priority:medium @type:nominal
Scenario: SC-19 DnD host between groups
  Given "dev-box" is in group "Development"
  When the user drags "dev-box" to group "Production"
  Then the client sends PUT /api/hosts/:id with { hostGroup: "Production" }
  And then PUT /api/hosts/reorder with the target group's new order
  And "dev-box" appears in "Production" with correct sort_order
```

### Scenario Group: Test Connection

```gherkin
@priority:high @type:nominal
Scenario: SC-20 Successful test connection
  Given host "prod" has valid SSH config
  When the user clicks [Test Connection] in the modal
  Then the button shows "Testing..."
  And resolves to "Connected (180ms, OpenSSH 8.9)"

@priority:medium @type:error
Scenario: SC-21 Test connection auth failure
  Given host "staging" has an invalid key path
  When the user clicks [Test Connection]
  Then the result shows "Auth failed (key rejected)"

@priority:medium @type:error
Scenario: SC-22 Test connection timeout
  Given host "unreachable" has a non-routable IP
  When the user clicks [Test Connection]
  Then after 10 seconds, "Timeout after 10s" is shown
```

### Scenario Group: Local Host & Security

```gherkin
@priority:high @type:security
Scenario: SC-23 Local host restrictions
  Given the local host exists
  When the user right-clicks the local host in the rail
  Then only "Edit Name / Icon" is available
  And Delete, Disconnect, Duplicate, Move to Group are NOT shown

@priority:high @type:security
Scenario: SC-24 Password never stored
  Given the user creates a host with Auth: Password
  When they save the host
  Then no password field is stored in meta.db
  And at connect time, a password prompt appears
```

### Scenario Group: Additional Edge Cases & Hardening

```gherkin
@priority:medium @type:edge
Scenario: SC-25 SSH config Include warning
  Given ~/.ssh/config contains an Include directive
  When the user opens the SSH config import dialog
  Then a warning banner shows "Include directives detected — included hosts may be missing"
  And only hosts from the main config file are listed

@priority:medium @type:edge
Scenario: SC-26 Duplicate suffix "-copy" / "-copy-2"
  Given host "prod" exists
  When the user duplicates "prod"
  Then a new host "prod-copy" is created
  When the user duplicates "prod" again
  Then a new host "prod-copy-2" is created

@priority:medium @type:nominal
Scenario: SC-27 Test unsaved host inline
  Given the user is filling the Add Host form with hostname "1.2.3.4", port 22, auth "key"
  When the user clicks [Test Connection] before saving
  Then the POST /api/hosts/test endpoint is called (not /api/hosts/:id/test)
  And the result shows "Connected (150ms, OpenSSH 8.9)" or an error

@priority:medium @type:edge
Scenario: SC-28 Concurrent batch import
  Given two clients attempt batch import simultaneously with overlapping labels
  Then one succeeds and the other gets 409 with conflicting labels
  And no partial imports exist (atomic transaction)

@priority:medium @type:nominal
Scenario: SC-29 Delete group keeps sessions
  Given group "Production" has host "prod" with 2 active sessions
  When the user deletes group "Production"
  Then "prod" moves to "Ungrouped" with host_group=NULL
  And the 2 active sessions continue uninterrupted

@priority:medium @type:error
Scenario: SC-30 Invalid group name rejected
  Given the user creates a new group with name "Prod@#!"
  Then the server returns 400 VALIDATION_ERROR
  And the group is not created
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | X | | | |
| SC-02 | X | | | |
| SC-03 | X | | | |
| SC-04 | | X | | |
| SC-05 | | | X | |
| SC-06 | X | | | |
| SC-07 | X | | | |
| SC-08 | X | | | |
| SC-09 | | | X | |
| SC-10 | | X | | |
| SC-11 | X | | | |
| SC-12 | X | | | |
| SC-13 | X | | | |
| SC-14 | X | | | |
| SC-15 | X | | | |
| SC-16 | X | | | |
| SC-17 | X | | | |
| SC-18 | X | | | |
| SC-19 | X | | | |
| SC-20 | X | | | |
| SC-21 | | | X | |
| SC-22 | | | X | |
| SC-23 | | | | X |
| SC-24 | | | | X |
| SC-25 | | X | | |
| SC-26 | | X | | |
| SC-27 | X | | | |
| SC-28 | | X | | |
| SC-29 | X | | | |
| SC-30 | | | X | |

**Coverage: 17 nominal, 5 edge, 5 error, 2 security = 30 total** (includes SC-25 through SC-30)

## 6. Implementation Plan

### Block 1: Schema Migration + Shared Types — 45min
**Type:** Feature slice
**Dependencies:** None
**Packages:** shared, hub

**Files:**
- `packages/shared/src/entities.ts` — extend Host, CreateHostBody, UpdateHostBody with hostGroup, sortOrder, sshConfigHost, keepAliveSeconds, historyRetentionDays
- `packages/shared/src/config.ts` — add hostRail and hosts.defaults config sections
- `packages/hub/src/storage/meta.ts` — migration: ALTER TABLE hosts ADD COLUMN (6 columns), update INSERT/UPDATE/SELECT queries

**Exit criteria:**
- [ ] 6 new columns (including ssh_user) in hosts table via migration
- [ ] Migration backfills sort_order for existing hosts: dense sequence per host_group using rowid order (avoids all-zero violation of INV-06)
- [ ] Shared Host type extended with new fields
- [ ] MetaDAL queries return new fields
- [ ] listHosts() returns hosts ordered by host_group (NULLs last) then sort_order ASC, with local host always first
- [ ] Existing tests pass (no regressions)

### Block 2: SSH Config Parser + Import API — 1h
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** hub, shared

**Files:**
- `packages/hub/src/ssh/ssh-config-parser.ts` — parse ~/.ssh/config into SshConfigEntry[]
- `packages/hub/src/api/hosts.ts` — GET /api/ssh-config, POST /api/hosts/import
- `packages/shared/src/entities.ts` — SshConfigEntry, SshConfigImport types

**Exit criteria:**
- [ ] SSH config parser handles: Host, HostName, Port, User, IdentityFile, ProxyJump
- [ ] Git hosts (github.com, gitlab.com, bitbucket.org) detected and flagged
- [ ] Batch import creates hosts with ssh_config_host set
- [ ] ProxyJump dependency detection works
- [ ] Parser handles missing/malformed config gracefully
- [ ] Include directive detected and warning shown
- [ ] Batch import is atomic (transaction)

### Block 3: Host Groups + Reorder API — 45min
**Type:** Feature slice
**Dependencies:** Block 1
**Packages:** hub, shared

**Files:**
- `packages/hub/src/api/hosts.ts` — PUT /api/hosts/reorder, POST /api/hosts/:id/duplicate
- `packages/hub/src/storage/meta.ts` — reorderHosts(), duplicateHost() methods, group queries

**Exit criteria:**
- [ ] PUT /api/hosts/reorder accepts `{ group: string|null, hostIds: string[] }`, updates sort_order per-group (0..N)
- [ ] PUT /api/hosts/groups/:name renames group (updates host_group for all matching hosts, validates INV-10)
- [ ] DELETE /api/hosts/groups/:name deletes group (sets host_group=NULL for all matching hosts)
- [ ] POST /api/hosts/:id/duplicate clones host with "-copy" suffix (increments: "-copy-2", "-copy-3", etc.)
- [ ] Cannot duplicate local host (400)
- [ ] Group rename/delete do not affect active sessions

### Block 4: Host Rail Component — 1.5h
**Type:** Feature slice
**Dependencies:** Block 1, Block 3
**Packages:** web

**Files:**
- `packages/clients/web/src/components/HostRail.vue` — full rail with groups, separators, DnD, status dots
- `packages/clients/web/src/composables/useHostGroups.ts` — group hosts by host_group, manage collapse state
- `packages/clients/web/src/stores/hosts.ts` — extend with group management, reorder API calls

**Exit criteria:**
- [ ] Local host always first, non-moveable
- [ ] Hosts organized by group with collapsible separators
- [ ] Status dots reflect session state (green/yellow/red/gray)
- [ ] Tooltip on hover shows connection details
- [ ] DnD reorder within and across groups persists via API
- [ ] [+] button at bottom opens Add Host modal
- [ ] Group collapse state persisted in localStorage
- [ ] Status dot updates isolated per-host (component-level reactivity)

### Block 5: Add/Edit Host Modal — 1.5h
**Type:** Feature slice
**Dependencies:** Block 2 (SSH config import)
**Packages:** web

**Files:**
- `packages/clients/web/src/components/HostModal.vue` — full add/edit modal
- `packages/clients/web/src/composables/useHostForm.ts` — form state, validation, submit logic

**Exit criteria:**
- [ ] All fields from brief: name, icon, color, group, connection source, SSH fields, auth, advanced
- [ ] Source selector: Manual / From SSH config
- [ ] SSH config source shows dropdown of parsed hosts
- [ ] Group selector with "+ New group" inline creation
- [ ] Test Connection button with inline feedback (Testing... → result)
- [ ] Validation: required fields, unique label, valid port range
- [ ] POST /api/hosts/test for inline testing of unsaved hosts

### Block 6: Context Menus + Actions — 1h
**Type:** Feature slice
**Dependencies:** Block 4, Block 5
**Packages:** web

**Files:**
- `packages/clients/web/src/components/HostContextMenu.vue` — right-click menu for hosts
- `packages/clients/web/src/components/GroupContextMenu.vue` — right-click menu for group separators
- `packages/clients/web/src/components/DeleteHostModal.vue` — delete confirmation with type-to-confirm

**Exit criteria:**
- [ ] SSH host menu: Connect, Disconnect, Edit, Duplicate, Move to Group (submenu), Delete
- [ ] Local host menu: Edit Name / Icon only
- [ ] Group menu: Rename Group, Delete Group
- [ ] Delete confirmation requires typing name when host has active sessions
- [ ] Move to Group submenu lists existing groups + "New group" option

### Block 7: Batch Import Modal + Settings — 45min
**Type:** Feature slice
**Dependencies:** Block 2, Block 5
**Packages:** web

**Files:**
- `packages/clients/web/src/components/BatchImportModal.vue` — multi-select import dialog
- `packages/clients/web/src/components/HostRailSettings.vue` — host rail settings (width, showLabels, showStatusDot)

**Exit criteria:**
- [ ] Batch import shows all SSH config hosts with checkboxes
- [ ] Git hosts unchecked by default with "(skipped - not a server)" label
- [ ] ProxyJump dependencies detected and auto-checked with explanation
- [ ] Import count shown on button: "Import N hosts"
- [ ] Host rail settings integrated into settings panel

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 18 | SSH config parser, host validation, group ordering, form logic |
| Integration | 12 | MetaDAL host CRUD with new fields, API routes, batch import |
| E2E | 4 | Add host flow, SSH import flow, DnD reorder, delete with confirm |

### Test Data Requirements

**Fixtures:**
- Sample ~/.ssh/config files (valid, malformed, empty, with ProxyJump chains)
- Host creation bodies (all auth types: key, password, agent)
- Hosts in multiple groups with sort orders

**Mocks:**
- SSH connection for test endpoint (mock ssh2.Client)
- File system for SSH config reading

### Per-Block Test Mapping

| Block | Unit | Integration | E2E |
|-------|------|-------------|-----|
| 1: Schema + Types | 2 | 3 | — |
| 2: SSH Config Parser | 6 | 2 | — |
| 3: Groups + Reorder | 2 | 3 | — |
| 4: Host Rail | 3 | — | 1 |
| 5: Add/Edit Modal | 3 | 2 | 1 |
| 6: Context Menus | 1 | 1 | 1 |
| 7: Batch Import | 1 | 1 | 1 |

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| SSH config parsing edge cases (includes, wildcards) | M | M | Support basic directives only (Host, HostName, Port, User, IdentityFile, ProxyJump); document unsupported features |
| DnD performance with many hosts | L | L | Vue's reactivity handles this; limit to 100 hosts in rail |
| Delete host with orphan channels in spool.db | M | L | Mark channels as orphaned, let GC handle spool data based on retention |
| Naming collision with channel_groups | M | L | Renamed column to host_group; documented distinction |

## 9. Definition of Done

- [ ] All 7 blocks implemented
- [ ] All 30 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + e2e)
- [ ] Lint/typecheck pass
- [ ] Host rail renders correctly with groups, status dots, tooltips
- [ ] Add/Edit/Delete host flows work end-to-end
- [ ] SSH config import (single + batch) works
- [ ] DnD reorder persists across reload
- [ ] Code review clean (no blocking findings)

## 10. Dependencies & Integration Notes

- **UX-01 (complete):** Tab actions, channel sidebar — host rail sits to the left of channel sidebar
- **UX-06 (complete):** Theming — host rail uses CSS vars (--nt-*) for styling
- **UX-07 (after):** Visual profiles — will add visual profile section to Edit Host modal's advanced tab
- **Config cascade:** hostRail and hosts.defaults added to config.toml schema
- **Context menus:** Reuse pattern from UX-01 tab context menus if available
