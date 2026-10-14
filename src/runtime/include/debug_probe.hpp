// ============================================================================
// KEEP THIS HEADER C++14-CLEAN (see iec_var.hpp): it is included by generated
// code that some targets build with -std=gnu++14.
// ============================================================================

/**
 * @file debug_probe.hpp
 * @brief Debugger probes in generated code, and the C ABI they call.
 *
 * Included by `generated.hpp` only when the program is compiled with probes
 * (the default; `--no-probes` / `debugProbes: false` omits it and everything
 * below). Each POU is emitted twice:
 *
 *   - an UNPROBED clone: the probe-off code plus a poll at POU entry, at each
 *     loop back-edge and after each statement that calls a POU. With no
 *     session the poll is one byte load and one test-and-branch on
 *     `strucpp_dbg_active`, and nothing else of the debugger runs.
 *   - a PROBED clone (`__dbg_probed`): a probe before every statement and in
 *     every loop / ELSIF condition, a frame record, and a `switch` that
 *     resumes at the poll site that transferred into it (on-stack transfer:
 *     stack locals are passed by value, FB and program state lives in `this`).
 *
 * C ABI, version STRUCPP_DBG_ABI_VERSION:
 *
 *   Defined by the generated program (configuration.cpp):
 *     volatile uint8_t strucpp_dbg_flags[]    one byte per probe: ARMED | TRAP
 *     uint8_t  strucpp_dbg_active             bit 0: a session is attached
 *                                             (hidden: one load, no GOT)
 *     uint8_t* strucpp_dbg_active_addr(void)  its address, for the host
 *     uint32_t strucpp_dbg_probe_count(void)  0 in a probe-off build (NO_PROBES)
 *     uint32_t strucpp_dbg_abi_version(void)
 *     int      strucpp_dbg_lock_depth(void)   shared-global locks held by the
 *                                             calling thread (0 unless
 *                                             STRUCPP_THREADED)
 *
 *   Provided by the host (the runtime's debug engine; tests link
 *   src/runtime/test/debug_probe_stub.hpp). The program also defines weak
 *   no-op versions so it links without a host; only a host attaches a
 *   session, so they never run while one is attached:
 *     void strucpp_dbg_hit(uint32_t probe)    slow path of a probe whose flag
 *                                             byte is non-zero; must not park
 *                                             while strucpp_dbg_lock_depth() > 0
 *     void strucpp_dbg_frame_link(strucpp_dbg_frame*)    on probed-clone entry
 *     void strucpp_dbg_frame_unlink(strucpp_dbg_frame*)  on its exit, if linked
 *
 * See also:
 *   src/backend/codegen.ts - emits the clones, polls, probes and frames.
 *   src/runtime/include/iec_global.hpp - the shared-global lock depth.
 *   src/runtime/test/debug_probe_stub.hpp - a host stub for tests and the REPL.
 */
#ifndef STRUCPP_DEBUG_PROBE_HPP
#define STRUCPP_DEBUG_PROBE_HPP

#include <stdint.h>

#define STRUCPP_DBG_ABI_VERSION 1u

/** Flag byte bits. A probe takes its slow path when its byte is non-zero. */
#define STRUCPP_DBG_ARMED 1u
#define STRUCPP_DBG_TRAP 2u
/** Bit of strucpp_dbg_active that the polls and frames test. */
#define STRUCPP_DBG_ACTIVE 1u

#if defined(__GNUC__) && !defined(__AVR__) && !defined(_WIN32)
#define STRUCPP_DBG_HIDDEN __attribute__((visibility("hidden")))
#else
#define STRUCPP_DBG_HIDDEN
#endif

