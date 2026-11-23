//! The tables, views and columns of the index, as sea-query identifiers.
//! The first variant of each enum is the table; the others are its columns.
//! A test compares them with the migrated schema.

use sea_query::Iden;
#[cfg(test)]
use strum::EnumIter;

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Aliases {
    Table,
    NotePath,
    Alias,
    AliasKey,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Assets {
    Table,
    NotePath,
    AssetPath,
}

/// A view: each link with the note that its target resolves to.
#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Backlinks {
    Table,
    TargetPath,
    SourcePath,
    Kind,
    TargetRaw,
    Alias,
    PosFrom,
    PosTo,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum ChatConversations {
    Table,
    Id,
    Title,
    CreatedMs,
    UpdatedMs,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum ChatMessages {
    Table,
    Id,
    ConversationId,
    Seq,
    UserText,
    Attachments,
    Parts,
    ResponseMessages,
    CreatedMs,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum EmbeddingChunks {
    Table,
    Id,
    NotePath,
    Heading,
    PosFrom,
    PosTo,
    Text,
    ContentHash,
    ModelId,
}

/// A `vec0` table. `Distance` and `K` are its hidden query columns.
#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum EmbeddingVectors {
    Table,
    Rowid,
    Embedding,
    Distance,
    K,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum IndexMeta {
    Table,
    Key,
    Value,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Links {
    Table,
    SourcePath,
    Kind,
    TargetRaw,
    TargetKey,
    Alias,
    PosFrom,
    PosTo,
    TargetPathKey,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum NoteClaims {
    Table,
    NotePath,
    Key,
    Tier,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum NoteEmails {
    Table,
    NotePath,
    Email,
    EmailKey,
}

/// A view: the note that wins each wiki key.
#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum NoteKeys {
    Table,
    NotePath,
    Key,
    ClaimCount,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum NoteVisits {
    Table,
    Path,
    VisitedMs,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Notes {
    Table,
    Path,
    Id,
    Title,
    TitleKey,
    DailyDate,
    IsPrivate,
    FileHash,
    // TODO: it seems that "Mtime" and "UpdatedAt" store the same value, so we probably
    // don't need both. Revalue this in the future because it needs to migrate the database.
    Mtime,
    UpdatedAt,
    IsPinned,
    PinnedOrder,
    Preview,
    HasConflict,
    GistUrl,
    GistStale,
    Kind,
    PathKey,
    HasContent,
}

/// An FTS5 table. `Fts` is the hidden column with the name of the table,
/// which `MATCH` and the FTS5 functions take; `Rank` is the hidden rank
/// column.
#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum SearchFts {
    Table,
    Path,
    Title,
    Body,
    #[iden = "search_fts"]
    Fts,
    Rank,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Tags {
    Table,
    NotePath,
    Tag,
    TagKey,
}

#[derive(Iden, Clone, Copy, Debug)]
#[cfg_attr(test, derive(EnumIter))]
#[allow(dead_code)]
pub(crate) enum Tasks {
    Table,
    NotePath,
    AstPath,
    Markdown,
    Checked,
    DueDate,
    Breadcrumbs,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use sea_query::Iden;
    use strum::IntoEnumIterator;

    use super::*;
    use crate::connections::{migrate, open_in_memory};

    /// The name and the columns of a table enum, whose first variant is the
    /// table.
    fn describe<T: Iden + IntoEnumIterator>() -> (String, Vec<String>) {
        let mut variants = T::iter().map(|variant| variant.to_string());
        let table = variants.next().unwrap();
        (table, variants.collect())
    }

    /// The name and the columns of every declared table.
    fn declared() -> Vec<(String, Vec<String>)> {
        vec![
            describe::<Aliases>(),
            describe::<Assets>(),
            describe::<Backlinks>(),
            describe::<ChatConversations>(),
            describe::<ChatMessages>(),
            describe::<EmbeddingChunks>(),
            describe::<EmbeddingVectors>(),
            describe::<IndexMeta>(),
            describe::<Links>(),
            describe::<NoteClaims>(),
            describe::<NoteEmails>(),
            describe::<NoteKeys>(),
            describe::<NoteVisits>(),
            describe::<Notes>(),
            describe::<SearchFts>(),
            describe::<Tags>(),
            describe::<Tasks>(),
        ]
    }

    /// Every declared table has exactly the columns of the migrated schema,
    /// and every table of the schema is declared.
    #[test]
    fn identifiers_match_the_migrated_schema() {
        let mut conn = open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let declared = declared();

        for (table, columns) in &declared {
            let actual: BTreeSet<String> = conn
                .prepare("SELECT name FROM pragma_table_xinfo(?1)")
                .unwrap()
                .query_map([table], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let expected: BTreeSet<String> = columns.iter().cloned().collect();
            assert_eq!(expected, actual, "the columns of `{table}`");
        }

        // The shadow tables of the virtual tables are not part of the schema.
        let actual: BTreeSet<String> = conn
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                   AND name NOT LIKE 'search_fts_%' AND name NOT LIKE 'embedding_vectors_%'",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let expected: BTreeSet<String> = declared.into_iter().map(|(table, _)| table).collect();
        assert_eq!(expected, actual);
    }
}
