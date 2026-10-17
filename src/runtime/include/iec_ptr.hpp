// SPDX-License-Identifier: GPL-3.0-or-later WITH STruCpp-runtime-exception
// Copyright (C) 2025 Autonomy / OpenPLC Project
// This file is part of the STruC++ Runtime Library and is covered by the
// STruC++ Runtime Library Exception. See COPYING.RUNTIME for details.
/**
 * STruC++ Runtime - IEC Pointer Type
 *
 * Provides IEC_Ptr<T>, a smart pointer wrapper that handles the type-punning
 * semantics of IEC 61131-3 POINTER TO. In CODESYS, POINTER TO BYTE is commonly
 * used as a universal memory pointer (like void*) and ADR() can return any
 * address that is freely assigned to any pointer type.
 *
 * IEC_Ptr<T> stores a void* internally and provides:
 * - Construction/assignment from any pointer type (cross-type OK)
 * - Construction/assignment from other IEC_Ptr<U> (cross-type OK)
 * - Dereference as T& / T*
 * - Pointer arithmetic in units of sizeof(T)
 * - Conversion to integral types (for CODESYS-style address math)
 * - Comparison operators (same-type and cross-type)
 */

#pragma once

#include <cstdint>
#include <cstddef>
#include <type_traits>

#include "iec_fault.hpp"   // STRUCPP_HAS_EXCEPTIONS, IecFault, iec_runtime_fault
#if STRUCPP_HAS_EXCEPTIONS
#include <stdexcept>
#endif

namespace strucpp {

// Forward declare IECVar for arithmetic overloads
template<typename T> class IECVar;

template<typename T>
class IEC_Ptr {
    void* ptr_;
public:
    using element_type = T;

    // Constructors
    IEC_Ptr() noexcept : ptr_(nullptr) {}
    IEC_Ptr(std::nullptr_t) noexcept : ptr_(nullptr) {}

    // Construct from any raw pointer
    template<typename U>
    IEC_Ptr(U* p) noexcept : ptr_(const_cast<void*>(static_cast<const volatile void*>(p))) {}

    // Construct from another IEC_Ptr (cross-type)
    template<typename U>
    IEC_Ptr(IEC_Ptr<U> other) noexcept : ptr_(other.get_void()) {}

    // Construct from an integer address (e.g. __XWORD/ULINT from ADR()).
    // `IEC_XWORD` implicitly converts to its underlying integer, which
    // converts to uintptr_t here — the typed pointer round-trips the address.
    explicit IEC_Ptr(std::uintptr_t addr) noexcept
        : ptr_(reinterpret_cast<void*>(addr)) {}

    // Assignment from any raw pointer
    template<typename U>
    IEC_Ptr& operator=(U* p) noexcept {
        ptr_ = const_cast<void*>(static_cast<const volatile void*>(p));
        return *this;
    }

    // Assignment from another IEC_Ptr (cross-type)
    template<typename U>
    IEC_Ptr& operator=(IEC_Ptr<U> other) noexcept {
        ptr_ = other.get_void();
        return *this;
    }

    IEC_Ptr& operator=(std::nullptr_t) noexcept {
        ptr_ = nullptr;
        return *this;
    }

    // Assignment from an integer address (e.g. `ptr := _TMP` where the temp is
    // __XWORD/ULINT from ADR()). The address is reinterpreted to the typed
    // pointer; the source integer carries a pointer-width value.
    IEC_Ptr& operator=(std::uintptr_t addr) noexcept {
        ptr_ = reinterpret_cast<void*>(addr);
        return *this;
    }

