//! The merge that always has an answer: the ladder's last rule. Any
//! `(base, first, second)` in, one marker-free text out, by
//! `reconcile-text`'s word-level operational merge. Overlapping edits come
//! out interleaved rather than marked, so callers archive both sides before
//! they write the result; disjoint edits merge the way a three-way merge
//! would.

use reconcile_text::{reconcile, BuiltinTokenizer};

/// Merge `first` and `second` over `base`. Symmetric by construction: the
/// sides are ordered by content before the library sees them. The trivial
/// shapes (identical sides, one side untouched) return the other side
/// unchanged without touching the library.
#[cfg_attr(not(test), expect(dead_code))]
pub(super) fn merge(base: &str, first: &str, second: &str) -> String {
    if first == second || second == base {
        return first.to_string();
    }
    if first == base {
        return second.to_string();
    }
    let (a, b) = if first <= second {
        (first, second)
    } else {
        (second, first)
    };
    reconcile(base, &a.into(), &b.into(), &*BuiltinTokenizer::Word)
        .apply()
        .text()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::merge;
    use proptest::prelude::*;

    /// The probe cases behind the design: the first group is the same change
    /// arriving twice (a stale base), the second is two genuinely different
    /// edits. Outputs are pinned byte for byte, imperfect ones included, so an
    /// upgrade of the library shows exactly what it changed.
    #[test]
    fn fixed_cases_are_pinned() {
        let cases: &[(&str, &str, &str, &str, &str)] = &[
            (
                "A1 X twice, local edit elsewhere",
                "- a\n- b\n",
                "- a (edited here)\n- b\n- X\n",
                "- a\n- b\n- X\n",
                "- a (edited here)\n- b\n- X\n",
            ),
            (
                "A2 X twice, local edit on the line before X",
                "- a\n- b\n",
                "- a\n- b (edited here)\n- X\n",
                "- a\n- b\n- X\n",
                "- a\n- b\n- X (edited here)\n- X\n",
            ),
            (
                "A3 X twice, local appended Y after X",
                "- a\n",
                "- a\n- X\n- Y\n",
                "- a\n- X\n",
                "- a\n- X\n- Y\n",
            ),
            (
                "A4 X twice, local appended Y before X",
                "- a\n",
                "- a\n- Y\n- X\n",
                "- a\n- X\n",
                "- a\n- X Y\n- X\n",
            ),
            (
                "A5 X twice inside a paragraph",
                "The meeting was long.\n",
                "The weekly meeting was short.\n",
                "The meeting was short.\n",
                "The weekly meeting was short.\n",
            ),
            (
                "A6 a merged result merged again with one side",
                "# D\n\n- run\n- wrote the plan\n",
                "# D\n\n- run\n- wrote the sync plan\n- 14:02 API\n",
                "# D\n\n- run\n- wrote the plan\n- 14:02 API\n",
                "# D\n\n- run\n- wrote the sync plan\n- 14:02 API\n",
            ),
            (
                "B1 both append different bullets",
                "# D\n\n- run\n",
                "# D\n\n- run\n- call Alex\n",
                "# D\n\n- run\n- buy milk\n",
                "# D\n\n- run\n- buy milk call Alex\n",
            ),
            (
                "B2 same word changed differently",
                "Merging text is hard!\n",
                "Merging text is easy!\n",
                "Merging text is trivial!\n",
                "Merging text is easy! trivial!\n",
            ),
            (
                "B3 delete vs edit",
                "Intro.\n\nThis paragraph is doomed.\n\nOutro.\n",
                "Intro.\n\nOutro.\n",
                "Intro.\n\nThis paragraph is doomed, but edited.\n\nOutro.\n",
                "Intro. doomed, but edited.\n\nOutro.\n",
            ),
            (
                "B4 same paragraph, different words",
                "The meeting was long and the outcome was unclear.\n",
                "The meeting was short and the outcome was unclear.\n",
                "The meeting was long and the outcome was obvious.\n",
                "The meeting was short and the outcome was obvious.\n",
            ),
            (
                "B5 task toggled plus text edit",
                "- [ ] ship the release\n",
                "- [x] ship the release\n",
                "- [ ] ship the 1.2 release\n",
                "- [x] ship the 1.2 release\n",
            ),
            (
                "B6 both rewrite the same sentence",
                "The quick brown fox jumps over the lazy dog.\n",
                "A fast auburn fox leaps over a sleepy hound.\n",
                "The speedy brown fox hops over the idle dog.\n",
                " speedyA fast auburn fox leaps hops over idle a sleepy hound.\n",
            ),
            (
                "B7 frontmatter keys",
                "---\ntitle: Old\ntags: [a]\n---\n\n# Old\n",
                "---\ntitle: New\ntags: [a]\n---\n\n# New\n",
                "---\ntitle: Old\ntags: [a, b]\n---\n\n# Old\n",
                "---\ntitle: New\ntags: [a, b]\n---\n\n# New\n",
            ),
            (
                "B8 fold marker plus external append",
                "- a\n  - child\n- b\n",
                "+ a\n  - child\n- b\n",
                "- a\n  - child\n- b\n- appended\n",
                "+ a\n  - child\n- b\n- appended\n",
            ),
            ("E1 no base", "", "mine\n", "theirs\n", "mine\ntheirs\n"),
        ];
        for (name, base, left, right, want) in cases {
            assert_eq!(merge(base, left, right), *want, "{name}");
            assert_eq!(merge(base, right, left), *want, "{name} (swapped)");
        }
    }

    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_string).collect()
    }

    /// Random notes: a few lines over a small vocabulary, then one to three
    /// edits per side (append a word to a line, insert a line, drop a line).
    fn note() -> impl Strategy<Value = Vec<String>> {
        let line = prop::collection::vec(
            prop::sample::select(vec![
                "alpha", "beta", "gamma", "- item", "# head", "x", "[[link]]", "**b**",
            ]),
            1..5,
        )
        .prop_map(|words| words.join(" "));
        prop::collection::vec(line, 1..6)
    }

    fn edited(base: &[String]) -> impl Strategy<Value = Vec<String>> {
        let base = base.to_vec();
        prop::collection::vec((0..3u8, 0..8usize, 0..9u8), 1..4).prop_map(move |edits| {
            let mut out = base.clone();
            for (kind, at, n) in edits {
                match kind {
                    0 if !out.is_empty() => {
                        let i = at % out.len();
                        out[i] = format!("{} edited{n}", out[i]);
                    }
                    1 => out.insert(at % (out.len() + 1), format!("new{n}")),
                    _ if out.len() > 1 => {
                        out.remove(at % out.len());
                    }
                    _ => {}
                }
            }
            out
        })
    }

    fn triple() -> impl Strategy<Value = (String, String, String)> {
        note().prop_flat_map(|base| {
            (edited(&base), edited(&base)).prop_map(move |(left, right)| {
                (
                    base.join("\n") + "\n",
                    left.join("\n") + "\n",
                    right.join("\n") + "\n",
                )
            })
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        #[test]
        fn total_symmetric_and_trivial((base, left, right) in triple()) {
            let out = merge(&base, &left, &right);
            prop_assert!(!out.contains("<<<<<<< "), "{out:?}");
            prop_assert_eq!(&out, &merge(&base, &right, &left));
            prop_assert_eq!(merge(&base, &base, &right), right.clone());
            prop_assert_eq!(merge(&base, &left, &left), left.clone());
        }

        #[test]
        fn nothing_either_side_added_is_lost((base, left, right) in triple()) {
            let out = merge(&base, &left, &right);
            let had = words(&base);
            for word in words(&left).into_iter().chain(words(&right)) {
                if !had.contains(&word) {
                    prop_assert!(out.contains(&word), "{word:?} missing from {out:?}");
                }
            }
        }
    }
}
