/**
 * compliance_hook.c — XRPL Hook installed on the company's account.
 *
 * Responsibilities:
 *   LOCK_COLLATERAL  — record locked drops and open the compliance period.
 *   PROOF_SUBMISSION — verify Byzantine oracle consensus, emit fund release,
 *                      emit reputation-update to registry hook.
 *   Outgoing payment guard — reject spending while a period is active.
 *
 * Binary layouts (all integers big-endian):
 *   LOCK memo data  : period_seq(4)
 *   PROOF memo data : schema_version(1) | period_seq(4) | ledger_ts(4) |
 *                     vote_count(1) | VoteEntry[vote_count]
 *   VoteEntry       : pubkey(32) | vote(1) | sig(64)   = 97 bytes
 *   Oracle payload  : period_seq(4) | company_acct(20) | vote(1) | ledger_ts(4) = 29 bytes
 *
 * Namespace state keys (32 bytes, right zero-padded ASCII):
 *   "COLLATERAL_DROPS"  → u64 drops locked
 *   "PERIOD_SEQ"        → u32 current period sequence
 *   "PERIOD_LEDGER"     → u32 ledger_seq of the LOCK transaction
 *   "PERIOD_STATUS"     → u8  0=inactive 1=active 2=finalized
 *
 * Hook parameters (ASCII key → raw bytes value):
 *   "REGULATOR"   (9)  → 20-byte AccountID of registry hook account
 *   "CONTRACTOR"  (10) → 20-byte AccountID of contractor
 *   "SCHEMA_VER"  (10) → 1-byte expected schema version
 *   "M_THRESHOLD" (11) → 1-byte minimum votes for consensus
 *   "K_COMMITTEE" (11) → 1-byte committee size
 *   "COLLAT_DROPS"(12) → 8-byte expected collateral in drops
 *
 * Committee namespace key (in regulator account):
 *   key = sha512h("COMMITTEE" || u32be(period_seq) || u8(chunk))
 *   value = up to 4 × 32-byte pubkeys per chunk (max 128 bytes)
 */

#include <hookapi.h>

/* ── transaction type ─────────────────────────────────────────────────────── */
#define ttPAYMENT 0

/* ── vote values ──────────────────────────────────────────────────────────── */
#define VOTE_COMPLIANT     0x01
#define VOTE_NON_COMPLIANT 0x00

/* ── period status ────────────────────────────────────────────────────────── */
#define STATUS_INACTIVE  0
#define STATUS_ACTIVE    1
#define STATUS_FINALIZED 2

/* ── memo type lengths ────────────────────────────────────────────────────── */
#define MT_LOCK_LEN   4   /* "LOCK" */
#define MT_PROOF_LEN  5   /* "PROOF" */
#define MT_GRNT_LEN   4   /* "GRNT" — regulator grants claim permit */
#define MT_CLAM_LEN   4   /* "CLAM" — permitted party claims funds   */

/* ── proof blob offsets ───────────────────────────────────────────────────── */
#define PROOF_SCHEMA_OFF    0
#define PROOF_PERIOD_SEQ_OFF 1
#define PROOF_LEDGER_TS_OFF  5
#define PROOF_VOTE_CNT_OFF   9
#define PROOF_ENTRIES_OFF   10
#define VOTE_ENTRY_SIZE     97  /* 32+1+64 */

/* ── committee config ─────────────────────────────────────────────────────── */
#define MAX_K        16
#define PUBKEYS_PER_CHUNK 4
#define MAX_CHUNKS   ((MAX_K + PUBKEYS_PER_CHUNK - 1) / PUBKEYS_PER_CHUNK)

/* ── namespace state key lengths ──────────────────────────────────────────── */
#define SK_COLLATERAL_LEN  16
#define SK_PERIOD_SEQ_LEN  10
#define SK_PERIOD_LGR_LEN  13
#define SK_PERIOD_STA_LEN  13

