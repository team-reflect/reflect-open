//! The tables, views and columns of the index, as sea-query identifiers.
//! A test compares them with the migrated schema.

use sea_query::Iden;

macro_rules! tables {
    ($( $(#[$meta:meta])* $name:ident { $($(#[$column_meta:meta])* $column:ident),* $(,)? } )*) => {
        $(
            $(#[$meta])*
            #[derive(Iden, Clone, Copy, Debug)]
            #[allow(dead_code)]
            pub(crate) enum $name {
                Table,
                $($(#[$column_meta])* $column),*
            }
        )*

        /// The name and the columns of every declared table.
        #[cfg(test)]
        pub(crate) fn declared() -> Vec<(String, Vec<String>)> {
            vec![$((
                $name::Table.to_string(),
                vec![$($name::$column.to_string()),*],
            )),*]
        }
    };
}

tables! {
    Aliases { NotePath, Alias, AliasKey }
    Assets { NotePath, AssetPath }
    /// A view: each link with the note that its target resolves to.
    Backlinks { TargetPath, SourcePath, Kind, TargetRaw, Alias, PosFrom, PosTo }
    ChatConversations { Id, Title, CreatedMs, UpdatedMs }
    ChatMessages {
        Id, ConversationId, Seq, UserText, Attachments, Parts, ResponseMessages, CreatedMs,
    }
    EmbeddingChunks { Id, NotePath, Heading, PosFrom, PosTo, Text, ContentHash, ModelId }
    /// A `vec0` table. `Distance` and `K` are its hidden query columns.
    EmbeddingVectors { Rowid, Embedding, Distance, K }
    IndexMeta { Key, Value }
    Links { SourcePath, Kind, TargetRaw, TargetKey, Alias, PosFrom, PosTo, TargetPathKey }
    NoteClaims { NotePath, Key, Tier }
    NoteEmails { NotePath, Email, EmailKey }
    /// A view: the note that wins each wiki key.
    NoteKeys { NotePath, Key, ClaimCount }
    Notes {
        Path, Id, Title, TitleKey, DailyDate, IsPrivate, FileHash, Mtime, UpdatedAt, IsPinned,
        PinnedOrder, Preview, HasConflict, GistUrl, GistStale, Kind, PathKey, HasContent,
    }
    /// An FTS5 table. `Fts` is the hidden column with the name of the table,
    /// which `MATCH` and the FTS5 functions take; `Rank` is the hidden rank
    /// column.
    SearchFts { Path, Title, Body, #[iden = "search_fts"] Fts, Rank }
    Tags { NotePath, Tag, TagKey }
    Tasks { NotePath, AstPath, Markdown, Checked, DueDate, Breadcrumbs }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use crate::connections::{migrate, open_in_memory};

    /// Every declared table has exactly the columns of the migrated schema,
    /// and every table of the schema is declared.
    #[test]
    fn identifiers_match_the_migrated_schema() {
        let mut conn = open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let declared = super::declared();

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
