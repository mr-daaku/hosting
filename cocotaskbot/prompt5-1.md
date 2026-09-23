# CoCo App — prompt5.md (Deposit fix with code + admin task fixes)

Three things, all important — please implement all of them together.

---

## 1. Deposit isn't crediting — root cause found, fix below

**Root cause:** in `wallet.tsx`, after `tonConnectUI.sendTransaction(...)` succeeds, the code only shows toasts ("Payment sent. Confirming on the network…") and sets `depositState` to `"confirming"` — **it never actually calls `checkDepositFn` (which runs `reconcilePendingDeposits`) again after that point.** There is no polling loop, no interval, nothing that ever re-checks the chain or moves `depositState` to `"confirmed"`. So the `deposit_attempts` row just sits at `status: "pending"` until it silently flips to `"expired"` after 24 hours (this matches exactly what's in the attached CSV export — rows stuck `pending` or `expired`, `tx_hash` always empty). The confirmation *backend logic itself* (`ton-deposits.server.ts` → `reconcilePendingDeposits`) looks correct — it's just never being called after the transaction is sent.

**Fix — poll `checkDepositFn` after `sendTransaction` succeeds, and also once on page load for any leftover pending attempt.** Example implementation for `wallet.tsx`:

```tsx
// After tonConnectUI.sendTransaction(...) resolves successfully:
toast("Payment sent. Confirming on the network…");
setDepositState("confirming");
pollDeposit(pendingAttemptId);

// Add this helper inside the component (or as a local function):
async function pollDeposit(attemptId: string) {
  const start = Date.now();
  const maxMs = 2 * 60 * 1000; // poll for up to 2 minutes
  const intervalMs = 4000;

  const tick = async () => {
    try {
      const res = await checkDeposit(attemptId); // wraps checkDepositFn({ data: { userId, attemptId } })
      if (res.ok) {
        setDepositState("confirmed");
        toast(res.message); // "Credited X Gram."
        return; // stop polling — done
      }
    } catch {
      // ignore a single failed check, keep polling
    }
    if (Date.now() - start >= maxMs) {
      setDepositState("delayed"); // shows the existing "taking longer than usual" message
      return;
    }
    setTimeout(tick, intervalMs);
  };

  setTimeout(tick, intervalMs);
}
```

Also add a **mount-time check**: when the Wallet page loads, if there's a `pending` deposit attempt for this user (from a previous session — e.g. they closed the app after sending but before it confirmed), call `checkDeposit()` once immediately and, if still pending, start the same polling loop. This covers the case where the user already paid, left, and came back later — it should self-heal without needing a manual button.

Since this removes the need for a manual "I already paid - check now" button (per the earlier request), the polling above should be the only path to confirmation now — background and automatic, no user action required beyond sending the payment.

## 2. Admin panel — "Delete" button not working on Running tasks

The `adminDeleteTask` server function and its `AlertDialog` confirm UI look correctly wired in the code, but it's specifically failing for **Running** tasks. Two likely causes to check and fix:

- **Silent DB error being swallowed:** `adminDeleteTask` currently returns a generic `"Task could not be deleted."` on any Supabase error, without logging or surfacing the actual error (e.g. a foreign-key constraint from `task_completions` — or another table referencing `tasks.id` — blocking the delete once a task has real completions, which Running tasks are more likely to have than Pending ones). Update the handler to `console.error` the real Supabase error server-side, and if it's specifically a foreign-key violation, either (a) delete the related `task_completions` rows for that task first within the same operation, or (b) switch to a soft-delete (`status: "deleted"`, filtered out of all normal queries) instead of a hard `DELETE` when a task has completions — pick whichever keeps completion/audit history intact, but make it actually succeed.
- **Client-side wiring:** double-check that the Running tab's task list renders the exact same delete button + `AlertDialog` + `taskId` binding as Pending/Paused/Done — if Running tasks are rendered through a separate code path (rather than one shared task-row component across all four tabs), confirm that path didn't drop or mis-wire the delete handler/taskId.

## 3. Admin panel — restructure the Tasks tab into "Promote" and "Partner"

Split the Tasks tab into **2 top-level sub-tabs**:

- **Promote** — this holds everything the Tasks tab currently has: the existing **Pending / Running / Paused / Done** sub-tabs (user-submitted, Gram-funded tasks), unchanged in behavior.
- **Partner** — new, admin-only tasks. This sub-tab has **2 further sub-tabs**:
  - **Create** — the admin-only task creation form (title, link, category, users, reward — reuse `adminCreateTaskFn`, which already exists and runs partner tasks immediately with no Gram cost).
  - **Created** — a list of all partner tasks created so far, each row with the **same action buttons** available elsewhere (pause/resume, delete with the same refund-aware confirm dialog, edit if that exists) — partner tasks don't need a Pending→Approve step since the admin is the creator, but they should still be manageable (pause/delete) from here just like Promote tasks are.

---

**Before finishing:** confirm a real deposit now gets credited automatically within ~2 minutes of sending, without any manual button; confirm Delete now works on a Running task with real completions (not just an empty freshly-created one); confirm the Tasks tab shows Promote/Partner as the two top-level tabs with the sub-tab structure described above.