/* ── hook parameter key lengths ───────────────────────────────────────────── */
#define HP_REGULATOR_LEN   9
#define HP_CONTRACTOR_LEN  10
#define HP_SCHEMA_VER_LEN  10
#define HP_M_THRESH_LEN    11
#define HP_K_COMM_LEN      11
#define HP_COLLAT_LEN      12
#define HP_SLICE_LEN       11  /* "SLICE_DROPS" */

/* ── reputation update memo ──────────────────────────────────────────────── */
/* memo data layout: outcome(1) | vote_count(1) | (pubkey(32)|vote(1))[vote_count] */
#define REP_MEMO_HDR_SIZE  2
#define REP_ENTRY_SIZE     33   /* 32 pubkey + 1 vote */
#define REP_MEMO_MAX_DATA  (REP_MEMO_HDR_SIZE + MAX_K * REP_ENTRY_SIZE) /* 530 */

/* ── emitted payment buffer size ─────────────────────────────────────────── */
/* base (no memo) ≈ 220, memo section ≈ 260, etxn_details ≈ 138 → 620 total */
#define REP_TX_BUFSIZE  700
#define FUND_TX_BUFSIZE PREPARE_PAYMENT_SIMPLE_SIZE

/* ─────────────────────────── helper functions ───────────────────────────── */

static uint32_t u32be(const uint8_t *b)
{
    return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16)
         | ((uint32_t)b[2] <<  8) |  (uint32_t)b[3];
}

static uint64_t u64be(const uint8_t *b)
{
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v = (v << 8) | b[i];
    return v;
}

static void put_u32be(uint8_t *b, uint32_t v)
{
    b[0] = (v >> 24) & 0xff; b[1] = (v >> 16) & 0xff;
    b[2] = (v >>  8) & 0xff; b[3] =  v        & 0xff;
}

static void put_u64be(uint8_t *b, uint64_t v)
{
    for (int i = 7; i >= 0; i--) { b[i] = v & 0xff; v >>= 8; }
}

/* ── committee chunk key computation ─────────────────────────────────────── */
/* key = sha512h("COMMITTEE" || u32be(period_seq) || u8(chunk))              */
static void committee_key(uint8_t out[32], uint32_t period_seq, uint8_t chunk)
{
    uint8_t inp[14];
    inp[0]='C'; inp[1]='O'; inp[2]='M'; inp[3]='M'; inp[4]='I';
    inp[5]='T'; inp[6]='T'; inp[7]='E'; inp[8]='E';
    put_u32be(inp + 9, period_seq);
    inp[13] = chunk;
    util_sha512h((uint32_t)out, 32, (uint32_t)inp, 14);
}

/* ── VL encode (XRPL variable-length prefix) ─────────────────────────────── */
/* Returns bytes written (1 or 2). val must be ≤ 12480.                      */
static int vl_encode(uint8_t *dst, uint32_t val)
{
    if (val <= 192) { dst[0] = (uint8_t)val; return 1; }
    uint32_t n = val - 193;
    dst[0] = (uint8_t)(193 + (n >> 8));
    dst[1] = (uint8_t)(n & 0xff);
    return 2;
}

