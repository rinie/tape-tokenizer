/* A real-world "lousy include": an .inc fragment that is NOT a standalone,
   well-formed text file. It opens structure it expects the includer to close.
   Scanned as-written (no include expansion), its seams are visible — and they
   are warnings, not errors: the file simply isn't self-contained. */

#if defined(CONFIG_FEATURE_X)

void feature_x_init(void) {
    register_handler(&x_handler);
    /* note: no closing brace here, and no #endif — both seams cross the
       include boundary into whatever pulls this fragment in */
