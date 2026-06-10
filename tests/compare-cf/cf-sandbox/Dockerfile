# Container image for engram-compare-cfsandbox.
#
# @cloudflare/sandbox ships a base image that already contains the sandbox runtime
# (code-interpreter kernel, exec server). The simplest correct image FROMs that base.
# Pin the tag to the @cloudflare/sandbox version in package.json.
#
# NOTE: the exact base image reference is published by the SDK; check the @cloudflare/sandbox
# release notes / docs for the current `docker.io/cloudflare/sandbox:<version>` tag and
# update the line below to match the installed SDK version.
FROM docker.io/cloudflare/sandbox:0.4.18

# (Optional) add extra tools your probes need inside the container, e.g. python:
# RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*

# The base image already defines the entrypoint that serves the sandbox protocol.
