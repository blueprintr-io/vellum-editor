#[cfg(test)]
mod tests {
    use glib::{variant::ToVariant, Variant};

    fn strings() -> Variant {
        ["zero", "one", "two", "three", "four", "five"].to_variant()
    }

    #[test]
    fn forward_and_reverse_iteration_return_valid_strings() {
        let value = strings();
        let mut iter = value.array_iter_str().unwrap();
        assert_eq!(iter.next(), Some("zero"));
        assert_eq!(iter.next_back(), Some("five"));
        assert_eq!(iter.collect::<Vec<_>>(), ["one", "two", "three", "four"]);
    }

    #[test]
    fn skipping_from_both_ends_preserves_the_remaining_range() {
        let value = strings();
        let mut iter = value.array_iter_str().unwrap();
        assert_eq!(iter.nth(1), Some("one"));
        assert_eq!(iter.nth_back(1), Some("four"));
        assert_eq!(iter.collect::<Vec<_>>(), ["two", "three"]);
    }

    #[test]
    fn last_returns_a_valid_borrowed_string() {
        let value = strings();
        assert_eq!(value.array_iter_str().unwrap().last(), Some("five"));
        let empty = Vec::<String>::new().to_variant();
        assert_eq!(empty.array_iter_str().unwrap().last(), None);
    }
}