    // Null-fault helper: a dereference of an unassigned (NULL) POINTER TO
    // raises a clean fault instead of an undefined access — throw on exception
    // targets (the runtime catches it and stops just the faulting task), or
    // iec_runtime_fault(IecFault::NullReference) on -fno-exceptions MCU targets
    // (where there is no MMU to trap a null deref, so the unchecked access would
    // silently read/write address 0). Mirrors REF_TO's NullReferenceException.
    void __fault_if_null() const {
        if (!ptr_) {
#if STRUCPP_HAS_EXCEPTIONS
            throw std::runtime_error("Null pointer dereference");
#else
            iec_runtime_fault(IecFault::NullReference);
#endif
        }
    }

    // Dereference (null-checked)
    T& operator*() const { __fault_if_null(); return *static_cast<T*>(ptr_); }
    T* operator->() const { __fault_if_null(); return static_cast<T*>(ptr_); }

    // Subscript (pointer[n]) — null-checked base (the offset itself is
    // unbounded raw pointer arithmetic, as in C).
    T& operator[](std::ptrdiff_t n) const {
        __fault_if_null();
        return *(static_cast<T*>(ptr_) + n);
    }

    // Bounds-checked accessor used by codegen's subscript path. A POINTER TO has
    // no bounds metadata, so this matches operator[]: null-checked base with
    // unbounded raw pointer arithmetic (as in C).
    T& at(std::ptrdiff_t n) const {
        __fault_if_null();
        return *(static_cast<T*>(ptr_) + n);
    }

    // Raw access
    T* get() const noexcept { return static_cast<T*>(ptr_); }
    void* get_void() const noexcept { return ptr_; }

    // Pointer arithmetic (in units of sizeof(T))
    // Use templates to directly match any arithmetic type, avoiding
    // ambiguity with the integral conversion operator.
    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr operator+(N n) const noexcept {
        return IEC_Ptr(static_cast<T*>(ptr_) + static_cast<std::ptrdiff_t>(n));
    }

    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr operator-(N n) const noexcept {
        return IEC_Ptr(static_cast<T*>(ptr_) - static_cast<std::ptrdiff_t>(n));
    }

    // Arithmetic with IECVar-wrapped types (unwrap the value)
    template<typename U>
    IEC_Ptr operator+(const IECVar<U>& n) const noexcept {
        return IEC_Ptr(static_cast<T*>(ptr_) + static_cast<std::ptrdiff_t>(n.get()));
    }

    template<typename U>
    IEC_Ptr operator-(const IECVar<U>& n) const noexcept {
        return IEC_Ptr(static_cast<T*>(ptr_) - static_cast<std::ptrdiff_t>(n.get()));
    }

    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr& operator+=(N n) noexcept {
        ptr_ = static_cast<T*>(ptr_) + static_cast<std::ptrdiff_t>(n);
        return *this;
    }

    template<typename N, std::enable_if_t<std::is_arithmetic<N>::value, int> = 0>
    IEC_Ptr& operator-=(N n) noexcept {
        ptr_ = static_cast<T*>(ptr_) - static_cast<std::ptrdiff_t>(n);
        return *this;
    }

    // Pre/post increment/decrement
    IEC_Ptr& operator++() noexcept {
        ptr_ = static_cast<T*>(ptr_) + 1;
        return *this;
    }

    IEC_Ptr operator++(int) noexcept {
        IEC_Ptr tmp = *this;
        ptr_ = static_cast<T*>(ptr_) + 1;
        return tmp;
    }

    IEC_Ptr& operator--() noexcept {
        ptr_ = static_cast<T*>(ptr_) - 1;
        return *this;
    }

    IEC_Ptr operator--(int) noexcept {
        IEC_Ptr tmp = *this;
        ptr_ = static_cast<T*>(ptr_) - 1;
        return tmp;
    }

