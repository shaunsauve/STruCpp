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
#include <type_traits>

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

/** Poll site `k`: with a session attached, leave into the probed clone, which
 *  resumes at site `k`.
 *
 *  STRUCPP_POLL(k, xfer)
 *      returns `xfer` (a call of the probed clone): FB bodies and programs,
 *      where GCC makes it a sibling call.
 *  STRUCPP_POLL(k, xfer, n, stub, retp, ret, STRUCPP_XA(a) | STRUCPP_XP(a)...)
 *      functions, methods and property accessors. A call returning in memory
 *      or taking objects by value is never a sibling call, so `return xfer`
 *      would give the unprobed clone a frame its probe-off build lacks. On
 *      aarch64 the transfer is instead an asm block that saves every
 *      register it touches on its own stack and calls `stub` with the
 *      encoded state (slot 1: `retp`, slot 2: k, slots 3..n: the arguments,
 *      STRUCPP_XP by address, STRUCPP_XA as XArg encodes them); the unprobed
 *      clone then returns `ret`, which the stub has written through `retp`.
 *      Elsewhere it is `return xfer`. A void POU passes `0, (void)0`. */
#define STRUCPP_POLL(...) \
    STRUCPP_DBG_CAT(STRUCPP_POLL_, STRUCPP_DBG_POLL_KIND(__VA_ARGS__))(__VA_ARGS__)
#define STRUCPP_DBG_CAT_(a, b) a##b
#define STRUCPP_DBG_CAT(a, b) STRUCPP_DBG_CAT_(a, b)
#define STRUCPP_DBG_POLL_KIND(...) STRUCPP_DBG_ARG40(__VA_ARGS__, \
    X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, X, T, E)
#define STRUCPP_DBG_ARG40(_1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14, \
    _15, _16, _17, _18, _19, _20, _21, _22, _23, _24, _25, _26, _27, _28, _29, _30, _31, \
    _32, _33, _34, _35, _36, _37, _38, _39, _40, kind, ...) kind
#define STRUCPP_POLL_T(k, xfer) \
    do { if (__builtin_expect(STRUCPP_DBG_ACTIVE_NOW() != 0, 0)) return xfer; } while (0)

#if defined(__aarch64__) && defined(__GNUC__)
#define STRUCPP_POLL_X(k, xfer, n, stub, retp, ret, ...) \
    do { if (__builtin_expect(STRUCPP_DBG_ACTIVE_NOW() != 0, 0)) { \
        STRUCPP_DBG_XCALL(n, stub, ::strucpp::dbg::xret_addr(retp), k, __VA_ARGS__); \
        return ret; } } while (0)