/* ── build reputation-update payment binary ──────────────────────────────── */
/*                                                                            */
/* Emits a 1-drop Payment from the company (hook_acc) to the regulator with  */
/* a single "REPU" memo carrying:                                             */
/*   outcome(1) | vote_count(1) | (pubkey32 + vote1)[vote_count]             */
/*                                                                            */
/* Returns total bytes written into buf.                                      */
static int build_rep_tx(
    uint8_t      *buf,
    const uint8_t hook_acc[20],
    const uint8_t regulator[20],
    uint8_t       outcome,
    const uint8_t *voters,      /* vote_count × 33 bytes (pubkey32 | vote1) */
    uint8_t        vote_count)
{
    uint8_t *p = buf;

    /* ── Fixed header fields ─────────────────────────────────────────────── */
    /* sfTransactionType = ttPAYMENT = 0  (UInt16 type=1, field=2 → 0x12)  */
    *p++ = 0x12; *p++ = 0x00; *p++ = 0x00;

    /* sfFlags = tfCANONICAL (0x80000000)  (UInt32 type=2, field=2 → 0x22) */
    *p++ = 0x22; *p++ = 0x80; *p++ = 0x00; *p++ = 0x00; *p++ = 0x00;

    /* sfSequence = 0  (UInt32, field=4 → 0x24) */
    *p++ = 0x24; *p++ = 0x00; *p++ = 0x00; *p++ = 0x00; *p++ = 0x00;

    /* sfLastLedgerSequence = ledger_seq()+4 (UInt32, field=27 → 0x20,0x1B) */
    *p++ = 0x20; *p++ = 0x1B;
    uint32_t lls = (uint32_t)ledger_seq() + 4;
    put_u32be(p, lls); p += 4;

    /* sfAmount = 1 drop XRP  (Amount type=6, field=1 → 0x61)              */
    /* XRP Amount: bit63=0 (XRP), bit62=1 (positive), bits61-0 = drops     */
    *p++ = 0x61;
    uint64_t amt = 1ULL | 0x4000000000000000ULL;
    put_u64be(p, amt); p += 8;

    /* sfFee placeholder (Amount type=6, field=8 → 0x68) – back-fill later */
    *p++ = 0x68;
    uint8_t *fee_val_ptr = p;   /* save pointer for back-fill */
    put_u64be(p, 0x4000000000000000ULL); p += 8;

    /* sfSigningPubKey = empty blob (Blob type=7, field=3 → 0x73)          */
    *p++ = 0x73; *p++ = 0x00;

    /* sfAccount = hook_acc (AccountID type=8, field=1 → 0x81)             */
    *p++ = 0x81; *p++ = 0x14;  /* VL = 20 = 0x14 */
    for (int i = 0; i < 20; i++) *p++ = hook_acc[i];

    /* sfDestination = regulator (AccountID type=8, field=3 → 0x83)        */
    *p++ = 0x83; *p++ = 0x14;
    for (int i = 0; i < 20; i++) *p++ = regulator[i];

    /* ── Memos (STArray type=15, field=9 → 0xF9) ────────────────────────── */
    /* Memo data = outcome(1) + vote_count(1) + vote_count × REP_ENTRY_SIZE */
    uint32_t md_len = (uint32_t)REP_MEMO_HDR_SIZE
                    + (uint32_t)vote_count * REP_ENTRY_SIZE;

    *p++ = 0xF9;  /* sfMemos begin */
    *p++ = 0xEA;  /* sfMemo begin (STObject type=14, field=10) */

    /* sfMemoType (Blob type=7, field=12 → 0x7C) = "REPU" (4 bytes) */
    *p++ = 0x7C; *p++ = 0x04;
    *p++ = 'R'; *p++ = 'E'; *p++ = 'P'; *p++ = 'U';

    /* sfMemoData (Blob type=7, field=13 → 0x7D) */
    *p++ = 0x7D;
    p += vl_encode(p, md_len);
    *p++ = outcome;
    *p++ = vote_count;
    for (int i = 0; i < (int)vote_count; i++) {
        for (int j = 0; j < REP_ENTRY_SIZE; j++)
            *p++ = voters[i * REP_ENTRY_SIZE + j];
    }

    *p++ = 0xE1;  /* end sfMemo */
    *p++ = 0xF1;  /* end sfMemos */

    /* ── etxn_details ────────────────────────────────────────────────────── */
    int64_t ed_len = etxn_details((uint32_t)p, 138);
    p += ed_len;

    /* ── compute and back-fill fee ───────────────────────────────────────── */
    uint32_t tx_len = (uint32_t)(p - buf);
    int64_t fee = etxn_fee_base((uint32_t)buf, tx_len);
    uint64_t fee_drops = (uint64_t)fee | 0x4000000000000000ULL;
    put_u64be(fee_val_ptr, fee_drops);

    return (int)tx_len;
}

/* ─────────────────────────────── hook() ────────────────────────────────── */

