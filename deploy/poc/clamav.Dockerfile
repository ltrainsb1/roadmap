# Build context: deploy/poc. The upstream Debian image (it has linux/arm64, the server is ARM), pinned by the digest of
# its multi-arch index. The only change is the package upgrade below: libxml2 is already at the fixed version in this
# base (kept so a later base with the old one is upgraded too), and libzstd1 has a fixed HIGH finding in it
# (CVE-2026-124851). Drop a package from the list when the base catches up. To move to a newer ClamAV, change the tag
# and the digest together.
FROM clamav/clamav-debian:1.4.7@sha256:fce5b25d322736e707fcee5bcdeb0a2ea8c2994c28d3b24b10b516bf21846ede
RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade libxml2 libzstd1 \
    && rm -rf /var/lib/apt/lists/*