#define STRUCPP_XA(a) "r"(::strucpp::dbg::XArg<decltype(a)>::put(a))
#define STRUCPP_XP(a) "r"(::strucpp::dbg::XAddr<decltype(a)>::put(a))
// 928 bytes of own stack: state slots 0..31, then x0-x18, x30, q0-q31. No register
// is clobbered and no call is visible, so the site needs no frame of its own.
#define STRUCPP_DBG_XS(i) "str %" #i ", [sp, #" #i "*8]\n\t"
#define STRUCPP_DBG_XCALL(n, stub, retp, k, ...) \
    __asm__ volatile( \
        "sub sp, sp, #928\n\t" \
        "stp x0, x1, [sp, #256]\n\t" "stp x2, x3, [sp, #272]\n\t" "stp x4, x5, [sp, #288]\n\t" \
        "stp x6, x7, [sp, #304]\n\t" "stp x8, x9, [sp, #320]\n\t" "stp x10, x11, [sp, #336]\n\t" \
        "stp x12, x13, [sp, #352]\n\t" "stp x14, x15, [sp, #368]\n\t" "stp x16, x17, [sp, #384]\n\t" \
        "stp x18, x30, [sp, #400]\n\t" \
        "stp q0, q1, [sp, #416]\n\t" "stp q2, q3, [sp, #448]\n\t" "stp q4, q5, [sp, #480]\n\t" \
        "stp q6, q7, [sp, #512]\n\t" "stp q8, q9, [sp, #544]\n\t" "stp q10, q11, [sp, #576]\n\t" \
        "stp q12, q13, [sp, #608]\n\t" "stp q14, q15, [sp, #640]\n\t" "stp q16, q17, [sp, #672]\n\t" \
        "stp q18, q19, [sp, #704]\n\t" "stp q20, q21, [sp, #736]\n\t" "stp q22, q23, [sp, #768]\n\t" \
        "stp q24, q25, [sp, #800]\n\t" "stp q26, q27, [sp, #832]\n\t" "stp q28, q29, [sp, #864]\n\t" \
        "stp q30, q31, [sp, #896]\n\t" \
        STRUCPP_DBG_XS(0) STRUCPP_DBG_XST_##n \
        "ldr x16, [sp]\n\t" \
        "mov x0, sp\n\t" \
        "blr x16\n\t" \
        "ldp q0, q1, [sp, #416]\n\t" "ldp q2, q3, [sp, #448]\n\t" "ldp q4, q5, [sp, #480]\n\t" \
        "ldp q6, q7, [sp, #512]\n\t" "ldp q8, q9, [sp, #544]\n\t" "ldp q10, q11, [sp, #576]\n\t" \
        "ldp q12, q13, [sp, #608]\n\t" "ldp q14, q15, [sp, #640]\n\t" "ldp q16, q17, [sp, #672]\n\t" \
        "ldp q18, q19, [sp, #704]\n\t" "ldp q20, q21, [sp, #736]\n\t" "ldp q22, q23, [sp, #768]\n\t" \
        "ldp q24, q25, [sp, #800]\n\t" "ldp q26, q27, [sp, #832]\n\t" "ldp q28, q29, [sp, #864]\n\t" \
        "ldp q30, q31, [sp, #896]\n\t" \
        "ldp x0, x1, [sp, #256]\n\t" "ldp x2, x3, [sp, #272]\n\t" "ldp x4, x5, [sp, #288]\n\t" \
        "ldp x6, x7, [sp, #304]\n\t" "ldp x8, x9, [sp, #320]\n\t" "ldp x10, x11, [sp, #336]\n\t" \
        "ldp x12, x13, [sp, #352]\n\t" "ldp x14, x15, [sp, #368]\n\t" "ldp x16, x17, [sp, #384]\n\t" \
        "ldp x18, x30, [sp, #400]\n\t" \
        "add sp, sp, #928" \
        : \
        : "r"(reinterpret_cast<uint64_t>(&(stub))), "r"(retp), \
          "r"(static_cast<uint64_t>(k)), __VA_ARGS__ \
        : "memory", "cc")
#define STRUCPP_DBG_XST_2 STRUCPP_DBG_XS(1) STRUCPP_DBG_XS(2)
#define STRUCPP_DBG_XST_3 STRUCPP_DBG_XST_2 STRUCPP_DBG_XS(3)
#define STRUCPP_DBG_XST_4 STRUCPP_DBG_XST_3 STRUCPP_DBG_XS(4)
#define STRUCPP_DBG_XST_5 STRUCPP_DBG_XST_4 STRUCPP_DBG_XS(5)
#define STRUCPP_DBG_XST_6 STRUCPP_DBG_XST_5 STRUCPP_DBG_XS(6)
#define STRUCPP_DBG_XST_7 STRUCPP_DBG_XST_6 STRUCPP_DBG_XS(7)
#define STRUCPP_DBG_XST_8 STRUCPP_DBG_XST_7 STRUCPP_DBG_XS(8)
#define STRUCPP_DBG_XST_9 STRUCPP_DBG_XST_8 STRUCPP_DBG_XS(9)
#define STRUCPP_DBG_XST_10 STRUCPP_DBG_XST_9 STRUCPP_DBG_XS(10)
#define STRUCPP_DBG_XST_11 STRUCPP_DBG_XST_10 STRUCPP_DBG_XS(11)
#define STRUCPP_DBG_XST_12 STRUCPP_DBG_XST_11 STRUCPP_DBG_XS(12)
#define STRUCPP_DBG_XST_13 STRUCPP_DBG_XST_12 STRUCPP_DBG_XS(13)
#define STRUCPP_DBG_XST_14 STRUCPP_DBG_XST_13 STRUCPP_DBG_XS(14)
#define STRUCPP_DBG_XST_15 STRUCPP_DBG_XST_14 STRUCPP_DBG_XS(15)
#define STRUCPP_DBG_XST_16 STRUCPP_DBG_XST_15 STRUCPP_DBG_XS(16)
#define STRUCPP_DBG_XST_17 STRUCPP_DBG_XST_16 STRUCPP_DBG_XS(17)
#define STRUCPP_DBG_XST_18 STRUCPP_DBG_XST_17 STRUCPP_DBG_XS(18)
#define STRUCPP_DBG_XST_19 STRUCPP_DBG_XST_18 STRUCPP_DBG_XS(19)
#define STRUCPP_DBG_XST_20 STRUCPP_DBG_XST_19 STRUCPP_DBG_XS(20)
#define STRUCPP_DBG_XST_21 STRUCPP_DBG_XST_20 STRUCPP_DBG_XS(21)
#define STRUCPP_DBG_XST_22 STRUCPP_DBG_XST_21 STRUCPP_DBG_XS(22)
#define STRUCPP_DBG_XST_23 STRUCPP_DBG_XST_22 STRUCPP_DBG_XS(23)
#define STRUCPP_DBG_XST_24 STRUCPP_DBG_XST_23 STRUCPP_DBG_XS(24)
#define STRUCPP_DBG_XST_25 STRUCPP_DBG_XST_24 STRUCPP_DBG_XS(25)
#define STRUCPP_DBG_XST_26 STRUCPP_DBG_XST_25 STRUCPP_DBG_XS(26)
#define STRUCPP_DBG_XST_27 STRUCPP_DBG_XST_26 STRUCPP_DBG_XS(27)
#define STRUCPP_DBG_XST_28 STRUCPP_DBG_XST_27 STRUCPP_DBG_XS(28)
#define STRUCPP_DBG_XST_29 STRUCPP_DBG_XST_28 STRUCPP_DBG_XS(29)
#else
#define STRUCPP_POLL_X(k, xfer, ...) STRUCPP_POLL_T(k, xfer)
#define STRUCPP_XA(a) a
#define STRUCPP_XP(a) a
#endif

