/**
 * registry_hook.c — XRPL Hook installed on the regulator's account.
 *
 * Responsibilities:
 *   REGISTER_ORACLE  — write oracle pubkey, timestamp, and initial reputation
 *                      into namespace state. Only accepted from the regulator.
 *   COMMIT_COMMITTEE — write ordered committee pubkeys for a given period_seq
 *                      into namespace state (chunked, ≤4 keys per chunk).
 *                      Only accepted from the regulator.
 *   REPUTATION_UPDATE — update oracle reputation scores based on vote outcome.
 *                       Accepted from any account (emitted by compliance hook).
 *                       Only processed if transaction carries sfEmitDetails,
 *                       guaranteeing it is a Hook-emitted transaction and cannot
 *                       be forged by a regular user submission.
 *
 * Namespace state layouts:
 *
 *   Oracle registration:
 *     key   = ed25519 pubkey (32 bytes verbatim)
 *     value = u32be(ledger_seq) || i32be(reputation_score)  (8 bytes)
 *
 *   Committee chunk:
 *     key   = sha512h("COMMITTEE" || u32be(period_seq) || u8(chunk))  (32 bytes)
 *     value = up to 4 × 32-byte ed25519 pubkeys (max 128 bytes per entry)
 *
 * Hook parameters:
 *   "REGULATOR" (9 bytes) → 20-byte AccountID of the regulator.
 *
 * Memo types and data layouts:
 *
 *   REGISTER_ORACLE (15 bytes memo type):
 *     memo data = ed25519 pubkey (32 bytes)
 *
 *   COMMIT_COMMITTEE (16 bytes memo type):
 *     memo data = u32be(period_seq) || pubkey[0..K-1]  (4 + K×32 bytes)
 *     Chunks are written automatically (≤4 keys per chunk).
 *
 *   REPU (4 bytes memo type — emitted by compliance hook):
 *     memo data = outcome(1) | vote_count(1) | (pubkey32|vote1)[vote_count]
 *       outcome: 0x01 = compliant, 0x00 = non-compliant
 *       vote:    0x01 = compliant vote, 0x00 = non-compliant vote
 *     Reputation delta = +1 if oracle vote == outcome, else -1.
 */

#include <hookapi.h>

/* ── transaction type ─────────────────────────────────────────────────────── */
#define ttPAYMENT 0

/* ── vote/outcome values ──────────────────────────────────────────────────── */
#define VOTE_COMPLIANT     0x01
#define VOTE_NON_COMPLIANT 0x00

/* ── committee chunking ───────────────────────────────────────────────────── */
#define PUBKEYS_PER_CHUNK   4
#define MAX_K              16
#define MAX_CHUNKS         ((MAX_K + PUBKEYS_PER_CHUNK - 1) / PUBKEYS_PER_CHUNK)

/* ── hook parameter key lengths ───────────────────────────────────────────── */
#define HP_REGULATOR_LEN   9

/* ── memo type lengths ────────────────────────────────────────────────────── */
#define MT_REGISTER_LEN   15   /* "REGISTER_ORACLE" */
#define MT_COMMIT_LEN     16   /* "COMMIT_COMMITTEE" */
#define MT_REPU_LEN        4   /* "REPU" */
#define MT_CANCEL_LEN     15   /* "CANCEL_TEMPLATE" */

/* ── reputation update entry size ────────────────────────────────────────── */
#define REP_ENTRY_SIZE    33   /* pubkey(32) + vote(1) */

/* ─────────────────────────── helpers ────────────────────────────────────── */

static uint32_t u32be(const uint8_t *b)
{
    return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16)
         | ((uint32_t)b[2] <<  8) |  (uint32_t)b[3];
}

static void put_u32be(uint8_t *b, uint32_t v)
{
    b[0] = (v >> 24) & 0xff; b[1] = (v >> 16) & 0xff;
    b[2] = (v >>  8) & 0xff; b[3] =  v        & 0xff;
}

/* ── cancel template key ─────────────────────────────────────────────────── */
/* key = sha512h("CANCELLED" || u32be(template_id))  (32 bytes) */
static void cancel_template_key(uint8_t out[32], uint32_t template_id)
{
    uint8_t inp[13];
    inp[0]='C'; inp[1]='A'; inp[2]='N'; inp[3]='C'; inp[4]='E';
    inp[5]='L'; inp[6]='L'; inp[7]='E'; inp[8]='D';
    put_u32be(inp + 9, template_id);
    util_sha512h((uint32_t)out, 32, (uint32_t)inp, 13);
}

