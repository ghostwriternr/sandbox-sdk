# Use the sandbox base image
FROM cloudflare/sandbox-test:0.2.4

# Install additional tools for edge case testing
RUN apt-get update && apt-get install -y \
    # For UUID generation in marker collision tests
    uuid-runtime \
    # Process tools (ps, etc)
    procps \
    && rm -rf /var/lib/apt/lists/*

# Add a label to force rebuild
LABEL build_date="2025-01-12"

# Expose ports (required for local dev)
EXPOSE 3000
EXPOSE 8888