namespace strucpp {
template <typename T> class IECVar;
namespace dbg {

/** Encoding of one transfer argument in a 64-bit state slot, keyed on its
 *  declared type: an IECVar of an arithmetic type by value (its get(), as the
 *  by-value copy would see it; no address taken, so a register local stays a
 *  register), a pointer by value, anything else by address. */
template <typename T, typename = void>
struct XArg {
    static uint64_t put(const T& v) noexcept { return reinterpret_cast<uintptr_t>(&v); }
    static T get(uint64_t s) { return *reinterpret_cast<const T*>(static_cast<uintptr_t>(s)); }
};
template <typename T>
struct XArg<T&, void> {
    static uint64_t put(T& v) noexcept { return reinterpret_cast<uintptr_t>(&v); }
    static T& get(uint64_t s) noexcept { return *reinterpret_cast<T*>(static_cast<uintptr_t>(s)); }
};
template <typename T>
struct XArg<T*, void> {
    static uint64_t put(T* p) noexcept { return reinterpret_cast<uintptr_t>(p); }
    static T* get(uint64_t s) noexcept { return reinterpret_cast<T*>(static_cast<uintptr_t>(s)); }
};
template <typename T>
struct XArg<IECVar<T>, typename std::enable_if<std::is_arithmetic<T>::value && sizeof(T) <= 8>::type> {
    static uint64_t put(const IECVar<T>& v) noexcept {
        T x = v.get();
        uint64_t b = 0;
        __builtin_memcpy(&b, &x, sizeof x);
        return b;
    }
    static IECVar<T> get(uint64_t s) noexcept {
        T x;
        __builtin_memcpy(&x, &s, sizeof x);
        return IECVar<T>(x);
    }
};

/** By address whatever the type: parameters and the result, which are in
 *  memory already, so the poll site loads nothing to encode them. */
template <typename T>
struct XAddr {
    static uint64_t put(const T& v) noexcept { return reinterpret_cast<uintptr_t>(&v); }
    static T get(uint64_t s) { return *reinterpret_cast<const T*>(static_cast<uintptr_t>(s)); }
};
template <typename T>
struct XAddr<T&> : XArg<T&> {};

template <typename T>
inline uint64_t xret_addr(T* p) noexcept { return reinterpret_cast<uintptr_t>(p); }
inline uint64_t xret_addr(int) noexcept { return 0; }

}  // namespace dbg
}  // namespace strucpp

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
