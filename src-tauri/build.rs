fn main() {
    // Asset discovery cannot track files absent during macro expansion.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
