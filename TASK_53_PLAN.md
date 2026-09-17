# Task #53: Performance & Goals UI — Implementation Plan

**Status:** Ready to build  
**Scope:** Frontend only (backend complete, 125+ tests passing)  
**Estimated effort:** 6–8 hours

## Architecture

Following Decision #15: one list/detail screen serves all three roles (`hr_admin`, `line_manager`, `employee_self_service`). The API already RBAC-scopes what comes back; the frontend calls the same endpoints for every user and only gates cosmetic buttons on `identity.roleKeys`.

## Entry Points & Navigation

- **Route:** `/app/performance` (replace `ComingSoonPage` in `App.tsx` line 97)
- **Nav item:** Already added to `PortalLayout.buildNavItems()` (line 47–50, gated on module license)
- **Layout:** Tab-based shell matching `RecruitmentPage` pattern

## Core UI Screens

### 1. **Review Cycles Tab**
Location: `apps/web/src/portal/performance/ReviewCyclesPanel.tsx`

**List view (all roles):**
- Table: `Name`, `Period`, `Status`, `Action buttons`
- Statuses: `draft`, `active`, `calibration`, `closed`
- Filters: status dropdown (optional)
- Pagination: if cycle count > 20

**HR-admin-only buttons:**
- "New Cycle" → create modal
- "Launch" (cycle.status === "draft")
- "Begin Calibration" (cycle.status === "active")
- "Close" (cycle.status === "calibration")

**Detail panel (when selected):**
- Read-only summary: name, period dates, status
- "Participants" button → shows participant list (if filtered by group) or employee count
- If calibration view: show rating histogram + "Calibrate" link for unfinalized reviews

### 2. **Goals Tab**
Location: `apps/web/src/portal/performance/GoalsPanel.tsx`

**List view:**
- Table: `Employee`, `Goal Title`, `Cycle`, `Weight`, `Status`, `Actions`
- Filterable by: cycle, employee (for managers viewing team goals)
- Hierarchical display: indent parent → children

**Role-specific permissions:**
- `hr_admin` (.all): Create/edit/delete any goal
- `line_manager` (.team): Create/edit goals for own reports only
- `employee_self_service` (.self): Create/edit own goals only

**Create/Edit modal:**
- Fields: title, description, weight (0-100), parent goal (optional for hierarchy)
- Parent goal dropdown: only goals from same cycle, same level
- Validation: weight must be within 0-100, sum-per-employee check (optional, warn if > 100)

### 3. **Performance Reviews Tab**
Location: `apps/web/src/portal/performance/PerformanceReviewsPanel.tsx`

**List view (all roles):**
- Table: `Employee`, `Cycle`, `Status`, `Actions`
- Filterable by: cycle, status, employee (for managers)
- Status badges: `Pending`, `In Progress`, `Completed`, `Calibrated`, `Released`

**Review detail (modal or side panel):**
- Always visible: Employee name, cycle, review status
- Self-Assessment section:
  - Text area: "Your assessment of your own performance"
  - Submit button (visible only if `status !== "released"` AND user is employee OR hr_admin)
  - Read-only after submit with `submittedAt` timestamp
- Manager Assessment section:
  - Text area: "Manager's assessment"
  - Rating: 1-5 star picker (or radio buttons)
  - Submit button (visible if `status !== "released"` AND user is manager OR hr_admin)
  - Visible only to manager/hr_admin until review is released
- Goals table (read-only in review context): shows all goals tied to this cycle

**Role visibility:**
- Employees see: own self-assessment area + read-only manager assessment (after release) + goals
- Managers see: self-assessment area (for own reviews) + manager assessment area for team members + their team's goals
- HR admin sees: everything, plus calibration controls

### 4. **Calibration Workspace** (HR-admin-only)
Location: `apps/web/src/portal/performance/CalibrationPanel.tsx`

**Entry point:** When cycle.status === "calibration", show "Calibration" tab (or accessible from review detail)

**Histogram view:**
- Heading: "Rating Distribution for [Cycle Name]"
- Bar chart: rating (1–5) on x-axis, count on y-axis
- Summary stats: total reviews, pending calibration count

**Review calibration grid:**
- Table: `Employee`, `Current Manager Rating`, `Manager Comment`, `Calibrated Rating`, `Calibration Comment`, `Finalize`
- Only shows reviews with `status` in `["pending", "in_progress", "completed"]`
- Calibrated rating: 1-5 picker (pre-filled with manager rating if already set)
- Calibration comment: text area
- "Finalize" button: sets `calibratedAt` and `calibrationRating`, moves review to `calibrated` status

## API Client Methods (to add to `client.ts`)

