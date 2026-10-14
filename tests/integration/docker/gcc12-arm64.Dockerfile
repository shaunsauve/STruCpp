# The openplc-runtime toolchain (debian:bookworm-slim, GCC 12, linux/arm64), pinned
# by digest, plus binutils for objdump. Used by the frame check in debug-probes.test.ts.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ make binutils python3 \
 && rm -rf /var/lib/apt/lists/*
