# Makefile — XRPL Hooks Builder
#
# Prerequisites
# ─────────────
# The XRPL Hooks Builder SDK must be installed.  It ships a patched LLVM/clang
# that targets wasm32-unknown-unknown and provides hookapi.h / hookmacro.h.
#
# Default SDK location: /usr/local/hooks-builder
# Override:   make HOOKS_SDK=/path/to/sdk
#
# Build
# ─────
#   make              → compiles both hooks to .wasm
#   make clean        → removes generated artefacts
#   make check-sdk    → verifies the SDK is reachable
#
# Output
# ──────
#   compliance_hook.wasm   — install on the company account  (SetHook)
#   registry_hook.wasm     — install on the regulator account (SetHook)

HOOKS_SDK  ?= /usr/local/hooks-builder
SDK_INCLUDE = $(HOOKS_SDK)/include

# Compiler: the Hooks Builder provides its own clang binary.
# Fall back to system clang if the SDK binary is absent (for CI linting only).
HOOKS_CLANG = $(HOOKS_SDK)/bin/clang
ifeq ($(wildcard $(HOOKS_CLANG)),)
  HOOKS_CLANG = clang
endif

CC = $(HOOKS_CLANG)

# ─── Compiler flags ────────────────────────────────────────────────────────
# --target          wasm32-unknown-unknown: no OS, no POSIX, no libc
# -nostdlib         do not link the C standard library
# -Wl,--no-entry    no main() entry point (WASM module, not executable)
# -Wl,--export=hook export the hook() function so xahaud can call it
# -Wl,--allow-undefined   Hook API functions are provided by the runtime
# -O3               optimise aggressively (WASM execution budget is tight)
# -Wall -Wextra     catch as many issues as possible at compile time
# -Wno-unused-parameter   hook() receives a reserved parameter we ignore

CFLAGS = \
  --target=wasm32-unknown-unknown \
  -I$(SDK_INCLUDE) \
  -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=hook \
  -Wl,--allow-undefined \
  -O3 \
  -Wall \
  -Wextra \
  -Wno-unused-parameter \
  -DNDEBUG

# ─── Targets ───────────────────────────────────────────────────────────────

.PHONY: all clean check-sdk

all: compliance_hook.wasm registry_hook.wasm

compliance_hook.wasm: compliance_hook.c
	$(CC) $(CFLAGS) -o $@ $<
	@echo "Built: $@ ($$(wc -c < $@) bytes)"

registry_hook.wasm: registry_hook.c
	$(CC) $(CFLAGS) -o $@ $<
	@echo "Built: $@ ($$(wc -c < $@) bytes)"

clean:
	rm -f compliance_hook.wasm registry_hook.wasm

check-sdk:
	@test -f $(SDK_INCLUDE)/hookapi.h || \
	  { echo "ERROR: hookapi.h not found at $(SDK_INCLUDE)/hookapi.h"; \
	    echo "Install the XRPL Hooks Builder SDK or set HOOKS_SDK=..."; exit 1; }
	@echo "SDK OK: $(SDK_INCLUDE)/hookapi.h found"
	@$(CC) --version | head -1
