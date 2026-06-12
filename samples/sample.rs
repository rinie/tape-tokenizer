// Rust lexical sample: raw strings (parameterised end), raw idents,
// nested comments, char literals vs lifetimes.
fn main() {
    let plain = r"raw \d+ (no escapes, brackets } ] stay inside)";
    let one = r#"has "quotes" and } ) ] inside"#;
    let deep = r##"even a "# stays inside"##;
    let raw_kw = r#match;
    /* nested /* block comments */ are one token */
    let ch = 'x';
    let esc = '\n';
    let lt: &'static str = "lifetime above, plain string here";
    println!("{} {} {}", one, deep, ch);
}