/* ── committee chunk key ─────────────────────────────────────────────────── */
static void committee_key(uint8_t out[32], uint32_t period_seq, uint8_t chunk)
{
    uint8_t inp[14];
    inp[0]='C'; inp[1]='O'; inp[2]='M'; inp[3]='M'; inp[4]='I';
    inp[5]='T'; inp[6]='T'; inp[7]='E'; inp[8]='E';
    put_u32be(inp + 9, period_seq);
    inp[13] = chunk;
    util_sha512h((uint32_t)out, 32, (uint32_t)inp, 14);
}

/* ── check if transaction has sfEmitDetails (i.e. is an emitted tx) ─────── */
/* sfEmitDetails = STObject type 14, field 20                                */
/* Encoding: type=14 ≤ 14, field=20 > 14 → {(14<<4)|0, 20} = {0xE0, 0x14}  */
/* We use otxn_field with the encoded field constant.                         */
/* In hookapi.h, sfEmitDetails = ((14U << 16U) | 20U) = 0xE0014             */
#ifndef sfEmitDetails
#  define sfEmitDetails ((14U << 16U) | 20U)
#endif

static int tx_is_emitted(void)
{
    uint8_t ed_buf[4];   /* we only need to know if the field exists */
    return otxn_field(SBUF(ed_buf), sfEmitDetails) >= 0;
}

/* ─────────────────────────────── hook() ────────────────────────────────── */