    // Conversion to integral types (for CODESYS pointer-to-DWORD patterns)
    // This enables: DWORD_VAR := PT; (store address as integer)
    // Must NOT be implicit to avoid ambiguity with operator+ etc.
    // Use to_addr() for explicit conversion instead.
    uintptr_t to_addr() const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_);
    }

    // Conversion to bool (for null checks)
    explicit operator bool() const noexcept { return ptr_ != nullptr; }

    // Same-type comparison
    bool operator==(IEC_Ptr other) const noexcept { return ptr_ == other.ptr_; }
    bool operator!=(IEC_Ptr other) const noexcept { return ptr_ != other.ptr_; }
    bool operator<(IEC_Ptr other) const noexcept { return ptr_ < other.ptr_; }
    bool operator>(IEC_Ptr other) const noexcept { return ptr_ > other.ptr_; }
    bool operator<=(IEC_Ptr other) const noexcept { return ptr_ <= other.ptr_; }
    bool operator>=(IEC_Ptr other) const noexcept { return ptr_ >= other.ptr_; }

    // Cross-type IEC_Ptr comparison
    template<typename U>
    bool operator==(IEC_Ptr<U> other) const noexcept { return ptr_ == other.get_void(); }
    template<typename U>
    bool operator!=(IEC_Ptr<U> other) const noexcept { return ptr_ != other.get_void(); }
    template<typename U>
    bool operator<(IEC_Ptr<U> other) const noexcept { return ptr_ < other.get_void(); }
    template<typename U>
    bool operator>(IEC_Ptr<U> other) const noexcept { return ptr_ > other.get_void(); }
    template<typename U>
    bool operator<=(IEC_Ptr<U> other) const noexcept { return ptr_ <= other.get_void(); }
    template<typename U>
    bool operator>=(IEC_Ptr<U> other) const noexcept { return ptr_ >= other.get_void(); }

    // Address-bit XOR on a POINTER TO: `p := p XOR 16#7FFF000000000000`.
    //
    // The typed-pointer spelling of iec_addr_xor below. It IS expressible as an
    // operator here because the left operand is an IEC_Ptr, i.e. a class object,
    // so member lookup reaches it; the bare-pointer spelling that codegen emits
    // for ADR() could not be. Keeping both means a pointer XOR reads the same
    // whichever spelling produced the pointer.
    IEC_Ptr operator^(std::uintptr_t mask) const noexcept {
        return IEC_Ptr(reinterpret_cast<std::uintptr_t>(ptr_) ^ mask);
    }

    // Comparison with nullptr
    bool operator==(std::nullptr_t) const noexcept { return ptr_ == nullptr; }
    bool operator!=(std::nullptr_t) const noexcept { return ptr_ != nullptr; }

    // Comparison with IECVar<integer> (for CODESYS: PT < DWORD_END)
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator<(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) < static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator>(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) > static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator<=(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) <= static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator>=(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) >= static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator==(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) == static_cast<uintptr_t>(other.get());
    }
    template<typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
    bool operator!=(IECVar<U> other) const noexcept {
        return reinterpret_cast<uintptr_t>(ptr_) != static_cast<uintptr_t>(other.get());
    }
};

// Reverse comparison: nullptr == IEC_Ptr
template<typename T>
bool operator==(std::nullptr_t, IEC_Ptr<T> p) noexcept { return p == nullptr; }
template<typename T>
bool operator!=(std::nullptr_t, IEC_Ptr<T> p) noexcept { return p != nullptr; }

// Arithmetic: n + ptr (reverse order)
template<typename T>
IEC_Ptr<T> operator+(std::ptrdiff_t n, IEC_Ptr<T> p) noexcept { return p + n; }

