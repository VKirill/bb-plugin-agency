import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { fail, ok } from "../src/domain";
import { commitDomainTransaction } from "../src/server/db/domain-txn";

describe("commitDomainTransaction", () => {
  it("rolls back writes when work returns fail, unlike a bare sqlite transaction", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT)");
    const insert = db.prepare("INSERT INTO sample (name) VALUES (?)");
    const count = () => (db.prepare("SELECT count(*) AS n FROM sample").get() as { n: number }).n;

    db.transaction(() => {
      insert.run("kept");
      return fail("demo", "bare transaction commits this");
    })();
    expect(count()).toBe(1);

    const aborted = commitDomainTransaction(db, () => {
      insert.run("rolled-back");
      return fail("membership_write_failed", "after first write");
    });
    expect(aborted).toMatchObject({ ok: false, error: { code: "membership_write_failed" } });
    expect(count()).toBe(1);

    const saved = commitDomainTransaction(db, () => {
      insert.run("ok");
      return ok({ id: 1 });
    });
    expect(saved).toEqual({ ok: true, value: { id: 1 } });
    expect(count()).toBe(2);
    db.close();
  });
});