int64_t hook(uint32_t reserved)
{
    TRACESTR("registry_hook: fired");

    /* Only handle Payment transactions. */
    if (otxn_type() != ttPAYMENT)
        ACCEPT("registry_hook: not a payment", 0);

    /* ── Read hook account (regulator) ──────────────────────────────────── */
    uint8_t hook_acc[20];
    hook_account(SBUF(hook_acc));

    /* ── Destination must be the regulator's own account ─────────────────── */
    uint8_t dest[20];
    if (otxn_field(SBUF(dest), sfDestination) != 20)
        ACCEPT("registry_hook: no destination", 0);
    if (!BUFFER_EQUAL_20(hook_acc, dest))
        ACCEPT("registry_hook: not addressed to regulator", 0);

    /* ── Read sender ─────────────────────────────────────────────────────── */
    uint8_t sender[20];
    if (otxn_field(SBUF(sender), sfAccount) != 20)
        ACCEPT("registry_hook: no account field", 0);

    int sender_is_regulator = BUFFER_EQUAL_20(hook_acc, sender);

    /* ── Read memo type ──────────────────────────────────────────────────── */
    uint8_t mt[32];
    int64_t mt_len = memo_type(SBUF(mt), 0);
    if (mt_len < 0)
        ACCEPT("registry_hook: no memo, ignoring", 0);

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  REGISTER_ORACLE path                                                   */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_REGISTER_LEN
        && mt[0]=='R' && mt[1]=='E' && mt[2]=='G' && mt[3]=='I'
        && mt[4]=='S' && mt[5]=='T' && mt[6]=='E' && mt[7]=='R'
        && mt[8]=='_' && mt[9]=='O' && mt[10]=='R' && mt[11]=='A'
        && mt[12]=='C' && mt[13]=='L' && mt[14]=='E')
    {
        TRACESTR("registry_hook: REGISTER_ORACLE");

        if (!sender_is_regulator)
            ROLLBACK("registry_hook: only regulator may register oracles", 40);

        /* Memo data = ed25519 pubkey (32 bytes). */
        uint8_t pubkey[32];
        int64_t md_len = memo_data(SBUF(pubkey), 0);
        if (md_len != 32)
            ROLLBACK("registry_hook: REGISTER_ORACLE memo data must be 32 bytes", 41);

        /* Registration value: u32be(timestamp) || i32be(reputation=0) */
        uint8_t reg_val[8];
        put_u32be(reg_val,     (uint32_t)ledger_seq());
        put_u32be(reg_val + 4, 0);  /* reputation = 0 */

        state_set(SBUF(reg_val), SBUF(pubkey));

        ACCEPT("registry_hook: oracle registered", 0);
    }

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  COMMIT_COMMITTEE path                                                  */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_COMMIT_LEN
        && mt[0]=='C' && mt[1]=='O' && mt[2]=='M' && mt[3]=='M'
        && mt[4]=='I' && mt[5]=='T' && mt[6]=='_'
        && mt[7]=='C' && mt[8]=='O' && mt[9]=='M' && mt[10]=='M'
        && mt[11]=='I' && mt[12]=='T' && mt[13]=='T' && mt[14]=='E' && mt[15]=='E')
    {
        TRACESTR("registry_hook: COMMIT_COMMITTEE");

        if (!sender_is_regulator)
            ROLLBACK("registry_hook: only regulator may commit committee", 50);

        /* Memo data: u32be(period_seq) || pubkey[0..K-1] */
        uint8_t md[4 + MAX_K * 32];
        int64_t md_len = memo_data(SBUF(md), 0);
        if (md_len < (int64_t)(4 + 32))
            ROLLBACK("registry_hook: COMMIT_COMMITTEE memo too short", 51);

        uint32_t period_seq = u32be(md);
        int num_keys = (int)((md_len - 4) / 32);
        if (num_keys < 1 || num_keys > MAX_K)
            ROLLBACK("registry_hook: committee size out of range", 52);

        const uint8_t *keys = md + 4;

        /* Write in chunks of PUBKEYS_PER_CHUNK. */
        int written = 0;
        for (uint8_t chunk = 0; written < num_keys; chunk++) {
            int in_chunk = num_keys - written;
            if (in_chunk > PUBKEYS_PER_CHUNK) in_chunk = PUBKEYS_PER_CHUNK;

            uint8_t ckey[32];
            committee_key(ckey, period_seq, chunk);

            uint8_t chunk_val[PUBKEYS_PER_CHUNK * 32];
            for (int i = 0; i < in_chunk * 32; i++)
                chunk_val[i] = keys[written * 32 + i];

            state_set((uint32_t)chunk_val, (uint32_t)(in_chunk * 32),
                      SBUF(ckey));
            written += in_chunk;
        }

        ACCEPT("registry_hook: committee committed", 0);
    }

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  REPUTATION_UPDATE path (emitted by compliance hook)                   */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_REPU_LEN
        && mt[0]=='R' && mt[1]=='E' && mt[2]=='P' && mt[3]=='U')
    {
        TRACESTR("registry_hook: REPUTATION_UPDATE");

        /* Security: only accept emitted transactions (not user-submitted). */
        if (!tx_is_emitted())
            ROLLBACK("registry_hook: REPU must be emitted by compliance hook", 60);

        /* Memo data: outcome(1) | vote_count(1) | (pubkey32|vote1)[] */
        uint8_t md[2 + MAX_K * REP_ENTRY_SIZE];
        int64_t md_len = memo_data(SBUF(md), 0);
        if (md_len < 2)
            ROLLBACK("registry_hook: REPU memo too short", 61);

        uint8_t outcome    = md[0];
        uint8_t vote_count = md[1];
        if (vote_count == 0 || vote_count > MAX_K)
            ROLLBACK("registry_hook: invalid vote_count in REPU", 62);

        if ((int64_t)md_len < (int64_t)(2 + (int)vote_count * REP_ENTRY_SIZE))
            ROLLBACK("registry_hook: REPU memo truncated", 63);

        const uint8_t *entries = md + 2;

        for (int ei = 0; ei < (int)vote_count; ei++) {
            const uint8_t *pubkey = entries + ei * REP_ENTRY_SIZE;
            uint8_t         vote  = entries[ei * REP_ENTRY_SIZE + 32];

            /* Read existing registration entry. */
            uint8_t reg_val[8];
            int64_t rv = state(SBUF(reg_val), SBUF(pubkey));
            if (rv != 8)
                continue;   /* Oracle not registered; skip silently. */

            /* Compute reputation delta. */
            int32_t rep = (int32_t)u32be(reg_val + 4);
            if (vote == outcome) rep += 1;
            else                 rep -= 1;

            /* Write updated value (preserve timestamp). */
            put_u32be(reg_val + 4, (uint32_t)rep);
            state_set(SBUF(reg_val), SBUF(pubkey));
        }

        ACCEPT("registry_hook: reputation updated", 0);
    }

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  CANCEL_TEMPLATE path                                                   */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_CANCEL_LEN
        && mt[0]=='C' && mt[1]=='A' && mt[2]=='N' && mt[3]=='C'
        && mt[4]=='E' && mt[5]=='L' && mt[6]=='_'
        && mt[7]=='T' && mt[8]=='E' && mt[9]=='M' && mt[10]=='P'
        && mt[11]=='L' && mt[12]=='A' && mt[13]=='T' && mt[14]=='E')
    {
        TRACESTR("registry_hook: CANCEL_TEMPLATE");

        if (!sender_is_regulator)
            ROLLBACK("registry_hook: only regulator may cancel templates", 70);

        /* Memo data: u32be(template_id) — exactly 4 bytes. */
        uint8_t md[4];
        int64_t md_len = memo_data(SBUF(md), 0);
        if (md_len != 4)
            ROLLBACK("registry_hook: CANCEL_TEMPLATE memo data must be 4 bytes", 71);

        uint32_t tpl_id = u32be(md);

        uint8_t ckey[32];
        cancel_template_key(ckey, tpl_id);

        uint8_t cancelled = 0x01;
        state_set((uint32_t)&cancelled, 1, SBUF(ckey));

        ACCEPT("registry_hook: template cancelled", 0);
    }

    ACCEPT("registry_hook: unrecognized memo type, ignoring", 0);
    return 0;
}
