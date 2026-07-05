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

// Keyword vocabulary sample: exercises every per-keyword mnemonic byte —
// direct JS-role reuse, role-grounded reuse (fn/self), free-letter mnemonics
// (mut/pub/struct), and the block-byte roles (impl/enum/trait/use/mod/match/
// loop/dyn/as/Self/ref/move/crate/extern/type/where).
pub struct Point {
    pub x: i32,
    mut y: i32,
}

pub trait Shape {
    fn area(&self) -> i32;
}

impl Shape for Point {
    fn area(&self) -> i32 {
        self.x * self.x
    }
}

enum Op {
    Add,
    Remove,
}

mod helpers {
    use crate::Op;

    pub fn describe(op: &dyn std::fmt::Debug, r: &Op) -> i32 {
        match r {
            Op::Add => 1,
            Op::Remove => 0,
        }
    }
}

fn generic<T>(items: Vec<T>) -> T
where
    T: Clone,
{
    let mut total = items[0].clone();
    for item in items {
        loop {
            break;
        }
    }
    let moved = move || total.clone();
    let casted = 3 as i64;
    moved()
}
