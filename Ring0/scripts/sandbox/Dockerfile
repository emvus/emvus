# Minimal image for the Ring0 and Sublang sandbox scripts (tag: emerald-selfhost-sandbox).
# The Emerald compiler is linked against libLLVM.so.22.1 and calls clang, so both come from the
# LLVM 22 packages; the scripts mount the Emerald kit, Ring0 and Sublang read-only at run time.
# Build: scripts/sandbox/build.sh
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed llvm22-libs clang22 gcc binutils bash coreutils diffutils findutils \
    && pacman -Scc --noconfirm \
    && ln -sf libLLVM.so.22.1 /usr/lib/libLLVM.so \
    && ln -sf /usr/lib/llvm22/bin/clang /usr/local/bin/clang \
    && ln -sf /usr/lib/llvm22/bin/clang /usr/local/bin/cc
