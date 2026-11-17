//! Runs one read-only SQL statement and returns its rows as JSON objects, for
//! tests and for the `test_query` command of the wasm host.

use rusqlite::{Connection, params_from_iter};
use serde_json::{Map, Value};

use reflect_types::{AppError, AppResult};

fn json_to_sql(value: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as Sql;
    match value {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => n
            .as_i64()
            .map(Sql::Integer)
            .or_else(|| n.as_f64().map(Sql::Real))
            .unwrap_or(Sql::Null),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn column_to_json(row: &rusqlite::Row, index: usize) -> AppResult<Value> {
    use rusqlite::types::ValueRef;
    Ok(match row.get_ref(index)? {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => Value::from(bytes.to_vec()),
    })
}

/// Runs `sql` with bound `params` and returns each row as a JSON object. A
/// statement that writes is an error.
pub fn run_query(
    conn: &Connection,
    sql: &str,
    params: &[Value],
) -> AppResult<Vec<Map<String, Value>>> {
    let mut stmt = conn.prepare(sql)?;
    if !stmt.readonly() {
        return Err(AppError::io("the query must be a read-only statement"));
    }
    let columns: Vec<String> = stmt.column_names().map(str::to_owned).collect();
    let bound: Vec<rusqlite::types::Value> = params.iter().map(json_to_sql).collect();
    let mut rows = stmt.query(params_from_iter(bound))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut object = Map::with_capacity(columns.len());
        for (index, name) in columns.iter().enumerate() {
            object.insert(name.clone(), column_to_json(row, index)?);
        }
        out.push(object);
    }
    Ok(out)
}