extern "C" {

struct strucpp_dbg_frame {
    struct strucpp_dbg_frame* prev;
    const void* self;   /** FB / program instance, or null */
    void* locals;       /** grouped stack locals, or null */
    uint32_t pou;       /** entry probe ID of the POU body */
    uint32_t at;        /** probe ID of the statement making the current call */
    uint32_t gen;       /** attach generation, set by the host */
    uint8_t linked;     /** set by the host in link() */
};

extern volatile uint8_t strucpp_dbg_flags[];
extern STRUCPP_DBG_HIDDEN uint8_t strucpp_dbg_active;
uint8_t* strucpp_dbg_active_addr(void);
uint32_t strucpp_dbg_probe_count(void);
uint32_t strucpp_dbg_abi_version(void);
int strucpp_dbg_lock_depth(void);

void strucpp_dbg_hit(uint32_t probe);
void strucpp_dbg_frame_link(struct strucpp_dbg_frame* frame);
void strucpp_dbg_frame_unlink(struct strucpp_dbg_frame* frame);

}  // extern "C"

// ---------------------------------------------------------------- probes
// Relaxed atomic under STRUCPP_THREADED: the same single byte load as the
// volatile read, but not a data race against the host's writes.
#if defined(STRUCPP_THREADED)
#define STRUCPP_DBG_LOAD(x) __atomic_load_n(&(x), __ATOMIC_RELAXED)
#else
#define STRUCPP_DBG_LOAD(x) (x)
#endif

#define STRUCPP_PROBE(id) \
    (__builtin_expect(STRUCPP_DBG_LOAD(strucpp_dbg_flags[id]) != 0, 0) ? strucpp_dbg_hit(id) : (void)0)

// ---------------------------------------------------------------- polls
// Volatile, so a poll in a loop re-reads the byte each iteration; volatile
// rather than atomic so the rest of the body keeps its probe-off codegen.
// Bit 0 only, so the branch can test the bit directly (`ldrb; tbnz`).
#define STRUCPP_DBG_ACTIVE_NOW() (*static_cast<volatile uint8_t*>(&strucpp_dbg_active) & STRUCPP_DBG_ACTIVE)

/** Poll site `k`: with a session attached, leave by a tail return into the
 *  probed clone, which resumes at site `k`. */
#define STRUCPP_POLL(k, ...) \
    do { if (__builtin_expect(STRUCPP_DBG_ACTIVE_NOW() != 0, 0)) return __VA_ARGS__; } while (0)

// ---------------------------------------------------------------- clones
#if defined(__GNUC__) && !defined(__clang__)
// At -O1 GCC emits no sibling calls; with them a taken poll in a method is
// epilogue + `b`, so the unprobed clone needs no frame the probe-off code lacks.
#define STRUCPP_DBG_UNPROBED __attribute__((optimize("optimize-sibling-calls")))
#else
#define STRUCPP_DBG_UNPROBED
#endif

#if defined(__GNUC__) && defined(__ELF__)
#define STRUCPP_DBG_PROBED __attribute__((noinline, cold, section(".text.unlikely")))
#elif defined(__GNUC__)
#define STRUCPP_DBG_PROBED __attribute__((noinline, cold))
#else
#define STRUCPP_DBG_PROBED
#endif

// ---------------------------------------------------------------- frames
namespace strucpp {
namespace dbg {

/** Frame record of one probed-clone activation. Linked into the host's
 *  per-thread chain only while a session is attached; the destructor tests its
 *  own `linked` byte, never strucpp_dbg_active, so a detach mid-scan cannot
 *  leave the chain pointing at a dead frame. */
struct Frame : strucpp_dbg_frame {
    Frame(uint32_t pou_id, const void* self_, void* locals_) noexcept {
        linked = 0;
        at = 0;
        if (__builtin_expect((strucpp_dbg_active & STRUCPP_DBG_ACTIVE) != 0, 1)) {
            pou = pou_id;
            self = self_;
            locals = locals_;
            strucpp_dbg_frame_link(this);
        }
    }
    ~Frame() {
        if (linked) strucpp_dbg_frame_unlink(this);
    }
    Frame(const Frame&) = delete;
    Frame& operator=(const Frame&) = delete;
};

}  // namespace dbg
}  // namespace strucpp

#define STRUCPP_FRAME(pou, self, locals) ::strucpp::dbg::Frame __dbg_frame((pou), (self), (locals))
/** Probe ID of the statement making the next call: one store, no branch. */
#define STRUCPP_AT(id) (__dbg_frame.at = (id))

#endif  // STRUCPP_DEBUG_PROBE_HPP
