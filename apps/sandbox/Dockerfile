# engram-sandbox container image.
#
# MUST extend the official Cloudflare Sandbox base image whose tag MATCHES the
# @cloudflare/sandbox npm version in package.json (the SDK checks at runtime; a
# mismatch surfaces as log warnings or 501 exec errors).
#
# Variants: ":<v>" (JS/TS), ":<v>-python" (Python 3.11 + data-science), ":<v>-opencode".
# Keep the base ENTRYPOINT (the sandbox binary starts the HTTP API server and spawns CMD as
# a child with signal forwarding) — DO NOT override ENTRYPOINT.
#
# The base image seeds /workspace and uses it as WORKDIR. We deliberately DO NOT mount R2
# over /workspace (would shadow seeded files); mountBucket targets /session instead and the
# session dir is symlinked/treated as the live workspace (see src/index.ts).
FROM docker.io/cloudflare/sandbox:0.12.1

# s3fs-fuse is what powers mountBucket(); the base image ships it, but install defensively.
# (Comment out if your base variant already includes it.)
# RUN apt-get update && apt-get install -y --no-install-recommends s3fs && rm -rf /var/lib/apt/lists/*

# NOTE: do NOT pre-create /session here. s3fs refuses to mount over a non-empty mountpoint
# ("MOUNTPOINT directory /session is not empty"); the SDK's mountBucket() creates the empty
# mountpoint itself. We additionally pass the s3fs `nonempty` option from src/index.ts so a
# stale/dirty mountpoint after a sleep/cold-restart does not wedge the remount.

# No ENTRYPOINT override. Provide only a CMD (the base default is fine for an API-driven
# sandbox; this keeps the container alive for exec/files/git over the SDK).
