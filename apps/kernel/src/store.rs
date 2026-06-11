//! Storage seam — the `KernelStore` trait that abstracts the kernel's durable key/value +
//! relational state away from the Cloudflare-proprietary `worker::SqlStorage` surface.
//!
//! WHY THIS EXISTS (Tier-3, moat-deepening):
//! The kernel's durability (snapshot manifest, chunk store, W4 delta chain, E6 oplog, the
//! generation/epoch/committedCell meta) is the actual product. Today every one of those ~12
//! state.storage().sql() call sites in lib.rs binds DIRECTLY to Cloudflare Durable Object SQLite.
//! The stated portability goal (CF DO now, Rivet ActorCore later — see CLAUDE.md "Portability")
//! is only real if the persistence layer is an interface, not a hard dependency. This trait IS
//! that interface: a backend that can run `exec` statements, return serde-typed rows, and return
//! raw positional-value rows is ALL the kernel asks of its store. Porting to Rivet (or Postgres,
//! or an in-memory test double) becomes "write one impl of KernelStore", not "rewrite lib.rs".
//!
//! SEMANTICS-PRESERVING: this is a pure refactor. `DoSqlStore` is a thin pass-through over
//! `worker::SqlStorage` — every method forwards to the exact same `sql.exec(...)` / `.to_array()` /
//! `.raw()` call the call site used before, with the same SQL text, the same bindings, and the
//! same error propagation. No behavior, no query, no ordering, no transaction boundary changes.
//! `StoreValue` is a transparent re-export of `worker::SqlStorageValue` so raw-row consumers
//! (read_chunks / read_delta_chain) pattern-match exactly as they did against the concrete type.

use worker::{Result, SqlStorage, SqlStorageValue};

/// The positional SQL value type raw-row consumers pattern-match on. Re-exported from `worker`
/// so the CF backend incurs zero conversion; a non-CF backend maps its own values into this enum.
pub type StoreValue = SqlStorageValue;

/// The single durable-state interface the kernel depends on. Every persistence operation the
/// kernel performs (DDL, meta read/write, snapshot manifest/chunks/delta/oplog) is expressible as
/// one of these three shapes. A backend (CF DO SQLite today, Rivet/Postgres/test-double later)
/// implements this trait; lib.rs never names a CF-proprietary type again.
pub trait KernelStore {
    /// Execute a statement (DDL or write, or a read whose cursor is discarded). `bindings` are the
    /// positional `?` parameters. Mirrors `SqlStorage::exec(query, bindings).map(|_| ())`.
    fn exec(&self, query: &str, bindings: Option<Vec<StoreValue>>) -> Result<()>;

    /// Execute a statement, ignoring any error (the `let _ = sql.exec(...)` idempotent-DDL idiom,
    /// e.g. `ALTER TABLE ... ADD COLUMN` that may already exist). Never propagates.
    fn exec_ignore(&self, query: &str, bindings: Option<Vec<StoreValue>>) {
        let _ = self.exec(query, bindings);
    }

    /// Run a query and deserialize each row into `T` (serde row objects, keyed by column name).
    /// Mirrors `sql.exec(query, bindings)?.to_array::<T>()`.
    fn query_typed<T>(&self, query: &str, bindings: Option<Vec<StoreValue>>) -> Result<Vec<T>>
    where
        T: serde::de::DeserializeOwned;

    /// Run a query and return each row as a positional `Vec<StoreValue>` (no column names).
    /// Mirrors iterating `sql.exec(query, bindings)?.raw()`. Used by the chunk/delta blob readers.
    fn query_raw(
        &self,
        query: &str,
        bindings: Option<Vec<StoreValue>>,
    ) -> Result<Vec<Vec<StoreValue>>>;
}

/// Cloudflare Durable Object SQLite backend — the one concrete `KernelStore` today. A thin,
/// zero-cost pass-through: it is the ONLY place in the kernel that names `worker::SqlStorage`.
pub struct DoSqlStore {
    sql: SqlStorage,
}

impl DoSqlStore {
    pub fn new(sql: SqlStorage) -> Self {
        Self { sql }
    }
}

impl KernelStore for DoSqlStore {
    fn exec(&self, query: &str, bindings: Option<Vec<StoreValue>>) -> Result<()> {
        self.sql.exec(query, bindings).map(|_| ())
    }

    fn query_typed<T>(&self, query: &str, bindings: Option<Vec<StoreValue>>) -> Result<Vec<T>>
    where
        T: serde::de::DeserializeOwned,
    {
        self.sql.exec(query, bindings)?.to_array::<T>()
    }

    fn query_raw(
        &self,
        query: &str,
        bindings: Option<Vec<StoreValue>>,
    ) -> Result<Vec<Vec<StoreValue>>> {
        let cursor = self.sql.exec(query, bindings)?;
        let mut rows = Vec::new();
        for row in cursor.raw() {
            rows.push(row?);
        }
        Ok(rows)
    }
}