/**
 * Address-bit XOR on a pointer: `p := ADR(v) XOR 16#7FFF000000000000`.
 *
 * CODESYS-style address math, and the only way ST can name an address that is
 * guaranteed not to be the one it started from — which is how a fault-injection
 * corpus builds a deliberately-dangling POINTER TO. The result is the same typed
 * pointer with those address bits flipped, so `p^` still reads it as a T.
 *
 * This is a FUNCTION, and the spelling matters: `(&v) ^ mask` cannot be made to
 * compile by any operator this runtime could define. C++ applies member-operator
 * lookup only to a left operand that IS a class object, never through a pointer
 * to one, so no member of the pointee is reachable from `(&v)`; and a free
 * `operator^(T*, M)` is ill-formed outright, because [over.oper] requires every
 * overloaded operator function to take at least one parameter of class or
 * enumeration type, and both of those operands are a pointer and an integer.
 * A function template is unconstrained that way, so codegen emits this call.
 *
 * Templated over T so it covers every variable the runtime hands out — each
 * IECVar<T> scalar, a STRING or WSTRING var, an array, a struct, an FB — rather
 * than only the type it was first reported against.
 *
 * The mask has TWO spellings, because ST has two. A literal mask arrives as a
 * raw integer; an ST *variable* mask arrives as an `IECVar<U>`, which is a class
 * type and so never satisfies `std::is_integral<M>` however integral `U` is —
 * template argument deduction does not consider a user-defined conversion, and
 * IECVar's is one. Without the overload below, `ADR(v) XOR m` compiled for every
 * literal mask and for no variable mask at all, which is the same half-fix in a
 * different place: the pointee family was swept, the mask family assumed. Both
 * overloads are constrained to an integral type, which leaves the built-in `^`
 * on IEC values resolving exactly as before (see iec_var.hpp) and keeps
 * `p ^ q` on two pointers an error rather than silently promoting one. A BOOL
 * mask is accepted, because BOOL is integral and means exactly what it says —
 * the low address bit — the same as the literal `16#1`.
 *
 * NOT handled, and named here rather than silently absorbed elsewhere:
 *
 *  - A non-integral mask (`ADR(v) XOR r` with `r` a REAL). Address bits are not
 *    a real number and folding one in would mean inventing a rounding rule. The
 *    analyzer accepts that ST, so it reaches g++ and is rejected there.
 *  - `m XOR ADR(v)`, mask on the LEFT. That is not this operation at all: it
 *    xors the value of `m` with the address value of `v`, a number rather than a
 *    pointer, so it is left as the value XOR the analyzer says it is (and, like
 *    the naive `(&v) ^ mask`, it does not reach compilable C++ — the same
 *    [over.oper] rule above applies in reverse).
 *  - A `POINTER TO STRING/WSTRING/TIME/DATE` destination. The operator covers
 *    those pointees — proven at the operator level in
 *    tests/integration/pointer-xor-wstring-compare-cpp.test.ts — but the
 *    analyzer refuses to assign into such a pointer at all, a bare
 *    `px := ADR(x)` included, so the ST never reaches this function. That is the
 *    analyzer's POINTER typing, not this signature: it resolves the variable to
 *    the *pointee's* type name, so a `POINTER TO DINT` is checked as a plain
 *    DINT and a `POINTER TO STRING` as a placeholder that nothing widens into.
 *    Changing that is a language-semantics decision, not a header fix.
 */
template<typename T, typename M, std::enable_if_t<std::is_integral<M>::value, int> = 0>
T* iec_addr_xor(T* p, M mask) noexcept {
    return reinterpret_cast<T*>(reinterpret_cast<std::uintptr_t>(p) ^ static_cast<std::uintptr_t>(mask));
}

/**
 * The mask spelling ST actually produces for a variable: an IECVar, unwrapped.
 *
 * Unwraps rather than letting IECVar's implicit `operator T()` do it, for the
 * same reason the pointer comparison operators above take an `IECVar<U>`
 * parameter and call `.get()` (line 236ff): the conversion is not available to
 * template argument deduction, so the parameter has to name the wrapper. It also
 * keeps forcing semantics in one place — `get()` honours a forced value, which is
 * what a debugger-forced mask should XOR in.
 */
template<typename T, typename U, std::enable_if_t<std::is_integral<U>::value, int> = 0>
T* iec_addr_xor(T* p, const IECVar<U>& mask) noexcept {
    return iec_addr_xor(p, static_cast<std::uintptr_t>(mask.get()));
}

} // namespace strucpp
