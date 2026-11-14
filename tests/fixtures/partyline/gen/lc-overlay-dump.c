/*
 * Writes lc68-overlays-c.txt: the LIVECHAT68 C engine (amiexpress-web sdk/c) drawing each overlay over the
 * main screen state of test_livechat_ui.c, cell for cell. tests/partyline-ui-overlays.test.ts compares the hub
 * engine against it. Rebuild from amiexpress-web/sdk/c:
 *   cc -std=c99 -Iinclude -Iexamples/livechat src/ui_cells.c src/ui_canvas.c src/ui_paint.c src/ui_ansi.c \
 *      src/ui_theme.c examples/livechat/livechat_ui.c <doorserver>/tests/fixtures/partyline/gen/lc-overlay-dump.c \
 *      -o /tmp/lc-dump && /tmp/lc-dump > <doorserver>/tests/fixtures/partyline/lc68-overlays-c.txt
 * Format: "CASE name cols rows caretRow caretCol", then one line per row of cell words
 * (ch | fg<<8 | bg<<16 | flags<<24, hex), a run written word*count.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ui_cells.h"
#include "livechat_ui.h"

static void add_line(lc_model *m, int kind, const char *time, const char *nick, const char *text)
{
    lc_line *l = &m->lines[m->nlines++];
    memset(l, 0, sizeof *l);
    l->kind = kind;
    strncpy(l->time, time, sizeof l->time - 1);
    strncpy(l->nick, nick, sizeof l->nick - 1);
    strncpy(l->text, text, sizeof l->text - 1);
    lc_lines_changed(m);
}
static void add_side(lc_model *m, int kind, int joined, const char *label)
{
    lc_side *s = &m->side[m->nside++];
    memset(s, 0, sizeof *s);
    s->kind = kind; s->joined = joined; s->open = kind == LC_SIDE_ROOM && joined;
    strncpy(s->label, label, sizeof s->label - 1);
}
static void main_state(lc_model *m, int cols, int rows)
{
    lc_model_init(m, cols, rows);
    m->focus = -1;
    strcpy(m->handle, "Guest"); strcpy(m->room, "general"); strcpy(m->pane_label, "general - General chat");
    add_side(m, LC_SIDE_HEAD, 0, "TEXT CHANNELS"); add_side(m, LC_SIDE_ROOM, 1, "general");
    add_side(m, LC_SIDE_USER, 0, "carol"); add_side(m, LC_SIDE_ROOM, 0, "amiga"); add_side(m, LC_SIDE_ROOM, 0, "secret");
    m->side_sel = 1;
    add_line(m, LC_SYSTEM, "", "", "Found 3 rooms");
    add_line(m, LC_HISTORY, "11:01", "alice", "hello world");
    add_line(m, LC_LIVE, "17:03", "bob", "nice **bold** and :D");
}

static void dump(const char *name, lc_model *m)
{
    ui_cells c; int cr = 0, cc = 0, r, k;
    ui_cells_open(&c, m->cols, m->rows);
    lc_draw(&c, m, &cr, &cc);
    printf("CASE %s %d %d %d %d\n", name, m->cols, m->rows, cr, cc);
    for (r = 0; r < m->rows; r++) {
        unsigned long prev = 0; int n = 0;
        for (k = 0; k <= m->cols; k++) {
            unsigned long w = 0;
            if (k < m->cols) { ui_cell *x = &c.back[r * m->cols + k];
                w = (unsigned long)x->ch | ((unsigned long)x->fg << 8) | ((unsigned long)x->bg << 16) | ((unsigned long)x->flags << 24); }
            if (n > 0 && (k == m->cols || w != prev)) { printf(n > 1 ? "%lx*%d " : "%lx ", prev, n); n = 0; }
            prev = w; n++;
        }
        printf("\n");
    }
    ui_cells_close(&c);
}

int main(void)
{
    static const int size[3][2] = { { 80, 25 }, { 80, 15 }, { 40, 25 } };
    lc_model *m = (lc_model *)malloc(sizeof *m);
    char name[64]; int s;
    for (s = 0; s < 3; s++) {
        int W = size[s][0], H = size[s][1];
#define CASE(tag, setup) do { main_state(m, W, H); setup; sprintf(name, "%s-%dx%d", tag, W, H); dump(name, m); } while (0)
        CASE("help", m->help = 1);
        CASE("help-scrolled", (m->help = 1, m->help_top = 12));
        CASE("view", (m->view = 1, strcpy(m->view_title, "Thread"), m->view_n = 3,
                      strcpy(m->view_text[0], "=alice 11:01"), strcpy(m->view_text[1], "hello world"), strcpy(m->view_text[2], "  bob: a reply")));
        CASE("modal-message", (m->modal = LC_MODAL_MESSAGE, strcpy(m->modal_title, "Error"), strcpy(m->modal_text, "Room not found")));
        CASE("modal-message-long", (m->modal = LC_MODAL_MESSAGE, strcpy(m->modal_title, "Error"),
             strcpy(m->modal_text, "This is a much longer message that has to wrap over more than one row of the box")));
        CASE("modal-quit", (m->modal = LC_MODAL_QUIT, strcpy(m->modal_title, "Quit"), strcpy(m->modal_text, "Leave the chat?")));
        CASE("modal-prompt", (m->modal = LC_MODAL_PROMPT, strcpy(m->modal_title, "Room name?"),
             strcpy(m->prompt, "a very long prompt answer that scrolls inside the field"), m->prompt_len = (int)strlen(m->prompt)));
        CASE("modal-reconnect", (m->modal = LC_MODAL_RECONNECT, strcpy(m->modal_text, "Retrying in 5s"), m->modal_attempt = 2, m->modal_max = 5));
        CASE("modal-progress", (m->modal = LC_MODAL_PROGRESS, strcpy(m->modal_text, "cat.iff"), m->up_received = 1536000L, m->up_total = 2097152L));
        CASE("modal-progress-unknown", (m->modal = LC_MODAL_PROGRESS, strcpy(m->modal_text, "dog.png"), m->up_received = 700, m->up_total = 0));
        CASE("search", (m->search = 1, m->search_field = 1, strcpy(m->search_q, "hello"), strcpy(m->search_user, "ali"),
             m->search_n = 3, m->search_sel = 1, strcpy(m->search_rows[0], "11:01 alice: hello world"),
             strcpy(m->search_rows[1], "12:00 alice: hello again"), strcpy(m->search_rows[2], "13:30 alice: hello hello")));
        CASE("settings", (m->settings = 1, m->settings_sel = 3, m->settings_val[0] = 1, m->settings_val[5] = 1, m->settings_val[7] = 1,
             m->settings_status = 2));
        CASE("settings-close", (m->settings = 1, m->settings_sel = LC_SET_CLOSE));
#define SLASH(text) (m->focus = LC_FOCUS_INPUT, strcpy(m->input, text), m->input_len = m->input_cur = (int)strlen(text))
        CASE("slash", SLASH("/"));
        CASE("slash-jo", SLASH("/jo"));
        CASE("slash-mute", (SLASH("/mute"), m->slash_sel = 1));
        CASE("slash-scrolled", (SLASH("/"), m->slash_sel = 12, m->slash_top = 2));
        CASE("slash-off", (SLASH("/"), m->slash_off = 1));
#undef SLASH
#undef CASE
    }
    free(m);
    return 0;
}
