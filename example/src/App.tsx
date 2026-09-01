import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../convex/_generated/api";
import "./App.css";

type Category = "food" | "travel" | "software" | "other";
type AccountId = "account-1" | "account-2" | "account-3";
type Direction = "asc" | "desc";
type VisibleField =
  "merchant" | "category" | "accountId" | "bookingDate" | "amountMinor";
type VisiblePatch = {
  merchant?: string;
  category?: Category;
  accountId?: AccountId;
  bookingDate?: number;
  amountMinor?: number;
};
type DraftEntry = {
  value: string;
  expectedRev: number;
};
type RuntimeRecord = {
  _id: string;
  rev: number;
  values: Record<string, unknown>;
};

const date = new Intl.DateTimeFormat("en", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const categoryLabels: Record<Category, string> = {
  food: "Food",
  travel: "Travel",
  software: "Software",
  other: "Other",
};

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4 6h12M8 3h4l1 3H7l1-3Zm-2 3 1 11h6l1-11M9 9v5m2-5v5" />
    </svg>
  );
}

function ShowcaseHeader() {
  return (
    <header className="showcase-header">
      <div className="showcase-copy">
        <h1>convex-runtime-tables</h1>
        <p>
          <span>Interactive showcase.</span> If you want to offer your users
          Notion-like custom tables, this component is for you.
        </p>
      </div>
      <a
        className="profile-link"
        href="https://github.com/valentindoering"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img
          src="https://github.com/valentindoering.png?size=64"
          alt="Valentin Doering's GitHub profile"
          width="32"
          height="32"
        />
        <span>
          <strong>GitHub</strong>
          <small>@valentindoering</small>
        </span>
      </a>
    </header>
  );
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "The operation failed";
  return error.message.split("\n")[0] ?? "The operation failed";
}