```typescript
// Review Cycles
listReviewCycles: () => request<ReviewCycleView[]>("/review-cycles"),
getReviewCycle: (id: string) => request<ReviewCycleView>(`/review-cycles/${id}`),
createReviewCycle: (input: CreateReviewCycleDto) => request<ReviewCycleView>("/review-cycles", "POST", input),
launchReviewCycle: (id: string) => request<ReviewCycleView>(`/review-cycles/${id}/launch`, "POST"),
beginCalibration: (id: string) => request<ReviewCycleView>(`/review-cycles/${id}/begin-calibration`, "POST"),
closeReviewCycle: (id: string) => request<{ cycle: ReviewCycleView; releasedCount: number }>(`/review-cycles/${id}/close`, "POST"),
getRatingDistribution: (cycleId: string) => request<RatingDistributionView>(`/review-cycles/${cycleId}/rating-distribution`),

// Goals
listGoals: (params?: { reviewCycleId?: string; employeeId?: string }) => request<GoalView[]>("/goals", "GET", undefined, params),
createGoal: (input: CreateGoalDto) => request<GoalView>("/goals", "POST", input),
updateGoal: (id: string, patch: UpdateGoalDto) => request<GoalView>(`/goals/${id}`, "PATCH", patch),

// Performance Reviews
listPerformanceReviews: (params?: { reviewCycleId?: string; employeeId?: string }) => request<PerformanceReviewView[]>("/performance-reviews", "GET", undefined, params),
getPerformanceReview: (id: string) => request<PerformanceReviewView>(`/performance-reviews/${id}`),
submitSelfAssessment: (id: string, input: SubmitSelfAssessmentDto) => request<PerformanceReviewView>(`/performance-reviews/${id}/self-assessment`, "PATCH", input),
submitManagerAssessment: (id: string, input: SubmitManagerAssessmentDto) => request<PerformanceReviewView>(`/performance-reviews/${id}/manager-assessment`, "PATCH", input),
calibrateReview: (id: string, input: CalibrateReviewDto) => request<PerformanceReviewView>(`/performance-reviews/${id}/calibrate`, "PATCH", input),
```

## File Structure

```
apps/web/src/portal/performance/
├── PerformancePage.tsx          # Main tab shell (copy pattern from RecruitmentPage)
├── ReviewCyclesPanel.tsx        # Review cycles list/detail
├── GoalsPanel.tsx               # Goals management
├── PerformanceReviewsPanel.tsx  # Reviews + assessments
├── CalibrationPanel.tsx         # HR-admin-only calibration workspace
└── modals/
    ├── CreateCycleModal.tsx      # New cycle form
    ├── CreateGoalModal.tsx       # New goal form
    └── ReviewDetailPanel.tsx     # Full review detail (side panel or modal)
```

## Component Patterns (Reuse from Decision #15)

Each panel follows this pattern:
1. **State:** `const [data, setData] = useState<T[]>([])`
2. **Effects:** `useEffect(() => { api.list().then(setData) }, [refetchTrigger])`
3. **Error handling:** `const [error, setError] = useState<string | null>(null)`
4. **Table rendering:** `data.map(row => <TableRow ... />)`
5. **Role-gated buttons:** `{roleKeys.includes("hr_admin") && <button>...</button>}`
6. **Optimistic updates:** Update local state immediately, roll back on API error

## Testing Strategy

No browser test needed for Task #53 per project discipline (inline Playwright tests are throwaway, not committed). Backend is fully tested (125+ tests passing). Verification will be:
1. Manual smoke test: create cycle → launch → self-assess → manager-assess → calibrate → close
2. Role permission smoke test: verify employee cannot access cycle-creation, manager cannot calibrate, etc.

## Acceptance Criteria

- ✅ All four tabs render and are tab-selectable
- ✅ Review Cycles: HR can create, launch, calibrate, close; all roles can view current cycles
- ✅ Goals: Each role can create/edit goals appropriate to their scope (.all/.team/.self)
- ✅ Reviews: Self-assessment and manager assessment submit correctly; calibration round-trip works
- ✅ Calibration: histogram displays correctly; HR can finalize reviews
- ✅ Permissions: Role-based button visibility matches API permissions
- ✅ Navigation: "Performance" nav item shows for users with `performance` module license
- ✅ Replace `ComingSoonPage` route with real implementation
- ✅ API client methods added to `client.ts`
- ✅ No regressions in existing portal screens (verified by manual check of unrelated tabs)

## Known Limitations (Documented, Not Bugs)

These are in `KNOWN_ISSUES.md` and are out of scope for Task #53:
- Reviews stuck at `pending`/`in_progress` are silently skipped when cycle closes (no SLA escalation)
- Launched cycle's participant population is frozen; mid-cycle hires/transfers/exits are not auto-added
- Rating scale is 1–5 integer only (not tenant-configurable)
- No workflow approvals (single-actor RBAC actions only per Decision #11)
- No calibration-committee multi-step sign-off

## Build Order

1. Add API client methods to `client.ts` (imports from `shared-types` already available)
2. Build `PerformancePage.tsx` (tab shell)
3. Build `ReviewCyclesPanel.tsx` (list/detail) + `CreateCycleModal.tsx`
4. Build `GoalsPanel.tsx` (list/detail) + `CreateGoalModal.tsx`
5. Build `PerformanceReviewsPanel.tsx` + `ReviewDetailPanel.tsx` (self/manager assessment)
6. Build `CalibrationPanel.tsx` (histogram + calibration grid)
7. Wire route in `App.tsx` (replace ComingSoonPage)
8. Manual verification (smoke test)

## Handoff Checklist

Before marking Task #53 complete:
- [ ] All four tabs build without TypeScript errors
- [ ] API calls work against real backend
- [ ] Role-based button visibility is correct per `roleKeys`
- [ ] Navigate away and back; data still there (or re-fetches appropriately)
- [ ] One manual smoke-test workflow: create cycle → launch → assess → calibrate → close
- [ ] Git commit with `Task #53` in message, followed by attribution lines
