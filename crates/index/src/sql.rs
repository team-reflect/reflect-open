//! Runs sea-query statements on a rusqlite connection.

use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{Connection, OptionalExtension, Row, ToSql, params_from_iter};
use sea_query::{
    Expr, Func, Iden, IntoIden, Query, QueryStatementWriter, SelectStatement, SqliteQueryBuilder,
    Value,
};

use reflect_types::{AppError, AppResult};

/// A value in the SQL text. SQLite matches a partial index only against a
/// value in the text, so a fixed value of the schema is never bound.
pub(crate) fn lit(value: impl Into<Value>) -> Expr {
    Expr::Constant(value.into())
}

/// A bound value of a statement.
struct Param(Value);

impl ToSql for Param {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        fn integer(value: Option<impl Into<i64>>) -> ValueRef<'static> {
            value.map_or(ValueRef::Null, |value| ValueRef::Integer(value.into()))
        }
        let value = match &self.0 {
            Value::Bool(value) => integer(*value),
            Value::TinyInt(value) => integer(*value),
            Value::SmallInt(value) => integer(*value),
            Value::Int(value) => integer(*value),
            Value::BigInt(value) => integer(*value),
            Value::TinyUnsigned(value) => integer(*value),
            Value::SmallUnsigned(value) => integer(*value),
            Value::Unsigned(value) => integer(*value),
            Value::BigUnsigned(Some(value)) => {
                let value = i64::try_from(*value)
                    .map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?;
                ValueRef::Integer(value)
            }
            Value::BigUnsigned(None) => ValueRef::Null,
            Value::Float(value) => {
                value.map_or(ValueRef::Null, |value| ValueRef::Real(value.into()))
            }
            Value::Double(value) => value.map_or(ValueRef::Null, ValueRef::Real),
            Value::String(value) => value
                .as_deref()
                .map_or(ValueRef::Null, |value| ValueRef::Text(value.as_bytes())),
            Value::Bytes(value) => value.as_deref().map_or(ValueRef::Null, ValueRef::Blob),
            Value::Char(Some(value)) => return Ok(ToSqlOutput::from(value.to_string())),
            Value::Char(None) => ValueRef::Null,
            Value::Enum(value) => {
                return Err(rusqlite::Error::ToSqlConversionFailure(
                    format!("an enum value has no SQLite form: {value:?}").into(),
                ));
            }
        };
        Ok(ToSqlOutput::Borrowed(value))
    }
}

/// The SQLite text of `statement` and its bound values, in placeholder
/// order.
fn build(statement: &impl QueryStatementWriter) -> (String, Vec<Param>) {
    let (sql, values) = statement.build(SqliteQueryBuilder);
    (sql, values.into_iter().map(Param).collect())
}

/// Every row of `statement`.
pub(crate) fn query<T, C: FromIterator<T>>(
    conn: &Connection,
    statement: &impl QueryStatementWriter,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<C> {
    let (sql, params) = build(statement);
    let rows = conn
        .prepare_cached(&sql)?
        .query_map(params_from_iter(params), map)?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// The first row of `statement`, when it has one.
pub(crate) fn query_optional<T>(
    conn: &Connection,
    statement: &impl QueryStatementWriter,
    map: impl FnOnce(&Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<Option<T>> {
    let (sql, params) = build(statement);
    Ok(conn
        .prepare_cached(&sql)?
        .query_row(params_from_iter(params), map)
        .optional()?)
}

/// The first row of `statement`. A statement with no row is an error.
pub(crate) fn query_one<T>(
    conn: &Connection,
    statement: &impl QueryStatementWriter,
    map: impl FnOnce(&Row<'_>) -> rusqlite::Result<T>,
) -> AppResult<T> {
    let (sql, params) = build(statement);
    Ok(conn
        .prepare_cached(&sql)?
        .query_row(params_from_iter(params), map)?)
}

/// The row id of a table, which no schema lists.
pub(crate) const ROWID: &str = "rowid";

/// The table that `json_each` returns.
#[derive(Iden, Clone, Copy)]
enum JsonEach {
    Table,
    Value,
}

/// The texts of `values` as rows, from one bound parameter: for
/// `column IN (...)` with a list of any length.
pub(crate) fn json_values(values: &[String]) -> AppResult<SelectStatement> {
    let json = serde_json::to_string(values).map_err(|err| AppError::io(err.to_string()))?;
    Ok(Query::select()
        .column(JsonEach::Value)
        .from_function(
            Func::cust(JsonEach::Table.into_iden()).arg(json),
            JsonEach::Table,
        )
        .take())
}
