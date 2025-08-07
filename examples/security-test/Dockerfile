# Use the sandbox base image
FROM docker.io/cloudflare/sandbox:0.2.3

# Install additional tools for testing
RUN apt-get update && apt-get install -y \
    libcap2-bin \
    strace \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Add a label to force rebuild
LABEL build_date="2025-01-07-v2"

# Expose ports (required for local dev)
EXPOSE 3000