int64_t hook(uint32_t reserved)
{
    TRACESTR("compliance_hook: fired");

    /* Only handle Payment transactions. */
    if (otxn_type() != ttPAYMENT)
        ACCEPT("compliance_hook: not a payment", 0);

    /* ── Read hook account ────────────────────────────────────────────────── */
    uint8_t hook_acc[20];
    hook_account(SBUF(hook_acc));

    /* ── Read sender and destination ─────────────────────────────────────── */
    uint8_t dest[20], sender[20];
    if (otxn_field(SBUF(dest),   sfDestination) != 20)
        ACCEPT("compliance_hook: no destination", 0);
    if (otxn_field(SBUF(sender), sfAccount)      != 20)
        ACCEPT("compliance_hook: no account", 0);

    int is_dest = BUFFER_EQUAL_20(hook_acc, dest);
    int is_src  = BUFFER_EQUAL_20(hook_acc, sender);

    /* ── Outgoing payment guard ───────────────────────────────────────────── */
    /* Reject any outgoing non-self payment while a period is active.        */
    /* Exception: hook-emitted transactions carry sfEmitDetails — allow them */
    /* through unconditionally (they are our own CLAM fund-release payments).*/
    if (is_src && !is_dest) {
        uint8_t ed_buf[138];
        if (otxn_field(SBUF(ed_buf), sfEmitDetails) > 0)
            ACCEPT("compliance_hook: emitted outgoing tx, pass through", 0);

        uint8_t status[1] = {STATUS_INACTIVE};
        state(SBUF(status), "PERIOD_STATUS", SK_PERIOD_STA_LEN);
        if (status[0] == STATUS_ACTIVE)
            ROLLBACK("compliance_hook: funds locked during active period", 1);
        ACCEPT("compliance_hook: outgoing payment, period not active", 0);
    }

    /* Ignore transactions where we are neither source nor destination. */
    if (!is_dest)
        ACCEPT("compliance_hook: not our account", 0);

    /* ── Read first memo type ─────────────────────────────────────────────── */
    uint8_t mt[16];
    int64_t mt_len = memo_type(SBUF(mt), 0);
    if (mt_len < 0)
        ACCEPT("compliance_hook: no memo, ignoring", 0);

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  LOCK_COLLATERAL path                                                   */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_LOCK_LEN
        && mt[0]=='L' && mt[1]=='O' && mt[2]=='C' && mt[3]=='K')
    {
        TRACESTR("compliance_hook: LOCK path");

        /* Reject re-lock if period already active or finalized. */
        uint8_t cur_status[1] = {STATUS_INACTIVE};
        state(SBUF(cur_status), "PERIOD_STATUS", SK_PERIOD_STA_LEN);
        if (cur_status[0] != STATUS_INACTIVE)
            ROLLBACK("compliance_hook: period already open", 2);

        /* Read COLLAT_DROPS hook parameter (8 bytes). */
        uint8_t param_collat[8];
        if (hook_param(SBUF(param_collat), "COLLAT_DROPS", HP_COLLAT_LEN) != 8)
            ROLLBACK("compliance_hook: missing COLLAT_DROPS param", 3);
        uint64_t expected_drops = u64be(param_collat);

        /* Read payment amount and validate. */
        uint8_t amt_buf[8];
        if (otxn_field(SBUF(amt_buf), sfAmount) != 8)
            ROLLBACK("compliance_hook: cannot read Amount", 4);
        uint64_t actual_drops = u64be(amt_buf) & 0x3FFFFFFFFFFFFFFFULL;
        if (actual_drops != expected_drops)
            ROLLBACK("compliance_hook: collateral amount mismatch", 5);

        /* Read period_seq from memo data (4 bytes). */
        uint8_t lock_md[8];
        int64_t lock_md_len = memo_data(SBUF(lock_md), 0);
        if (lock_md_len < 4)
            ROLLBACK("compliance_hook: LOCK memo data too short", 6);
        uint32_t period_seq = u32be(lock_md);

        /* Persist state. */
        uint8_t val8[8]; uint8_t val4[4]; uint8_t val1[1];

        put_u64be(val8, actual_drops);
        state_set(SBUF(val8),     "COLLATERAL_DROPS", SK_COLLATERAL_LEN);

        put_u32be(val4, period_seq);
        state_set(SBUF(val4),     "PERIOD_SEQ",       SK_PERIOD_SEQ_LEN);

        put_u32be(val4, (uint32_t)ledger_seq());
        state_set(SBUF(val4),     "PERIOD_LEDGER",    SK_PERIOD_LGR_LEN);

        val1[0] = STATUS_ACTIVE;
        state_set(SBUF(val1),     "PERIOD_STATUS",    SK_PERIOD_STA_LEN);

        ACCEPT("compliance_hook: collateral locked", 0);
    }

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  PROOF_SUBMISSION path                                                  */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_PROOF_LEN
        && mt[0]=='P' && mt[1]=='R' && mt[2]=='O' && mt[3]=='O' && mt[4]=='F')
    {
        TRACESTR("compliance_hook: PROOF path");

        /* Period must be active. */
        uint8_t cur_status[1] = {STATUS_INACTIVE};
        state(SBUF(cur_status), "PERIOD_STATUS", SK_PERIOD_STA_LEN);
        if (cur_status[0] != STATUS_ACTIVE)
            ROLLBACK("compliance_hook: period not active", 10);

        /* Read proof blob from memo data. */
        uint8_t proof[PROOF_ENTRIES_OFF + MAX_K * VOTE_ENTRY_SIZE];
        int64_t proof_len = memo_data(SBUF(proof), 0);
        if (proof_len < (int64_t)(PROOF_ENTRIES_OFF + VOTE_ENTRY_SIZE))
            ROLLBACK("compliance_hook: proof blob too short", 11);

        /* ── Schema version ─────────────────────────────────────────────── */
        uint8_t schema_param[1];
        if (hook_param(SBUF(schema_param), "SCHEMA_VER", HP_SCHEMA_VER_LEN) != 1)
            ROLLBACK("compliance_hook: missing SCHEMA_VER param", 12);
        if (proof[PROOF_SCHEMA_OFF] != schema_param[0])
            ROLLBACK("compliance_hook: schema version mismatch", 13);

        /* ── Period sequence replay protection ──────────────────────────── */
        uint32_t proof_period_seq = u32be(proof + PROOF_PERIOD_SEQ_OFF);
        uint8_t stored_pseq[4];
        if (state(SBUF(stored_pseq), "PERIOD_SEQ", SK_PERIOD_SEQ_LEN) != 4)
            ROLLBACK("compliance_hook: cannot read PERIOD_SEQ", 14);
        if (proof_period_seq != u32be(stored_pseq))
            ROLLBACK("compliance_hook: period_seq mismatch (replay)", 15);

        /* ── Ledger timestamp replay protection ─────────────────────────── */
        uint32_t proof_ledger_ts = u32be(proof + PROOF_LEDGER_TS_OFF);
        uint8_t stored_plgr[4];
        if (state(SBUF(stored_plgr), "PERIOD_LEDGER", SK_PERIOD_LGR_LEN) != 4)
            ROLLBACK("compliance_hook: cannot read PERIOD_LEDGER", 16);
        if (proof_ledger_ts != u32be(stored_plgr))
            ROLLBACK("compliance_hook: ledger_ts mismatch (replay)", 17);

        /* ── Hook parameters ────────────────────────────────────────────── */
        uint8_t regulator[20], contractor[20];
        if (hook_param(SBUF(regulator),  "REGULATOR",   HP_REGULATOR_LEN)  != 20)
            ROLLBACK("compliance_hook: missing REGULATOR param", 18);
        if (hook_param(SBUF(contractor), "CONTRACTOR",  HP_CONTRACTOR_LEN) != 20)
            ROLLBACK("compliance_hook: missing CONTRACTOR param", 19);

        uint8_t m_param[1], k_param[1];
        if (hook_param(SBUF(m_param), "M_THRESHOLD", HP_M_THRESH_LEN) != 1)
            ROLLBACK("compliance_hook: missing M_THRESHOLD param", 20);
        if (hook_param(SBUF(k_param), "K_COMMITTEE", HP_K_COMM_LEN)   != 1)
            ROLLBACK("compliance_hook: missing K_COMMITTEE param", 21);
        int M = (int)m_param[0];
        int K = (int)k_param[0];
        if (K > MAX_K || K < 1 || M < 1 || M > K)
            ROLLBACK("compliance_hook: invalid M/K params", 22);

        /* ── Read committee from regulator namespace (state_foreign) ─────── */
        uint8_t committee[MAX_K * 32];
        int total_committee = 0;

        for (int chunk = 0; chunk < MAX_CHUNKS && total_committee < K; chunk++) {
            uint8_t ckey[32];
            committee_key(ckey, proof_period_seq, (uint8_t)chunk);

            uint8_t chunk_data[PUBKEYS_PER_CHUNK * 32];
            int64_t cl = state_foreign(SBUF(chunk_data),
                                       SBUF(ckey),
                                       SBUF(regulator));
            if (cl <= 0) break;

            int pks_in_chunk = (int)(cl / 32);
            int to_copy = pks_in_chunk;
            if (total_committee + to_copy > K)
                to_copy = K - total_committee;
            for (int i = 0; i < to_copy * 32; i++)
                committee[total_committee * 32 + i] = chunk_data[i];
            total_committee += to_copy;
        }

        if (total_committee < K)
            ROLLBACK("compliance_hook: committee not fully committed", 23);

        /* ── Parse and verify vote entries ──────────────────────────────── */
        uint8_t vote_count = proof[PROOF_VOTE_CNT_OFF];
        if (vote_count == 0 || vote_count > (uint8_t)K)
            ROLLBACK("compliance_hook: invalid vote_count", 24);

        if ((int64_t)proof_len < (int64_t)(PROOF_ENTRIES_OFF + (int)vote_count * VOTE_ENTRY_SIZE))
            ROLLBACK("compliance_hook: proof blob truncated", 25);

        /* Seen-pubkey bitfield (one bit per committee slot, up to MAX_K=16) */
        uint32_t seen_mask = 0;

        int compliant_votes    = 0;
        int non_compliant_votes = 0;

        /* Voters array for reputation update memo: (pubkey32|vote1) per entry */
        uint8_t voters[MAX_K * REP_ENTRY_SIZE];
        int voter_count = 0;

        for (int ei = 0; ei < (int)vote_count; ei++) {
            const uint8_t *entry = proof + PROOF_ENTRIES_OFF + ei * VOTE_ENTRY_SIZE;
            const uint8_t *epubkey = entry;                  /* [0..31]  */
            uint8_t         evote  = entry[32];              /* [32]     */
            const uint8_t *esig   = entry + 33;             /* [33..96] */

            /* Locate this pubkey in the committee. */
            int slot = -1;
            for (int ci = 0; ci < total_committee; ci++) {
                int match = 1;
                for (int bi = 0; bi < 32; bi++) {
                    if (committee[ci * 32 + bi] != epubkey[bi]) { match = 0; break; }
                }
                if (match) { slot = ci; break; }
            }
            if (slot < 0)
                ROLLBACK("compliance_hook: oracle not in committee", 26);

            /* Duplicate pubkey detection. */
            uint32_t bit = (1U << (uint32_t)slot);
            if (seen_mask & bit)
                ROLLBACK("compliance_hook: duplicate oracle pubkey", 27);
            seen_mask |= bit;

            /* Build canonical payload: period_seq(4)|company(20)|vote(1)|ledger_ts(4) */
            uint8_t payload[29];
            put_u32be(payload,      proof_period_seq);
            for (int bi = 0; bi < 20; bi++) payload[4 + bi] = hook_acc[bi];
            payload[24] = evote;
            put_u32be(payload + 25, proof_ledger_ts);

            /* Build XRPL-format pubkey: 0xED || pubkey[32] */
            uint8_t xrpl_key[33];
            xrpl_key[0] = 0xED;
            for (int bi = 0; bi < 32; bi++) xrpl_key[1 + bi] = epubkey[bi];

            /* Verify ed25519 signature. */
            int64_t vr = util_verify((uint32_t)payload, 29,
                                     (uint32_t)esig,    64,
                                     (uint32_t)xrpl_key, 33);
            if (vr <= 0)
                ROLLBACK("compliance_hook: invalid oracle signature", 28);

            /* Tally. */
            if (evote == VOTE_COMPLIANT)         compliant_votes++;
            else if (evote == VOTE_NON_COMPLIANT) non_compliant_votes++;

            /* Collect for reputation update. */
            for (int bi = 0; bi < 32; bi++) voters[voter_count * REP_ENTRY_SIZE + bi] = epubkey[bi];
            voters[voter_count * REP_ENTRY_SIZE + 32] = evote;
            voter_count++;
        }

        /* ── Consensus decision ─────────────────────────────────────────── */
        if (compliant_votes < M && non_compliant_votes < M)
            ROLLBACK("compliance_hook: no consensus", 30);

        /* Reserve two emissions: fund release + reputation update. */
        etxn_reserve(2);

        /* ── Read stored collateral ─────────────────────────────────────── */
        uint8_t collat_buf[8];
        if (state(SBUF(collat_buf), "COLLATERAL_DROPS", SK_COLLATERAL_LEN) != 8)
            ROLLBACK("compliance_hook: cannot read collateral", 31);
        uint64_t collat_drops = u64be(collat_buf);

        /* ── Emit fund release ──────────────────────────────────────────── */
        uint8_t fund_tx[FUND_TX_BUFSIZE];
        uint8_t emit_hash[32];

        uint8_t outcome;
        if (compliant_votes >= M) {
            outcome = VOTE_COMPLIANT;
            /* Return collateral to company. */
            PREPARE_PAYMENT_SIMPLE(fund_tx, collat_drops, hook_acc, 0, 0);
        } else {
            outcome = VOTE_NON_COMPLIANT;
            /* Send collateral to contractor. */
            PREPARE_PAYMENT_SIMPLE(fund_tx, collat_drops, contractor, 0, 0);
        }

        if (emit(SBUF(emit_hash), SBUF(fund_tx)) < 0)
            ROLLBACK("compliance_hook: fund emit failed", 32);

        /* ── Emit reputation update ─────────────────────────────────────── */
        uint8_t rep_tx[REP_TX_BUFSIZE];
        int rep_tx_len = build_rep_tx(rep_tx, hook_acc, regulator,
                                      outcome, voters, (uint8_t)voter_count);
        if (emit(SBUF(emit_hash), (uint32_t)rep_tx, (uint32_t)rep_tx_len) < 0)
            ROLLBACK("compliance_hook: reputation emit failed", 33);

        /* ── Update period status to finalized ──────────────────────────── */
        uint8_t final_status[1] = {STATUS_FINALIZED};
        state_set(SBUF(final_status), "PERIOD_STATUS", SK_PERIOD_STA_LEN);

        ACCEPT("compliance_hook: consensus reached, funds released", 0);
    }

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  GRNT path — regulator grants a claim permit for one period           */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_GRNT_LEN
        && mt[0]=='G' && mt[1]=='R' && mt[2]=='N' && mt[3]=='T')
    {
        TRACESTR("compliance_hook: GRNT path");

        /* Only the regulator may grant permits. */
        uint8_t regulator[20];
        if (hook_param(SBUF(regulator), "REGULATOR", HP_REGULATOR_LEN) != 20)
            ROLLBACK("compliance_hook: missing REGULATOR param for GRNT", 40);
        if (!BUFFER_EQUAL_20(sender, regulator))
            ROLLBACK("compliance_hook: GRNT not from regulator", 41);

        /* memo data: period_seq(4) | recipient(20) */
        uint8_t gd[24];
        if (memo_data(SBUF(gd), 0) < 24)
            ROLLBACK("compliance_hook: GRNT memo data too short", 42);

        uint32_t period_seq = u32be(gd);

        /* state key: "PERMIT" (6) + u32be(period_seq) (4) + 22 zero bytes */
        uint8_t pkey[32];
        for (int i = 0; i < 32; i++) pkey[i] = 0;
        pkey[0]='P'; pkey[1]='E'; pkey[2]='R'; pkey[3]='M'; pkey[4]='I'; pkey[5]='T';
        put_u32be(pkey + 6, period_seq);

        if (state_set(gd + 4, 20, SBUF(pkey)) < 0)
            ROLLBACK("compliance_hook: GRNT state_set failed", 43);

        ACCEPT("compliance_hook: permit granted", 0);
    }

    /* ═══════════════════════════════════════════════════════════════════════ */
    /*  CLAM path — permitted party claims funds for one period              */
    /* ═══════════════════════════════════════════════════════════════════════ */
    if (mt_len == MT_CLAM_LEN
        && mt[0]=='C' && mt[1]=='L' && mt[2]=='A' && mt[3]=='M')
    {
        TRACESTR("compliance_hook: CLAM path");

        /* memo data: period_seq(4) */
        uint8_t cd[4];
        if (memo_data(SBUF(cd), 0) < 4)
            ROLLBACK("compliance_hook: CLAM memo data too short", 50);

        uint32_t period_seq = u32be(cd);

        /* build permit key */
        uint8_t pkey[32];
        for (int i = 0; i < 32; i++) pkey[i] = 0;
        pkey[0]='P'; pkey[1]='E'; pkey[2]='R'; pkey[3]='M'; pkey[4]='I'; pkey[5]='T';
        put_u32be(pkey + 6, period_seq);

        /* read permit */
        uint8_t permitted[20];
        if (state(SBUF(permitted), SBUF(pkey)) != 20)
            ROLLBACK("compliance_hook: no permit for this period", 51);

        /* all-zero permit means not granted or already consumed */
        int all_zero = 1;
        for (int i = 0; i < 20; i++) if (permitted[i] != 0) { all_zero = 0; break; }
        if (all_zero)
            ROLLBACK("compliance_hook: permit not granted or already used", 52);

        if (!BUFFER_EQUAL_20(sender, permitted))
            ROLLBACK("compliance_hook: sender not permitted to claim", 53);

        /* read SLICE_DROPS hook parameter */
        uint8_t sp[8];
        if (hook_param(SBUF(sp), "SLICE_DROPS", HP_SLICE_LEN) != 8)
            ROLLBACK("compliance_hook: missing SLICE_DROPS param", 54);
        uint64_t slice_drops = u64be(sp);

        /* finalize period status so outgoing guard passes for our emitted payment */
        uint8_t fin[1] = {STATUS_FINALIZED};
        state_set(SBUF(fin), "PERIOD_STATUS", SK_PERIOD_STA_LEN);

        /* consume permit (zero it out) */
        uint8_t zero20[20];
        for (int i = 0; i < 20; i++) zero20[i] = 0;
        state_set(SBUF(zero20), SBUF(pkey));

        /* emit payment of slice_drops to the permitted party (the sender) */
        etxn_reserve(1);
        uint8_t fund_tx[FUND_TX_BUFSIZE];
        PREPARE_PAYMENT_SIMPLE(fund_tx, slice_drops, sender, 0, 0);
        uint8_t emit_hash[32];
        if (emit(SBUF(emit_hash), SBUF(fund_tx)) < 0)
            ROLLBACK("compliance_hook: CLAM emit failed", 55);

        ACCEPT("compliance_hook: funds claimed", 0);
    }

    ACCEPT("compliance_hook: unrecognized memo type, ignoring", 0);
    return 0;
}