function dateInputValue(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dateTimestamp(value: string) {
  return Date.parse(`${value}T12:00:00.000Z`);
}

function amountInputValue(amountMinor: number) {
  return (amountMinor / 100).toFixed(2);
}

function draftKey(recordId: string, field: VisibleField) {
  return `${recordId}:${field}`;
}

export default function App() {
  const schema = useQuery(api.example.getDemoSchema);
  const initialize = useMutation(api.example.initializeDemo);
  const seed = useMutation(api.example.seedTransactions);
  const add = useMutation(api.example.addTransaction);
  const update = useMutation(api.example.updateTransaction);
  const adjust = useMutation(api.example.adjustTransaction);
  const remove = useMutation(api.example.deleteTransaction);

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"" | Category>("");
  const [direction, setDirection] = useState<Direction>("desc");
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const cancelledDrafts = useRef(new Set<string>());
  const nameInputs = useRef(new Map<string, HTMLInputElement>());

  const fields = useMemo(
    () =>
      Object.fromEntries(
        (schema?.fields ?? []).map((field) => [field.key, field.fieldId]),
      ),
    [schema],
  );
  const currentCursor = cursors[pageIndex] ?? null;
  const browseArgs = schema
    ? {
        tableId: schema.tableId,
        direction,
        ...(accountFilter ? { accountId: accountFilter } : {}),
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...(currentCursor ? { cursor: currentCursor } : {}),
      }
    : "skip";
  const records = useQuery(api.example.browseTransactions, browseArgs);
  const rows = useMemo(() => records?.page ?? [], [records?.page]);

  useEffect(() => {
    if (!pendingFocusId) return;
    if (!rows.some((record) => record._id === pendingFocusId)) return;
    const input = nameInputs.current.get(pendingFocusId);
    if (!input) return;
    input.focus();
    input.select();
    setPendingFocusId(null);
  }, [pendingFocusId, rows]);

  const resetPagination = () => {
    setPageIndex(0);
    setCursors([null]);
  };

  function setDraft(record: RuntimeRecord, field: VisibleField, value: string) {
    const key = draftKey(record._id, field);
    setDrafts((current) => ({
      ...current,
      [key]: {
        value,
        expectedRev: current[key]?.expectedRev ?? record.rev,
      },
    }));
  }

  function clearDraft(recordId: string, field: VisibleField) {
    const key = draftKey(recordId, field);
    setDrafts((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function commitPatch(
    record: RuntimeRecord,
    field: VisibleField,
    value: string,
    patch: VisiblePatch,
    expectedRev = record.rev,
  ) {
    if (!schema) return;
    const key = draftKey(record._id, field);
    setBusy(`edit-${key}`);
    setError(null);
    setNotice(null);
    try {
      const result = await update({
        tableId: schema.tableId,
        recordId: record._id,
        expectedRev,
        patch,
      });
      setDrafts((current) => {
        const latest = current[key];
        if (!latest) return current;
        const next = { ...current };
        if (latest.value === value && latest.expectedRev === expectedRev) {
          delete next[key];
        } else {
          next[key] = { ...latest, expectedRev: result.rev };
        }
        return next;
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function commitDraft(
    record: RuntimeRecord,
    field: VisibleField,
    makePatch: (value: string) => VisiblePatch | null,
  ) {
    const key = draftKey(record._id, field);
    if (cancelledDrafts.current.delete(key)) return;
    const entry = drafts[key];
    if (!entry) return;
    const patch = makePatch(entry.value);
    if (!patch) return;
    await commitPatch(record, field, entry.value, patch, entry.expectedRev);
  }

  async function commitSelect(
    record: RuntimeRecord,
    field: "category" | "accountId",
    value: string,
    patch: VisiblePatch,
  ) {
    const key = draftKey(record._id, field);
    const expectedRev = drafts[key]?.expectedRev ?? record.rev;
    setDraft(record, field, value);
    await commitPatch(record, field, value, patch, expectedRev);
  }

  function cancelDraft(
    event: React.KeyboardEvent<HTMLInputElement>,
    recordId: string,
    field: VisibleField,
  ) {
    if (event.key !== "Escape") return false;
    event.preventDefault();
    const key = draftKey(recordId, field);
    cancelledDrafts.current.add(key);
    clearDraft(recordId, field);
    event.currentTarget.blur();
    return true;
  }

  async function createRow() {
    if (!schema) return;
    setBusy("new");
    setError(null);
    setNotice(null);
    setDirection("desc");
    resetPagination();
    try {
      const result = await add({
        tableId: schema.tableId,
        accountId: (accountFilter || "account-1") as AccountId,
        category: categoryFilter || "other",
      });
      setPendingFocusId(result.recordId);
      setNotice("Untitled row added");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function run(
    label: string,
    action: () => Promise<unknown>,
    success: string,
  ) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  if (schema === undefined) {
    return (
      <main className="database-page loading-page">
        <ShowcaseHeader />
        <p className="quiet-message">Connecting to the local database…</p>
      </main>
    );
  }

  if (schema === null) {
    return (
      <main className="database-page empty-database-page">
        <ShowcaseHeader />
        <p className="quiet-message">
          Create a runtime table with seven properties and four indexes.
        </p>
        <button
          className="new-button create-button"
          disabled={busy !== null}
          onClick={() =>
            void run("initialize", () => initialize({}), "Database created")
          }
        >
          {busy ? "Creating…" : "Create database"}
        </button>
        {error && <p className="inline-message error">{error}</p>}
      </main>
    );
  }

  const allIndexesReady =
    schema.indexes.length === 4 &&
    schema.indexes.every((index) => index.state === "ready");
  const needsSync = schema.indexes.length < 4;
  const planName =
    records?.plan.indexName ??
    (records?.plan.kind === "scan" ? "bounded scan" : "table order");

  return (
    <main className="database-page">
      <ShowcaseHeader />

      <section className="database-frame" aria-label="Transactions database">
        <div className="database-toolbar">
          <div className="toolbar-controls">
            <label className="toolbar-control">
              <span aria-hidden="true">↗</span>
              <span className="sr-only">Account filter</span>
              <select
                aria-label="Account filter"
                value={accountFilter}
                onChange={(event) => {
                  setAccountFilter(event.target.value);
                  resetPagination();
                }}
              >
                <option value="">All accounts</option>
                <option value="account-1">Account 1</option>
                <option value="account-2">Account 2</option>
                <option value="account-3">Account 3</option>
              </select>
            </label>
            <label className="toolbar-control">
              <span aria-hidden="true">≡</span>
              <span className="sr-only">Category filter</span>
              <select
                aria-label="Category filter"
                value={categoryFilter}
                onChange={(event) => {
                  setCategoryFilter(event.target.value as "" | Category);
                  resetPagination();
                }}
              >
                <option value="">All categories</option>
                <option value="food">Food</option>
                <option value="travel">Travel</option>
                <option value="software">Software</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="toolbar-control">
              <span aria-hidden="true">⇅</span>
              <span className="sr-only">Sort direction</span>
              <select
                aria-label="Sort direction"
                value={direction}
                onChange={(event) => {
                  setDirection(event.target.value as Direction);
                  resetPagination();
                }}
              >
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </label>
            <span className="plan-meta" title="Runtime query plan">
              {records ? `Plan · ${planName}` : "Planning…"}
              {records?.plan.postFiltered ? " · filtered" : ""}
            </span>
          </div>

          <div className="toolbar-actions">
            {needsSync && (
              <button
                className="text-button"
                disabled={busy !== null}
                onClick={() =>
                  void run("sync", () => initialize({}), "Indexes synchronized")
                }
              >
                Finish setup
              </button>
            )}
            <button
              className="text-button"
              disabled={busy !== null || !allIndexesReady}
              onClick={() =>
                void run(
                  "seed",
                  () => seed({ tableId: schema.tableId }),
                  "6 sample rows loaded",
                )
              }
            >
              {busy === "seed" ? "Loading…" : "Load sample"}
            </button>
            <button
              className="new-button"
              disabled={busy !== null || !allIndexesReady}
              onClick={() => void createRow()}
            >
              {busy === "new" ? "Adding…" : "New"}
            </button>
          </div>
        </div>

        {(notice || error) && (
          <div
            className={error ? "inline-message error" : "inline-message"}
            role="status"
          >
            <span>{error ?? notice}</span>
            <button
              aria-label="Dismiss message"
              onClick={() => {
                setError(null);
                setNotice(null);
              }}
            >
              ×
            </button>
          </div>
        )}

        <div className="table-scroll">
          <table className="notion-table">
            <thead>
              <tr>
                <th className="name-column">
                  <span>Aa</span> Name
                </th>
                <th>
                  <span>≡</span> Category
                </th>
                <th>
                  <span>↗</span> Account
                </th>
                <th>
                  <span>◷</span> Date
                </th>
                <th className="numeric">
                  <span>#</span> Amount
                </th>
                <th className="actions-column" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => {
                const runtimeRecord = record as RuntimeRecord;
                const merchant = String(record.values[fields.merchant!] ?? "");
                const rowCategory = String(
                  record.values[fields.category!] ?? "other",
                ) as Category;
                const account = String(
                  record.values[fields.accountId!] ?? "account-1",
                ) as AccountId;
                const bookingDate = Number(
                  record.values[fields.bookingDate!] ?? 0,
                );
                const amountMinor = Number(
                  record.values[fields.amountMinor!] ?? 0,
                );
                const merchantDraft =
                  drafts[draftKey(record._id, "merchant")]?.value ?? merchant;
                const categoryDraft =
                  drafts[draftKey(record._id, "category")]?.value ??
                  rowCategory;
                const accountDraft =
                  drafts[draftKey(record._id, "accountId")]?.value ?? account;
                const dateDraft =
                  drafts[draftKey(record._id, "bookingDate")]?.value ??
                  dateInputValue(bookingDate);
                const amountDraft =
                  drafts[draftKey(record._id, "amountMinor")]?.value ??
                  amountInputValue(amountMinor);
                return (
                  <tr key={record._id}>
                    <td className="name-cell">
                      <span className="row-page-icon" aria-hidden="true">
                        ▧
                      </span>
                      <input
                        ref={(input) => {
                          if (input) nameInputs.current.set(record._id, input);
                          else nameInputs.current.delete(record._id);
                        }}
                        className="cell-input name-input"
                        aria-label={`Name for ${merchant}`}
                        value={merchantDraft}
                        onChange={(event) =>
                          setDraft(
                            runtimeRecord,
                            "merchant",
                            event.target.value,
                          )
                        }
                        onBlur={() =>
                          void commitDraft(
                            runtimeRecord,
                            "merchant",
                            (value) => ({ merchant: value }),
                          )
                        }
                        onKeyDown={(event) => {
                          if (cancelDraft(event, record._id, "merchant")) {
                            return;
                          }
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </td>
                    <td>
                      <select
                        className={`cell-select category-select ${categoryDraft}`}
                        aria-label={`Category for ${merchant}`}
                        value={categoryDraft}
                        onChange={(event) =>
                          void commitSelect(
                            runtimeRecord,
                            "category",
                            event.target.value,
                            { category: event.target.value as Category },
                          )
                        }
                      >
                        {Object.entries(categoryLabels).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </td>
                    <td>
                      <select
                        className="cell-select account-select"
                        aria-label={`Account for ${merchant}`}
                        value={accountDraft}
                        onChange={(event) =>
                          void commitSelect(
                            runtimeRecord,
                            "accountId",
                            event.target.value,
                            { accountId: event.target.value as AccountId },
                          )
                        }
                      >
                        <option value="account-1">Account 1</option>
                        <option value="account-2">Account 2</option>
                        <option value="account-3">Account 3</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="cell-input date-input"
                        type="date"
                        aria-label={`Date for ${merchant}`}
                        value={dateDraft}
                        title={date.format(new Date(bookingDate))}
                        onChange={(event) =>
                          setDraft(
                            runtimeRecord,
                            "bookingDate",
                            event.target.value,
                          )
                        }
                        onBlur={() =>
                          void commitDraft(
                            runtimeRecord,
                            "bookingDate",
                            (value) => {
                              const timestamp = dateTimestamp(value);
                              return Number.isFinite(timestamp)
                                ? { bookingDate: timestamp }
                                : null;
                            },
                          )
                        }
                        onKeyDown={(event) => {
                          if (cancelDraft(event, record._id, "bookingDate")) {
                            return;
                          }
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </td>
                    <td className="numeric">
                      <input
                        className="cell-input amount-input"
                        type="number"
                        step="0.01"
                        aria-label={`Amount for ${merchant}`}
                        value={amountDraft}
                        onChange={(event) =>
                          setDraft(
                            runtimeRecord,
                            "amountMinor",
                            event.target.value,
                          )
                        }
                        onBlur={() =>
                          void commitDraft(
                            runtimeRecord,
                            "amountMinor",
                            (value) => {
                              const amount = Number(value);
                              return Number.isFinite(amount)
                                ? { amountMinor: Math.round(amount * 100) }
                                : null;
                            },
                          )
                        }
                        onKeyDown={(event) => {
                          if (cancelDraft(event, record._id, "amountMinor")) {
                            return;
                          }
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </td>
                    <td className="actions-column">
                      <div className="row-actions">
                        <button
                          aria-label={`Add one euro to ${merchant}`}
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              `adjust-${record._id}`,
                              () =>
                                adjust({
                                  tableId: schema.tableId,
                                  recordId: record._id,
                                  amountFieldId: fields.amountMinor!,
                                  amountMinor: amountMinor + 100,
                                  expectedRev: record.rev,
                                }),
                              `€1 added · revision r${record.rev + 1}`,
                            )
                          }
                          title="Add €1 with an optimistic revision check"
                        >
                          +€1
                        </button>
                        <button
                          aria-label={`Delete ${merchant}`}
                          className="icon-button"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(
                              `delete-${record._id}`,
                              () =>
                                remove({
                                  tableId: schema.tableId,
                                  recordId: record._id,
                                  expectedRev: record.rev,
                                }),
                              "Transaction deleted",
                            )
                          }
                          title="Delete record and index entries atomically"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-row">
                    No transactions in this view.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="database-footer">
          <span>{rows.length} rows</span>
          <div className="pagination-actions">
            <button
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((page) => Math.max(0, page - 1))}
            >
              Previous
            </button>
            <button
              disabled={!records?.continueCursor}
              onClick={() => {
                if (!records?.continueCursor) return;
                const next = records.continueCursor;
                setCursors((existing) => [
                  ...existing.slice(0, pageIndex + 1),
                  next,
                ]);
                setPageIndex((page) => page + 1);
              }}
            >
              Next
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
