/**
 * @file debug_probe_stub.hpp
 * @brief A minimal host for the debug-probe C ABI, for tests and the REPL.
 *
 * Defines the host half of the ABI in debug_probe.hpp (strucpp_dbg_hit and the
 * frame link/unlink), so a probe-built program links and runs without the
 * runtime's debug engine. Include it in exactly ONE translation unit; the
 * generated test and REPL mains do. Not for a probe-off build, which needs none
 * of it.
 *
 * What it does on a hit, in the debug engine's slow-path order: read the flag
 * byte (TRAP, then ARMED), then the shared-global lock depth. Under a lock the
 * hit is counted as skipped and never stops; otherwise it is counted as a stop
 * and the test's stop hook (standing in for the host's `park`) is called.
 *
 * Environment, read once at start-up: STRUCPP_DBG_STUB=attach attaches a
 * session (every POU runs its probed clone); =trap also sets TRAP on every
 * probe (every probe takes the slow path). Either prints
 * "strucpp-dbg-stub: <mode> stops=<n>" at exit.
 *
 * See also:
 *   src/runtime/include/debug_probe.hpp - the probe, poll and frame shapes and the ABI.
 *   src/runtime/include/iec_global.hpp - where the lock depth is counted.
 *   tests/integration/debug-probes.test.ts - transfer and lock-site tests built on this stub.
 */
#ifndef STRUCPP_DEBUG_PROBE_STUB_HPP
#define STRUCPP_DEBUG_PROBE_STUB_HPP

#include "debug_probe.hpp"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>

namespace strucpp {
namespace dbg {
namespace stub {

using StopHook = void (*)(uint32_t probe, const strucpp_dbg_frame* innermost);

struct State {
    std::once_flag once;
    std::unique_ptr<std::atomic<uint32_t>[]> stops;
    std::unique_ptr<std::atomic<uint32_t>[]> skips;
    uint32_t count = 0;
    std::atomic<StopHook> on_stop{nullptr};
    std::atomic<uint32_t> gen{0};
    const char* env_mode = nullptr;
};

static State& state() {
    static State s;
    std::call_once(s.once, [] {
        s.count = strucpp_dbg_probe_count();
        const uint32_t n = s.count > 0 ? s.count : 1;
        s.stops.reset(new std::atomic<uint32_t>[n]);
        s.skips.reset(new std::atomic<uint32_t>[n]);
        for (uint32_t i = 0; i < n; ++i) {
            s.stops[i] = 0;
            s.skips[i] = 0;
        }
    });
    return s;
}

static thread_local strucpp_dbg_frame* chain_head = nullptr;

inline void attach() {
    state().gen.fetch_add(1);
    __atomic_store_n(&strucpp_dbg_active, static_cast<uint8_t>(STRUCPP_DBG_ACTIVE), __ATOMIC_SEQ_CST);
}
inline void detach() { __atomic_store_n(&strucpp_dbg_active, static_cast<uint8_t>(0), __ATOMIC_SEQ_CST); }

inline void set_bits(uint32_t probe, uint8_t bits, bool on) {
    if (probe >= state().count) return;
    volatile uint8_t* f = &strucpp_dbg_flags[probe];
    const uint8_t v = __atomic_load_n(f, __ATOMIC_RELAXED);
    __atomic_store_n(f, static_cast<uint8_t>(on ? (v | bits) : (v & ~bits)), __ATOMIC_SEQ_CST);
}
inline void arm(uint32_t probe) { set_bits(probe, STRUCPP_DBG_ARMED, true); }
inline void disarm(uint32_t probe) { set_bits(probe, STRUCPP_DBG_ARMED, false); }
inline void trap_all(bool on) {
    for (uint32_t i = 0; i < state().count; ++i) set_bits(i, STRUCPP_DBG_TRAP, on);
}

/** Stopping hits (lock depth 0) and skipped hits (under a shared-global lock). */
inline uint32_t stops(uint32_t probe) { return probe < state().count ? state().stops[probe].load() : 0; }
inline uint32_t skips(uint32_t probe) { return probe < state().count ? state().skips[probe].load() : 0; }
inline uint32_t total_stops() {
    uint32_t t = 0;
    for (uint32_t i = 0; i < state().count; ++i) t += state().stops[i].load();
    return t;
}

/** Called on every stopping hit, on the hitting thread; may block (a park). */
inline void set_on_stop(StopHook hook) { state().on_stop.store(hook); }

/** Innermost linked frame of the calling thread. */
inline const strucpp_dbg_frame* innermost() { return chain_head; }

static void report_at_exit() {
    std::printf("strucpp-dbg-stub: %s stops=%u\n", state().env_mode, total_stops());
    std::fflush(stdout);
}

/** STRUCPP_DBG_STUB=attach|trap, applied before main. */
__attribute__((unused)) static const int env_init = [] {
    const char* mode = std::getenv("STRUCPP_DBG_STUB");
    if (!mode) return 0;
    state().env_mode = mode;
    attach();
    if (std::strcmp(mode, "trap") == 0) trap_all(true);
    std::atexit(report_at_exit);
    return 1;
}();

}  // namespace stub
}  // namespace dbg
}  // namespace strucpp

extern "C" void strucpp_dbg_hit(uint32_t probe) {
    using namespace strucpp::dbg::stub;
    State& s = state();
    if (probe >= s.count) return;
    const uint8_t f = __atomic_load_n(&strucpp_dbg_flags[probe], __ATOMIC_ACQUIRE);
    if ((f & (STRUCPP_DBG_TRAP | STRUCPP_DBG_ARMED)) == 0) return;
    if (strucpp_dbg_lock_depth() > 0) {
        s.skips[probe].fetch_add(1);
        return;
    }
    s.stops[probe].fetch_add(1);
    StopHook hook = s.on_stop.load();
    if (hook) hook(probe, chain_head);
}

extern "C" void strucpp_dbg_frame_link(strucpp_dbg_frame* frame) {
    frame->prev = strucpp::dbg::stub::chain_head;
    frame->gen = strucpp::dbg::stub::state().gen.load();
    frame->linked = 1;
    strucpp::dbg::stub::chain_head = frame;
}

extern "C" void strucpp_dbg_frame_unlink(strucpp_dbg_frame* frame) {
    strucpp::dbg::stub::chain_head = frame->prev;
}

#endif  // STRUCPP_DEBUG_PROBE_STUB_HPP
