#include <stdio.h>
#include <stdlib.h>

/* a block comment with ) ] } brackets that must be ignored */
struct Point { int x, y; };

// line comment ( [ { too — all ignored
int main(int argc, char **argv) {
    char *msg = "literal with ) ] } inside";
    char open = '{', close = '}';   /* char literals that are NOT brackets */
    int arr[3] = {1, 2, 3};
    /* the '<' and '>' below are operators — they must stay operators, not
       string delimiters, or the rest of the file gets swallowed */
    if (argc > 1 && arr[0] < 10) {
        printf("%c%c\n", open, close);
    }
    return 0;
}
