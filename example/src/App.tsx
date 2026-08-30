import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { api } from "../convex/_generated/api";
import "./App.css";

const money = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "EUR",
});

export default function App() {
  const schema = useQuery(api.example.getDemoSchema);
  const records = useQuery(
    api.example.listTransactions,
    schema ? { tableId: schema.tableId } : "skip",
  );
  const initialize = useMutation(api.example.initializeDemo);
  const seed = useMutation(api.example.seedTransactions);
  const add = useMutation(api.example.addTransaction);
  const [busy, setBusy] = useState<string | null>(null);
  const [merchant, setMerchant] = useState("Corner Office Coffee");
  const [amount, setAmount] = useState("12.50");
  const [category, setCategory] = useState("food");

  const fields = useMemo(
    () => Object.fromEntries((schema?.fields ?? []).map((field) => [field.key, field.fieldId])),
    [schema],
  );

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  }

  if (schema === undefined) return <main className="shell">Loading local component…</main>;

  if (schema === null) {
    return (
      <main className="shell empty-state">
        <p className="eyebrow">Convex component demo</p>
        <h1>Runtime tables, without build-time schemas</h1>
        <p>
          Create the finance acceptance table, seven runtime fields, and three online indexes.
          The component stays generic; this host supplies the finance vocabulary.
        </p>
        <button
          className="primary"
          disabled={busy !== null}
          onClick={() => run("initialize", () => initialize({}))}
        >
          {busy ? "Creating…" : "Initialize demo"}
        </button>
      </main>
    );
  }

  const rows = records?.page ?? [];
  return (
    <main className="shell">
      <header>
        <div>
          <p className="eyebrow">convex-runtime-tables</p>
          <h1>Transaction runtime table</h1>
          <p className="muted">
            {schema.fields.length} fields · {rows.length} records · {records?.planKind ?? "loading"} plan
          </p>
        </div>
        <button
          className="secondary"
          disabled={busy !== null}
          onClick={() => run("seed", () => seed({ tableId: schema.tableId }))}
        >
          {busy === "seed" ? "Seeding…" : "Seed 24 records"}
        </button>
      </header>

      <section className="index-strip" aria-label="Runtime indexes">
        {schema.indexes.map((index) => (
          <article key={index.indexId}>
            <span className={`status ${index.state}`}>{index.state}</span>
            <strong>{index.name}</strong>
            <small>{index.unique ? "unique" : "range"}</small>
          </article>
        ))}
      </section>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void run("add", async () => {
            await add({
              tableId: schema.tableId,
              fieldIds: {
                accountId: fields.accountId!,
                bookingDate: fields.bookingDate!,
                amountMinor: fields.amountMinor!,
                currency: fields.currency!,
                merchant: fields.merchant!,
                category: fields.category!,
                sourceRef: fields.sourceRef!,
              },
              merchant,
              amountMinor: Math.round(Number(amount) * 100),
              category,
            });
          });
        }}
      >
        <label>
          Merchant
          <input value={merchant} onChange={(event) => setMerchant(event.target.value)} />
        </label>
        <label>
          Amount
          <input type="number" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <label>
          Category
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="food">Food</option>
            <option value="travel">Travel</option>
            <option value="software">Software</option>
            <option value="other">Other</option>
          </select>
        </label>
        <button className="primary" disabled={busy !== null || !merchant || !Number.isFinite(Number(amount))}>
          {busy === "add" ? "Adding…" : "Add record"}
        </button>
      </form>

      <section className="table-card">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th>Category</th>
              <th>Account</th>
              <th className="numeric">Amount</th>
              <th>Revision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((record) => (
              <tr key={record._id}>
                <td>{new Date(Number(record.values[fields.bookingDate!])).toLocaleDateString()}</td>
                <td>{String(record.values[fields.merchant!] ?? "")}</td>
                <td><span className="category">{String(record.values[fields.category!] ?? "")}</span></td>
                <td>{String(record.values[fields.accountId!] ?? "")}</td>
                <td className="numeric">{money.format(Number(record.values[fields.amountMinor!]) / 100)}</td>
                <td>r{record.rev}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="empty-row">Seed the table or add a record.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
